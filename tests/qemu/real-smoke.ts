// Actual QEMU smoke test with a temporary blank disk; this does not boot an OS image.
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { HardwareProfileManager, MemoryKeyring } from "@adios/hwid-profile-manager";
import { validateQemuConfig } from "../../src/main/qemu/config";
import { OverlayStore } from "../../src/main/qemu/overlays";
import { buildQemuArguments } from "../../src/main/qemu/arguments";
import { launchProcess } from "../../src/main/qemu/process";
import { QmpClient } from "../../src/main/qemu/qmp";
import { QmpTransport } from "../../src/main/qemu/transport";
import { WorkspaceController } from "../../src/main/qemu/controller";
import type { BrowserProfile } from "../../src/shared/types";

const qemuPath = process.env.QEMU_TEST_BINARY ?? "C:/Program Files/qemu/qemu-system-x86_64.exe";
const qemuImgPath = process.env.QEMU_TEST_IMG ?? "C:/Program Files/qemu/qemu-img.exe";
const root = await mkdtemp(join(tmpdir(), "platypus-real-qemu-"));
const keys = new MemoryKeyring("test", { test: Buffer.alloc(32, 38) });
let child: ReturnType<typeof launchProcess> | undefined;
let qmp: QmpClient | undefined;
let exited: Promise<void> | undefined;
let stderr = "";
let controller: WorkspaceController | undefined;
let control: QmpTransport | undefined;
try {
  const base = join(root, "blank, base.raw");
  const file = await open(base, "wx", 0o600);
  try { await file.truncate(16 * 1024 * 1024); } finally { await file.close(); }
  const config = validateQemuConfig({ qemuPath, qemuImgPath, baseImages: [{ path: base, format: "raw" }], cpus: 1, memoryMiB: 256, display: process.argv.includes("--sdl") ? "sdl" : process.argv.includes("--gtk") ? "gtk" : "none", shutdownTimeoutMs: 100 });
  const adios = new HardwareProfileManager({ directory: join(root, "vault"), keys });
  const overlays = new OverlayStore(join(root, "overlays"), launchProcess);
  const browser: BrowserProfile = { id: "2a6ec154-0ed6-4a36-b261-4a9ae1711179", name: "Temporary smoke test", startUrl: "https://example.com", proxy: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await adios.withExclusiveWorkspace(browser.id, async (workspace) => {
    const profile = await workspace.create();
    const prepared = await overlays.prepare(config, profile, browser);
    control = await QmpTransport.listen(10000);
    const args = buildQemuArguments(config, profile, prepared.overlays, prepared.launchPath, control.address);
    if (process.argv.includes("--emulated")) {
      // Test-only parser/device verification, never a production accelerator fallback.
      args[args.indexOf("-accel") + 1] = "tcg";
    }
    child = launchProcess(config.qemuPath, args);
    exited = new Promise<void>((resolve) => child!.once("close", (code) => { control?.close(new Error(`QEMU exited (${code}).`)); resolve(); }));
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384); });
    qmp = new QmpClient(child, 10000, () => undefined, undefined, await control.connection);
    await qmp.initialize();
    assert.equal(await qmp.command("qom-get", 3000, { path: "/machine/peripheral/blk0", property: "serial" }), profile.hardware.storage[0]!.volumeSerial);
    assert.equal(await qmp.command("qom-get", 3000, { path: "/machine/peripheral/nic0", property: "mac" }), profile.hardware.network[0]!.macAddress);
    await qmp.command("cont");
    assert.equal((await qmp.command("query-status") as { running: boolean }).running, true);
    // SeaBIOS publishes SMBIOS in guest physical memory. Verify the actual board
    // serial/product strings, not just the argument builder's output.
    const dump = join(root, "guest-memory.bin");
    let found = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await setTimeout(200);
      await qmp.command("pmemsave", 3000, { val: 0, size: 2 * 1024 * 1024, filename: dump });
      const memory = await readFile(dump);
      if (memory.includes(Buffer.from(profile.hardware.smbios.serialNumber)) && memory.includes(Buffer.from(profile.hardware.smbios.productName))) { found = true; break; }
    }
    assert.equal(found, true, "SMBIOS fields must be published in guest firmware memory");
    await qmp.command("quit").catch(() => undefined);
    await exited;
    await overlays.purge(browser.id);
    await workspace.purge();
    console.log(`Real QEMU smoke test passed (${process.argv.includes("--emulated") ? "TCG device verification" : config.accelerator}): overlay creation, SMBIOS firmware data, disk serial, MAC, QMP execution, and cleanup.`);
  });
  if (!process.argv.includes("--emulated")) {
    controller = new WorkspaceController({ adios, overlayDirectory: join(root, "overlays"), config: async () => config, status: () => undefined });
    await controller.launch(browser);
    assert.equal(controller.statuses()[0]!.state, "running");
    await controller.close(browser.id);
    assert.equal(controller.statuses()[0]!.state, "terminated");
    await controller.purge(browser.id, async () => undefined);
    console.log("Real QEMU controller smoke test passed: hardware-accelerated launch, confirmed shutdown, vault deletion, and overlay deletion.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  await controller?.closeAll();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  qmp?.close(); control?.close(); keys.destroy();
  assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
