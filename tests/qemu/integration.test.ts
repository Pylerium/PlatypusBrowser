import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { HardwareProfileManager, MemoryKeyring, ProfileError } from "@adios/hwid-profile-manager";
import { WorkspaceController } from "../../src/main/qemu/controller";
import { buildQemuArguments } from "../../src/main/qemu/arguments";
import { validateQemuConfig } from "../../src/main/qemu/config";
import type { LaunchProcess } from "../../src/main/qemu/process";
import type { BrowserProfile, WorkspaceStatus } from "../../src/shared/types";

const browser: BrowserProfile = { id: "08b51da8-4022-41ee-bd3b-df21a1432089", name: "Test", startUrl: "https://example.com", proxy: null,
  createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" };
const digest = (id: string) => createHash("sha256").update(id).digest("hex");

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "platypus-qemu-test-"));
  const keys = new MemoryKeyring("test", { test: Buffer.alloc(32, 55) });
  const adios = new HardwareProfileManager({ directory: join(root, "vault"), keys, lockTimeoutMs: 100 });
  const image = join(root, "base, disk.raw"); await writeFile(image, "trusted base image");
  const config = validateQemuConfig({ qemuPath: join(root, "qemu"), qemuImgPath: join(root, "img"), baseImages: [{ path: image, format: "raw" }],
    display: "none", shutdownTimeoutMs: 100 });
  const statuses: WorkspaceStatus[] = [];
  const spawns: { executable: string; args: readonly string[] }[] = [];
  let mode = "";
  const launch: LaunchProcess = (executable, args) => {
    spawns.push({ executable, args });
    return spawn(process.execPath, [resolve("tests/qemu/fake-qemu.cjs"), executable === config.qemuImgPath ? "img" : "vm", ...args], {
      windowsHide: true, env: { ...process.env, FAKE_MODE: mode }, stdio: ["pipe", "pipe", "pipe"],
    });
  };
  const options = { adios, overlayDirectory: join(root, "overlays"), config: async () => config, status: (status: WorkspaceStatus) => { statuses.push(status); }, launch };
  const controller = new WorkspaceController(options);
  t.after(async () => {
    await controller.closeAll(); keys.destroy();
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
    await rm(root, { recursive: true, force: true });
  });
  return { root, adios, config, image, statuses, spawns, controller, options, mode: (value: string) => { mode = value; },
    overlayPath: join(root, "overlays", digest(browser.id)) };
}

async function until(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for runtime status."); await setTimeout(10); }
}

test("QEMU mapping covers SMBIOS, device serials, MACs, explicit backing nodes, and safe path encoding", async (t) => {
  const f = await fixture(t);
  const profile = await f.adios.create(browser.id, { networkCount: 2 });
  const args = buildQemuArguments(f.config, profile, ["H:/some, disk.qcow2"], "H:/launch, file.json");
  for (const type of ["type=0", "type=1", "type=2"]) assert.equal(args.some((arg) => arg.startsWith(type)), true);
  assert.equal(args.some((arg) => arg.includes(`serial=${profile.hardware.smbios.serialNumber}`)), true);
  assert.equal(args.some((arg) => arg.includes(`serial=${profile.hardware.storage[0]!.volumeSerial}`)), true);
  for (const nic of profile.hardware.network) assert.equal(args.some((arg) => arg.includes(`mac=${nic.macAddress}`)), true);
  const blocks = args.flatMap((arg, index) => arg === "-blockdev" ? [JSON.parse(args[index + 1]!)] : []);
  assert.equal(blocks[0]["read-only"], true);
  assert.equal(blocks[2].filename, "H:/some, disk.qcow2");
  assert.equal(blocks[3].backing, "base0");
  assert.equal(args.includes("name=opt/org.platypus/workspace,file=H:/launch,, file.json"), true);
  assert.equal(args.includes("-S"), true);
  assert.equal(args.includes("tcg"), false);
  assert.equal(args.some((arg) => arg.includes("restrict=on")), true);
  const proxied = buildQemuArguments({ ...f.config, network: "user" }, profile, ["overlay.qcow2"], "launch.json", "stdio", 32123);
  const networks = proxied.flatMap((arg, i) => arg === "-netdev" ? [proxied[i + 1]!] : []);
  assert.ok(networks.every((arg) => arg.includes("restrict=on")));
  assert.equal(networks.filter((arg) => arg.includes("guestfwd=tcp:10.0.2.100:1080-tcp:127.0.0.1:32123")).length, 1);
});

