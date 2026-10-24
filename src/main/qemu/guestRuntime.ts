import { setTimeout } from "node:timers/promises";
import bootstrap from "../../../guest/configure-runtime.py?raw";
import readyHost from "../../../guest/qa-ready.py?raw";
import proxyMux from "../../../guest/proxy-mux.py?raw";
import { applyRuntimeSimulation, validateRuntime } from "../../shared/runtime";
import type { BrowserProfile, ImportedCookie, ProxyCredentials } from "../../shared/types";
import { noProxyValue, normalizeBypassRules } from "../../shared/sessionConfig";
import { ProxyGateway } from "./proxyGateway";
import { QmpTransport } from "./transport";
import { GuestAgent } from "./guestAgent";
import type { GuestSession } from "./controller";

export class GuestRuntime implements GuestSession {
  readonly arguments: string[];
  private agent?: GuestAgent;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private hydrated = false;
  get proxyPort(): number | undefined { return this.gateway?.port; }
  private constructor(private readonly transport: QmpTransport, private readonly gateway?: ProxyGateway, private readonly cookies: ImportedCookie[] = [], private readonly bypassRules: string[] = normalizeBypassRules()) {
    const port = transport.address.split(":").at(-1)!;
    this.arguments = ["-device", "virtio-serial-pci", "-chardev", `socket,id=qa,host=127.0.0.1,port=${port}`,
      "-device", "virtserialport,chardev=qa,name=org.qemu.guest_agent.0"];
  }
  static async create(profile?: BrowserProfile, credentials?: ProxyCredentials, state?: { cookies: ImportedCookie[]; proxyBypassRules: string[] }, suppliedGateway?: ProxyGateway): Promise<GuestRuntime> {
    if (profile?.proxy?.hasCredentials && !credentials && !suppliedGateway) throw new Error("Saved proxy credentials are unavailable.");
    const rules = normalizeBypassRules(state?.proxyBypassRules);
    const gateway = suppliedGateway ?? (profile?.proxy ? await ProxyGateway.create(profile.proxy, credentials, rules) : undefined);
    try { await gateway?.enableMultiplexing(); return new GuestRuntime(await QmpTransport.listen(90000), gateway, state?.cookies, rules); }
    catch (error) { gateway?.close(); throw error; }
  }
  apply(profile: BrowserProfile): Promise<void> {
    const snapshot = structuredClone(profile);
    const task = this.queue.then(() => this.deploy(snapshot));
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async deploy(profile: BrowserProfile): Promise<void> {
    if (this.closed) throw new Error("Guest runtime channel closed.");
    this.agent ??= GuestAgent.fromSocket(await this.transport.connection);
    const deadline = Date.now() + 90000;
    while (!this.closed) {
      try { await this.agent.synchronize(); break; }
      catch (error) { if (Date.now() > deadline) throw error; await setTimeout(500); }
    }
    if (this.closed) throw new Error("Guest runtime deployment cancelled.");
    if (Boolean(profile.proxy) !== Boolean(this.gateway)) throw new Error("Close and relaunch the workspace after changing its proxy.");
    const savedRuntime = validateRuntime(profile.runtime);
    const runtime = this.gateway ? { ...savedRuntime, webrtcPolicy: "blocked" as const } : savedRuntime;
    const hydrateCookies = !this.hydrated && this.cookies.length > 0;
    if (hydrateCookies) {
      const prepared = await this.agent.command("guest-exec", { path: "/usr/bin/python3", arg: ["-c", "import os; f=os.open('/run/platypus-session-import.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600);os.fchmod(f,0o600);os.close(f)"], "capture-output": true });
      while (true) {
        const status = await this.agent.command("guest-exec-status", { pid: prepared.pid });
        if (status.exited) { if (status.exitcode !== 0) throw new Error("Could not prepare private guest cookie transfer."); break; }
        if (Date.now() > deadline) throw new Error("Guest cookie transfer preparation timed out.");
        await setTimeout(100);
      }
      const handle = await this.agent.command("guest-file-open", { path: "/run/platypus-session-import.json", mode: "w" });
      try {
        const data = Buffer.from(JSON.stringify(this.cookies));
        for (let offset = 0; offset < data.length;) {
          const chunk = data.subarray(offset, offset + 24576);
          const written = await this.agent.command("guest-file-write", { handle, "buf-b64": chunk.toString("base64") });
          if (!Number.isInteger(written.count) || written.count <= 0 || written.count > chunk.length) throw new Error("Guest cookie transfer failed.");
          offset += written.count;
        }
      } finally { await this.agent.command("guest-file-close", { handle }); }
    }
    const payload = { workspaceId: profile.id, startUrl: profile.startUrl, runtime, readyHost, proxyMux, proxy: Boolean(this.gateway),
      hydrateCookies, noProxy: noProxyValue(this.bypassRules),
      source: `(${applyRuntimeSimulation.toString()})(${JSON.stringify(runtime)});` };
    const result = await this.agent.command("guest-exec", { path: "/usr/bin/python3", arg: ["-c", bootstrap, JSON.stringify(payload)], "capture-output": true });
    const finish = Date.now() + 90000;
    while (!this.closed && Date.now() < finish) {
      const status = await this.agent.command("guest-exec-status", { pid: result.pid });
      if (status.exited) {
        if (status.exitcode !== 0) throw new Error("Guest telemetry deployment failed: " + Buffer.from(status["err-data"] ?? "", "base64").toString("utf8").slice(-2048));
        const confirmation = JSON.parse(Buffer.from(status["out-data"] ?? "", "base64").toString("utf8"));
        if (confirmation.applied !== true) throw new Error("The guest did not acknowledge its telemetry configuration.");
        this.hydrated = true;
        return;
      }
      await setTimeout(500);
    }
    throw new Error("Guest telemetry deployment did not complete.");
  }
  close(): void { this.closed = true; this.agent?.close(); this.transport.close(); this.gateway?.close(); }
}
