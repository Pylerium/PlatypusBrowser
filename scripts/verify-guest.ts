import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { HardwareProfileManager, MemoryKeyring } from "@adios/hwid-profile-manager";
import { buildQemuArguments } from "../src/main/qemu/arguments";
import { validateQemuConfig } from "../src/main/qemu/config";
import { OverlayStore } from "../src/main/qemu/overlays";
import { launchProcess } from "../src/main/qemu/process";
import { QmpClient } from "../src/main/qemu/qmp";
import { QmpTransport } from "../src/main/qemu/transport";
import { GuestAgent } from "./guest-agent";

const work = resolve("vm-images/build/verification");
await mkdir(work, { recursive: true });
const keys = new MemoryKeyring("qa", { qa: Buffer.alloc(32, 78) });
const adios = new HardwareProfileManager({ directory: join(work, "vault"), keys });
const browser = { id: "3f765bcf-b6ca-45c4-8e14-7f352157a489", name: "Guest verification", startUrl: "http://127.0.0.1:8765/", proxy: null,
  runtime: { hardwareConcurrency: 3, deviceMemory: 2, platform: "QA Linux", canvasSeed: 7 },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const config = validateQemuConfig({ qemuPath: process.env.QEMU_TEST_BINARY ?? "C:/Program Files/qemu/qemu-system-x86_64.exe",
  qemuImgPath: process.env.QEMU_TEST_IMG ?? "C:/Program Files/qemu/qemu-img.exe", baseImages: [{ path: process.argv.includes("--checkpoint") ? resolve("vm-images/build/provisioning.qcow2") : resolve("vm-images/debian-13-browser-v1.qcow2"), format: "qcow2" }],
  display: "gtk", network: "user", memoryMiB: 2048, cpus: 2 });
const overlays = new OverlayStore(join(work, "overlays"), launchProcess);
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

await adios.withExclusiveWorkspace(browser.id, async (workspace) => {
  const profile = await workspace.load().catch(async (error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND") return workspace.create();
    throw error;
  });
  const prepared = await overlays.prepare(config, profile, browser);
  const control = await QmpTransport.listen(30000);
  const args = buildQemuArguments(config, profile, prepared.overlays, prepared.launchPath, control.address);
  if (!process.argv.includes("--display")) args[args.indexOf("-display") + 1] = "none";
  args[args.indexOf("-serial") + 1] = "file:" + join(work, "guest-console.log");
  args.push("-device", "virtio-serial-pci", "-chardev", `socket,id=qga,host=127.0.0.1,port=${port},server=on,wait=off`,
    "-device", "virtserialport,chardev=qga,name=org.qemu.guest_agent.0");
  const child = launchProcess(config.qemuPath, args);
  let closed = false;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384); });
  const exit = new Promise<void>((resolve) => child.once("close", () => { closed = true; control.close(); resolve(); }));
  const connection = await control.connection;
  const qmp = new QmpClient(child, 30000, () => undefined, undefined, connection);
  let agent: GuestAgent | undefined;
  async function execute(path: string, arg: string[]): Promise<string> {
    const result = await agent!.command("guest-exec", { path, arg, "capture-output": true });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = await agent!.command("guest-exec-status", { pid: result.pid });
      if (status.exited) {
        const output = Buffer.from(status["out-data"] ?? "", "base64").toString();
        if (status.exitcode !== 0) throw new Error(Buffer.from(status["err-data"] ?? "", "base64").toString() || output || `Guest command failed: ${path}`);
        return output;
      }
      await setTimeout(200);
    }
    throw new Error("Guest command timed out.");
  }
  try {
    await qmp.initialize(); await qmp.command("cont");
    console.log("Booting sealed Debian image and waiting for the test-only guest agent...");
    const deadline = Date.now() + 240000;
    while (true) {
      if (closed) throw new Error("QEMU exited: " + stderr);
      try { agent ??= await GuestAgent.connect(port); await agent.synchronize(); break; }
      catch (error) { if (Date.now() > deadline) throw error; await setTimeout(1000); }
    }
    console.log("Guest agent ready. Checking workspace identity and Chromium desktop...");
    let state: any;
    while (Date.now() < deadline) {
      try {
        state = JSON.parse(await execute("/usr/bin/python3", ["-c", "import pathlib,json,subprocess; p=pathlib.Path('/run/platypus/workspace.json'); print(json.dumps({'manifest':json.loads(p.read_text()),'machineId':pathlib.Path('/etc/machine-id').read_text().strip(),'diskGuid':subprocess.check_output(['sgdisk','-p','/dev/vda']).decode(),'chromium':subprocess.check_output(['pgrep','-u','workspace','-a','chromium']).decode()}))"]));
        break;
      } catch {
        const state = await execute("/usr/bin/systemctl", ["show", "-p", "ActiveState", "--value", "platypus-prepare.service"]);
        if (state.trim() === "failed") throw new Error(await execute("/usr/bin/journalctl", ["-b", "-u", "platypus-prepare", "--no-pager"]));
        await setTimeout(2000);
      }
    }
    assert.ok(state, "Guest adapter/desktop did not become ready; inspect guest-console.log.");
    assert.equal(state.manifest.workspaceId, browser.id);
    assert.equal(state.machineId, profile.hardware.machineGuid.replaceAll("-", ""));
    assert.ok(state.diskGuid.toLowerCase().includes(profile.hardware.storage[0]!.diskId));
    assert.ok(state.chromium.includes(browser.startUrl));
    assert.ok(!state.chromium.includes("--no-sandbox"));
    let https = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      try { https = (await execute("/usr/bin/python3", ["-c", "import urllib.request;print(urllib.request.urlopen('https://example.com',timeout=15).status)"])).trim(); break; }
      catch (error) { if (attempt === 4) throw error; await setTimeout(2000); }
    }
    assert.equal(https, "200");
    const page = `<!doctype html><title>Platypus workspace ready</title><style>body{font:24px sans-serif;background:#101820;color:#ddd;padding:48px}pre{line-height:1.5}</style><h1>Platypus workspace ready</h1><pre id="qa"></pre><script>const r={cpu:navigator.hardwareConcurrency,memory:navigator.deviceMemory,platform:navigator.platform};document.getElementById('qa').textContent=JSON.stringify(r,null,2);fetch('/report',{method:'POST',body:JSON.stringify(r)});</script>`;
    const service = `from http.server import BaseHTTPRequestHandler,HTTPServer\nfrom pathlib import Path\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(${JSON.stringify(page)}.encode())\n def do_POST(self):\n  Path('/tmp/platypus-browser-report.json').write_bytes(self.rfile.read(int(self.headers.get('Content-Length',0))));self.send_response(204);self.end_headers()\nHTTPServer(('127.0.0.1',8765),Handler).serve_forever()\n`;
    // JSON string literals are compatible with Python string literals for this ASCII script.
    await execute("/usr/bin/python3", ["-c", `import pathlib;pathlib.Path('/tmp/platypus-qa-server.py').write_bytes(bytes.fromhex('${Buffer.from(service).toString("hex")}'))`]);
    await agent.command("guest-exec", { path: "/usr/bin/python3", arg: ["/tmp/platypus-qa-server.py"] });
    await setTimeout(1000);
    await qmp.command("send-key", 3000, { keys: [{ type: "qcode", data: "f5" }] });
    let telemetry;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { telemetry = JSON.parse(await execute("/usr/bin/cat", ["/tmp/platypus-browser-report.json"])); break; }
      catch { await setTimeout(1000); }
    }
    assert.deepEqual(telemetry, { cpu: 3, memory: 2, platform: "QA Linux" });
    await qmp.command("screendump", 5000, { filename: join(work, "desktop.png"), format: "png" });
    await writeFile(join(work, "result.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), workspaceId: browser.id, machineId: state.machineId,
      telemetry, browser: state.chromium.split("\n").find((line: string) => line.includes(browser.startUrl)) }, null, 2));
    console.log("Guest verified: Adios identity, machine ID, unprivileged Chromium, start URL, and navigator simulation.");
    await qmp.command("system_powerdown");
    await Promise.race([exit, setTimeout(30000, undefined, { ref: false }).then(() => { throw new Error("Guest did not shut down cleanly."); })]);
    await overlays.purge(browser.id); await workspace.purge();
  } catch (error) { console.error(stderr); throw error; }
  finally {
    agent?.close();
    if (!closed) { await qmp.command("quit").catch(() => undefined); if (!closed) child.kill("SIGKILL"); await exit; }
    qmp.close();
    control.close();
  }
});
keys.destroy();