test("launch, cross-process lease, QMP running state, close, persistent relaunch, and purge", async (t) => {
  const f = await fixture(t);
  await f.controller.launch(browser);
  const launch = JSON.parse(await readFile(join(f.overlayPath, "launch.json"), "utf8"));
  const current = f.controller.statuses()[0]!;
  assert.equal(current.state, "running"); assert.equal(current.processRunning, true);
  await assert.rejects(f.adios.load(browser.id), (error: unknown) => error instanceof ProfileError && error.code === "LOCK_TIMEOUT");
  const competing = new WorkspaceController(f.options);
  await assert.rejects(competing.launch(browser), /locked/i);
  await assert.rejects(f.controller.launch(browser), /already/);
  await assert.rejects(f.controller.purge(browser.id, async () => undefined), /Close/);
  assert.match(f.controller.logs(browser.id).stderr, /diagnostic/);
  await f.controller.close(browser.id);
  assert.equal(f.controller.statuses()[0]!.state, "terminated");
  assert.equal(f.controller.statuses()[0]!.processRunning, false);
  const first = await f.adios.load(browser.id);
  await assert.rejects(lstat(join(f.overlayPath, "launch.json")), { code: "ENOENT" });
  const originalOverlay = await readFile(join(f.overlayPath, "disk-0.qcow2"));
  await f.controller.launch(browser); await f.controller.close(browser.id);
  assert.deepEqual(await f.adios.load(browser.id), first);
  assert.deepEqual(await readFile(join(f.overlayPath, "disk-0.qcow2")), originalOverlay);
  assert.equal(launch.workspaceId, browser.id); assert.equal(launch.hardware.systemUuid, first.hardware.systemUuid);
  let finished = false;
  await f.controller.purge(browser.id, async () => { finished = true; });
  assert.equal(finished, true);
  await assert.rejects(lstat(f.overlayPath), { code: "ENOENT" });
  await assert.rejects(f.adios.load(browser.id), (error: unknown) => error instanceof ProfileError && error.code === "NOT_FOUND");
  assert.equal(await readFile(f.image, "utf8"), "trusted base image");
});

test("unexpected QEMU exit reports Error, drains logs, and releases its workspace lock", async (t) => {
  const f = await fixture(t); f.mode("crash");
  await f.controller.launch(browser);
  await until(() => !f.controller.has(browser.id));
  assert.equal(f.controller.statuses()[0]!.state, "error");
  assert.equal(f.controller.statuses()[0]!.processRunning, false);
  assert.match(f.controller.statuses()[0]!.message!, /7/);
  assert.equal((await f.adios.load(browser.id)).workspaceId, browser.id);
});

test("normal guest exit reports Terminated without mistaking pipe EOF for a control failure", async (t) => {
  const f = await fixture(t); f.mode("guest-exit");
  await f.controller.launch(browser);
  await until(() => !f.controller.has(browser.id));
  assert.equal(f.controller.statuses()[0]!.state, "terminated");
  assert.equal(f.controller.statuses()[0]!.processRunning, false);
});

test("a broken control stream terminates QEMU before releasing the lease", async (t) => {
  const f = await fixture(t); f.mode("disconnect");
  await f.controller.launch(browser);
  await until(() => !f.controller.has(browser.id));
  assert.equal(f.controller.statuses()[0]!.state, "error");
  assert.equal((await f.adios.load(browser.id)).workspaceId, browser.id);
});

test("QMP monitoring detects an unresponsive control channel and releases the lease only after exit", async (t) => {
  const f = await fixture(t); f.mode("unresponsive-control");
  await f.controller.launch(browser);
  await until(() => !f.controller.has(browser.id), 12000);
  assert.equal(f.controller.statuses()[0]!.state, "error");
  assert.equal(f.controller.statuses()[0]!.processRunning, false);
  assert.equal((await f.adios.load(browser.id)).workspaceId, browser.id);
});

