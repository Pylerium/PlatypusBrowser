import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { HardwareProfileManager, MemoryKeyring } from "@adios/hwid-profile-manager";
import { loadQemuConfig } from "../src/main/qemu/config";
import { OverlayStore } from "../src/main/qemu/overlays";
import { buildQemuArguments } from "../src/main/qemu/arguments";
import { ProxyGateway } from "../src/main/qemu/proxyGateway";
import { QmpTransport } from "../src/main/qemu/transport";
import { QmpClient } from "../src/main/qemu/qmp";
import { GuestAgent } from "../src/main/qemu/guestAgent";
import { launchProcess } from "../src/main/qemu/process";
import { parseProxyList } from "../src/shared/proxyList";
import { applyRuntimeSimulation } from "../src/shared/runtime";

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run test:proxy-guest -- <proxy-list.txt>");
const proxy = parseProxyList(await readFile(resolve(input), "utf8"))[0]!;
const config = await loadQemuConfig(resolve(process.env.QEMU_TEST_CONFIG ?? join(process.env.APPDATA!, "platypus-browser/qemu.json")));
const directory = await mkdtemp(join(tmpdir(), "platypus-proxy-qa-"));
const keys = new MemoryKeyring("qa", { qa: Buffer.alloc(32, 27) });
const adios = new HardwareProfileManager({ directory: join(directory, "vault"), keys });
const browser = { id: randomUUID(), name: "Proxy QA", startUrl: "http://127.0.0.1:9/", proxy: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const gateway = await ProxyGateway.create({ ...proxy, hasCredentials: true }, { username: proxy.username!, password: proxy.password! });
await gateway.enableMultiplexing();
const control = await QmpTransport.listen(30000);
const guestTransport = await QmpTransport.listen(90000);
const overlays = new OverlayStore(join(directory, "overlays"), launchProcess);
let qmp: QmpClient | undefined, agent: GuestAgent | undefined;
let child: ReturnType<typeof launchProcess> | undefined;
let exit: Promise<void> | undefined;
try {
  const hardware = await adios.create(browser.id);
  const prepared = await overlays.prepare(config, hardware, browser);
  const args = buildQemuArguments({ ...config, display: "gtk" }, hardware, prepared.overlays, prepared.launchPath, control.address, gateway.port);
  args[args.indexOf("-display") + 1] = "none";
  args.push("-device", "virtio-serial-pci", "-chardev", `socket,id=qa,host=127.0.0.1,port=${guestTransport.address.split(":").at(-1)}`,
    "-device", "virtserialport,chardev=qa,name=org.qemu.guest_agent.0");
  child = launchProcess(config.qemuPath, args);
  child.stdout.resume(); child.stderr.on("data", (data) => process.stderr.write(data));
  exit = new Promise<void>((resolve) => child!.once("close", () => { control.close(); guestTransport.close(); resolve(); }));
  qmp = new QmpClient(child, 30000, () => undefined, undefined, await control.connection);
  await qmp.initialize(); await qmp.command("cont");
  agent = GuestAgent.fromSocket(await guestTransport.connection);
  for (let i = 0; ; i++) { try { await agent.synchronize(); break; } catch (error) { if (i > 90) throw error; await setTimeout(500); } }
  async function execute(path: string, arg: string[], timeout = 90000): Promise<string> {
    const result = await agent!.command("guest-exec", { path, arg, "capture-output": true });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const status = await agent!.command("guest-exec-status", { pid: result.pid });
      if (status.exited) {
        const output = Buffer.from(status["out-data"] ?? "", "base64").toString();
        assert.equal(status.exitcode, 0, Buffer.from(status["err-data"] ?? "", "base64").toString().slice(-2048)); return output;
      }
      await setTimeout(250);
    }
    throw new Error("Guest proxy verification timed out.");
  }
  const runtime = { webrtcPolicy: "blocked" as const };
  const payload = { workspaceId: browser.id, startUrl: "https://ipv4.webshare.io/", runtime, proxy: true,
    readyHost: await readFile("guest/qa-ready.py", "utf8"), proxyMux: await readFile("guest/proxy-mux.py", "utf8"),
    source: `(${applyRuntimeSimulation.toString()})(${JSON.stringify(runtime)});` };
  console.log("Booting proxied VM and deploying managed Chromium...");
  assert.equal(JSON.parse(await execute("/usr/bin/python3", ["-c", await readFile("guest/configure-runtime.py", "utf8"), JSON.stringify(payload)])).applied, true);
  const check = `import subprocess,concurrent.futures,socket,json
def check(i):
 r=subprocess.run(['runuser','-u','workspace','--','chromium','--headless','--disable-gpu','--no-first-run','--disable-quic','--user-data-dir=/tmp/proxy-qa-'+str(i),'--proxy-server=socks5://127.0.0.1:1080','--proxy-bypass-list=<-loopback>','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--dump-dom','https://ipv4.webshare.io/'],capture_output=True,timeout=45)
 assert r.returncode==0 and ${JSON.stringify(proxy.host)} in r.stdout.decode(),r.stdout.decode()[-2000:]
 return True
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: results=list(pool.map(check,range(3)))
try:
 socket.create_connection(('1.1.1.1',443),timeout=3)
 raise AssertionError('Direct external connection escaped proxy isolation')
except (TimeoutError,OSError): pass
print(json.dumps({'parallelBrowsers':len(results),'exitIp':${JSON.stringify(proxy.host)},'directBlocked':True}))`;
  const report = JSON.parse(await execute("/usr/bin/python3", ["-c", check]));
  assert.equal(report.parallelBrowsers, 3); assert.equal(report.directBlocked, true);
  console.log(JSON.stringify(report));
  console.log("Real VM proxy verification passed: managed browser startup, three concurrent browsers, expected exit IP, direct egress blocked.");
} finally {
  if (qmp) await qmp.command("quit", 3000).catch(() => undefined);
  child?.kill(); if (exit) await exit;
  agent?.close(); qmp?.close(); control.close(); guestTransport.close(); gateway.close(); keys.destroy();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
  await rm(directory, { recursive: true, force: true });
}