test("shutdown escalates to QMP quit when guest ignores powerdown", async (t) => {
  const f = await fixture(t); f.mode("ignore-powerdown");
  await f.controller.launch(browser); await f.controller.close(browser.id);
  assert.equal(f.controller.statuses()[0]!.state, "terminated");
  assert.equal((await f.adios.load(browser.id)).workspaceId, browser.id);
});

test("shutdown escalates to process termination when all QMP shutdown commands are ignored", async (t) => {
  const f = await fixture(t); f.mode("ignore-all");
  await f.controller.launch(browser); await f.controller.close(browser.id);
  assert.equal(f.controller.has(browser.id), false);
  assert.equal(f.controller.statuses()[0]!.state, "terminated");
});

test("boot protocol failure is reported and the process is reaped before releasing the lease", async (t) => {
  const f = await fixture(t); f.mode("malformed");
  await assert.rejects(f.controller.launch(browser), /QMP/);
  await until(() => !f.controller.has(browser.id));
  assert.equal(f.controller.statuses()[0]!.state, "error");
  assert.equal(f.controller.statuses()[0]!.processRunning, false);
  assert.equal((await f.adios.load(browser.id)).workspaceId, browser.id);
});

test("startup process crashes include the exit code and release the control listener and lease", async (t) => {
  const f = await fixture(t); f.mode("startup-crash");
  await assert.rejects(f.controller.launch(browser), /startup \(7 \(0x7\)\)/);
  await until(() => !f.controller.has(browser.id));
  assert.equal(f.controller.statuses()[0]!.processRunning, false);
  assert.equal((await f.adios.load(browser.id)).workspaceId, browser.id);
  f.mode("");
  await f.controller.launch(browser);
  await f.controller.close(browser.id);
});

test("changed base images and tampered overlay bindings fail closed", async (t) => {
  const f = await fixture(t);
  await f.controller.launch(browser); await f.controller.close(browser.id);
  const vmCount = f.spawns.filter((spawn) => spawn.executable === f.config.qemuPath).length;
  await writeFile(f.image, "different base bytes");
  await assert.rejects(f.controller.launch(browser), /binding|base image/);
  await until(() => !f.controller.has(browser.id));
  assert.equal(f.spawns.filter((spawn) => spawn.executable === f.config.qemuPath).length, vmCount);
});

test("purge is retryable after a journal finalization failure", async (t) => {
  const f = await fixture(t);
  await f.controller.launch(browser); await f.controller.close(browser.id);
  await assert.rejects(f.controller.purge(browser.id, async () => { throw new Error("journal unavailable"); }), /journal/);
  let completed = false;
  await f.controller.purge(browser.id, async () => { completed = true; });
  assert.equal(completed, true);
});

test("unknown overlay files prevent purge and preserve the encrypted identity", async (t) => {
  const f = await fixture(t);
  await f.controller.launch(browser); await f.controller.close(browser.id);
  await writeFile(join(f.overlayPath, "unrelated.txt"), "keep");
  await assert.rejects(f.controller.purge(browser.id, async () => undefined), /unknown file/);
  assert.equal((await f.adios.load(browser.id)).workspaceId, browser.id);
  assert.equal(await readFile(join(f.overlayPath, "unrelated.txt"), "utf8"), "keep");
});

test("host browser proxies cannot silently bypass guest network policy", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.controller.launch({ ...browser, proxy: { protocol: "https", host: "localhost", port: 443, hasCredentials: false } }), /guest routing adapter/);
  assert.equal(f.spawns.length, 0);
});

test("configuration rejects native microvm, software fallback, invalid resources, and relative paths", async (t) => {
  const f = await fixture(t);
  for (const change of [{ machine: "microvm" }, { accelerator: "tcg" }, { cpus: 0 }, { memoryMiB: -1 }, { qemuPath: "qemu" }, { network: "bridge" }]) {
    assert.throws(() => validateQemuConfig({ ...f.config, ...change }));
  }
  assert.equal((await readdir(f.root)).includes("base, disk.raw"), true);
});
