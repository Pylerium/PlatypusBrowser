import { HardwareProfileManager, ProfileError } from "@adios/hwid-profile-manager";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BrowserProfile, WorkspaceLogs, WorkspaceStatus } from "../../shared/types";
import { buildQemuArguments } from "./arguments";
import type { QemuConfig } from "./config";
import { OverlayStore } from "./overlays";
import { launchProcess } from "./process";
import type { LaunchProcess } from "./process";
import { QmpClient } from "./qmp";
import { QmpTransport } from "./transport";

interface Exit { code: number | null; signal: NodeJS.Signals | null; error?: Error }
export interface GuestSession { arguments: string[]; proxyPort?: number; apply(profile: BrowserProfile): Promise<void>; close(): void }
interface Runtime {
  profileId: string;
  child?: ChildProcessWithoutNullStreams;
  qmp?: QmpClient;
  control?: QmpTransport;
  guest?: GuestSession;
  exit?: Promise<Exit>;
  task?: Promise<void>;
  closed: boolean;
  stopping: boolean;
  initialized: boolean;
  logs: WorkspaceLogs;
  config?: QemuConfig;
  controlError?: Error;
  monitor?: NodeJS.Timeout;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function exitedWithin(runtime: Runtime, milliseconds: number): Promise<boolean> {
  if (runtime.closed || !runtime.exit) return true;
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([runtime.exit.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export class WorkspaceController {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly states = new Map<string, WorkspaceStatus>();
  private readonly history = new Map<string, WorkspaceLogs>();
  private readonly overlays: OverlayStore;
  private quitting = false;
  private revision = 0;
  constructor(private readonly options: {
    adios: HardwareProfileManager;
    overlayDirectory: string;
    config: () => Promise<QemuConfig>;
    status: (status: WorkspaceStatus) => void;
    launch?: LaunchProcess;
    guest?: (profile: BrowserProfile) => Promise<GuestSession>;
  }) {
    this.overlays = new OverlayStore(options.overlayDirectory, options.launch ?? launchProcess);
  }

  has(profileId: string): boolean { return this.runtimes.has(profileId); }
  statuses(): WorkspaceStatus[] { return [...this.states.values()].map((status) => ({ ...status })); }
  logs(profileId: string): WorkspaceLogs { return { ...(this.runtimes.get(profileId)?.logs ?? this.history.get(profileId) ?? { stdout: "", stderr: "" }) }; }

  private report(runtime: Runtime, state: WorkspaceStatus["state"], message?: string): void {
    const status: WorkspaceStatus = { profileId: runtime.profileId, revision: ++this.revision, state, processRunning: Boolean(runtime.child && !runtime.closed), ...(message ? { message } : {}) };
    this.states.set(runtime.profileId, status);
    this.options.status({ ...status });
  }

  async launch(profile: BrowserProfile): Promise<void> {
    if (this.quitting) throw new Error("The application is shutting down.");
    if (this.has(profile.id)) throw new Error("This workspace is already booting or running.");
    const snapshot = structuredClone(profile);
    const runtime: Runtime = { profileId: profile.id, closed: false, stopping: false, initialized: false, logs: { stdout: "", stderr: "" } };
    const ready = deferred<void>();
    this.runtimes.set(profile.id, runtime);
    this.report(runtime, "booting");
    runtime.task = this.options.adios.withExclusiveWorkspace(profile.id, async (workspace) => {
      try {
        if (snapshot.proxy && !this.options.guest) throw new Error("Proxy workspaces require the managed guest routing adapter.");
        const config = await this.options.config(); runtime.config = config;
        let hardware;
        try { hardware = await workspace.load(); } catch (error) {
          if (!(error instanceof ProfileError) || error.code !== "NOT_FOUND") throw error;
          hardware = await workspace.create({ storageCount: config.baseImages.length });
        }
        const guestRuntime = snapshot.runtime;
        const prepared = await this.overlays.prepare(config, hardware, this.options.guest ? { ...snapshot, startUrl: "http://127.0.0.1:9/",
          runtime: guestRuntime ? { ...guestRuntime, hardwareConcurrency: guestRuntime.hardwareConcurrency ?? 4, deviceMemory: guestRuntime.deviceMemory ?? 4, platform: guestRuntime.platform ?? "Linux x86_64", canvasSeed: guestRuntime.canvasSeed ?? null } : null } : snapshot);
        if (runtime.stopping || this.quitting) throw new Error("Workspace launch cancelled.");
        runtime.control = await QmpTransport.listen(config.bootTimeoutMs);
        runtime.guest = await this.options.guest?.(snapshot);
        if (snapshot.proxy && !runtime.guest?.proxyPort) throw new Error("The guest proxy gateway is unavailable.");
        const child = (this.options.launch ?? launchProcess)(config.qemuPath, [...buildQemuArguments(config, hardware, prepared.overlays, prepared.launchPath, runtime.control.address, runtime.guest?.proxyPort), ...(runtime.guest?.arguments ?? [])]);
        runtime.child = child;
        let processError: Error | undefined;
        runtime.exit = new Promise<Exit>((resolve) => {
          child.on("error", (error) => { processError = error; });
          child.once("close", (code, signal) => {
            runtime.closed = true;
            runtime.control?.close(new Error("QEMU exited before establishing its control connection."));
            runtime.guest?.close();
            resolve({ code, signal, ...(processError ? { error: processError } : {}) });
          });
        });
        child.stdout.on("data", (chunk: Buffer) => { runtime.logs.stdout = (runtime.logs.stdout + chunk.toString("utf8")).slice(-65536); });
        child.stderr.on("data", (chunk: Buffer) => { runtime.logs.stderr = (runtime.logs.stderr + chunk.toString("utf8")).slice(-65536); });
        const connection = await runtime.control.connection;
        runtime.qmp = new QmpClient(child, config.bootTimeoutMs, (event) => {
          if (!runtime.initialized || runtime.stopping || runtime.closed) return;
          if (event === "STOP") this.report(runtime, "error", "QEMU paused the workspace. Inspect the runtime logs.");
          if (event === "RESUME") this.report(runtime, "running");
          if (event === "GUEST_PANICKED" || event === "BLOCK_IO_ERROR") this.report(runtime, "error", "The guest reported a runtime error. Inspect the runtime logs.");
        }, (error) => this.failControl(runtime, error), connection);
        this.report(runtime, "booting");
        await runtime.qmp.initialize();
        if (runtime.stopping) throw new Error("Workspace launch cancelled.");
        await runtime.qmp.command("cont");
        await runtime.guest?.apply(snapshot);
        if (runtime.stopping) throw new Error("Workspace launch cancelled.");
        const state = await runtime.qmp.command("query-status");
        if (!state || typeof state !== "object" || !("running" in state) || state.running !== true || runtime.closed) throw new Error("QEMU did not enter its running state.");
        runtime.initialized = true;
        let polling = false;
        runtime.monitor = setInterval(() => {
          if (polling || runtime.stopping || runtime.closed) return;
          polling = true;
          void runtime.qmp!.command("query-status").then((status) => {
            if (!status || typeof status !== "object" || !("running" in status) || typeof status.running !== "boolean") throw new Error("Invalid QMP runtime status.");
            if (!status.running && !runtime.stopping && !runtime.closed && this.states.get(runtime.profileId)?.state !== "error") {
              this.report(runtime, "error", "QEMU paused the workspace. Inspect its runtime logs.");
            }
          }).catch((error: unknown) => this.failControl(runtime, error instanceof Error ? error : new Error("QMP monitoring failed.")))
            .finally(() => { polling = false; });
        }, 5000);
        runtime.monitor.unref();
        this.report(runtime, "running"); ready.resolve();
        const exit = await runtime.exit;
        if (!runtime.stopping && (exit.error || runtime.controlError || exit.code !== 0)) throw new Error(exit.error?.message ?? runtime.controlError?.message ?? `QEMU exited unexpectedly (${exit.code ?? exit.signal}). ${runtime.logs.stderr.slice(-2048)}`);
      } catch (error) {
        if (runtime.child && !runtime.closed) {
          try { await this.terminate(runtime); } catch (terminationError) {
            // Retain the Adios lease until exit is confirmed, even if force-kill fails.
            this.report(runtime, "error", terminationError instanceof Error ? terminationError.message : "Could not terminate QEMU.");
            ready.reject(error);
            await runtime.exit;
          }
        }
        if (runtime.closed && runtime.exit && !runtime.initialized) {
          const exit = await runtime.exit;
          const code = exit.code === null ? exit.signal : `${exit.code} (0x${(exit.code >>> 0).toString(16).toUpperCase()})`;
          throw new Error(`QEMU failed during startup (${code}). ${exit.error?.message ?? (error instanceof Error ? error.message : "Launch failed.")}${exit.code === 0xC0000005 ? " The QEMU process crashed with a Windows access violation; try the GTK display backend." : ""} ${runtime.logs.stderr.slice(-2048)}`);
        }
        throw error;
      } finally {
        if (runtime.monitor) clearInterval(runtime.monitor);
        runtime.initialized = false;
        runtime.qmp?.close();
        runtime.control?.close();
        runtime.guest?.close();
        await this.overlays.clearLaunchManifest(profile.id);
      }
    }).then(() => {
      this.report(runtime, "terminated");
    }, (error: unknown) => {
      ready.reject(error);
      if (runtime.stopping && (!runtime.child || runtime.closed)) this.report(runtime, "terminated");
      else this.report(runtime, "error", error instanceof Error ? error.message : "Workspace launch failed.");
    }).finally(() => {
      this.runtimes.delete(profile.id);
      this.history.set(profile.id, { ...runtime.logs });
    });
    return ready.promise;
  }

  private failControl(runtime: Runtime, error: Error): void {
    if (!runtime.initialized || runtime.closed || runtime.stopping || runtime.controlError) return;
    // Pipe EOF can precede process close during a normal guest exit.
    void exitedWithin(runtime, 100).then(async (exited) => {
      if (exited || runtime.stopping || runtime.controlError) return;
      runtime.controlError = error;
      this.report(runtime, "error", "The QEMU control channel failed; terminating the workspace.");
      await this.terminate(runtime);
    }).catch((failure: unknown) => {
      this.report(runtime, "error", failure instanceof Error ? failure.message : "QEMU termination failed.");
    });
  }

  private async terminate(runtime: Runtime): Promise<void> {
    if (!runtime.child || runtime.closed) return;
    if (runtime.qmp) {
      await runtime.qmp.command("system_powerdown").catch(() => undefined);
      if (await exitedWithin(runtime, runtime.config?.shutdownTimeoutMs ?? 15000)) return;
      await runtime.qmp.command("quit", 1000).catch(() => undefined);
      if (await exitedWithin(runtime, 2000)) return;
    }
    runtime.child.kill("SIGTERM");
    if (await exitedWithin(runtime, 2000)) return;
    runtime.child.kill("SIGKILL");
    if (!(await exitedWithin(runtime, 5000))) throw new Error("QEMU termination could not be confirmed. The workspace lock remains held.");
  }

  async close(profileId: string): Promise<void> {
    const runtime = this.runtimes.get(profileId);
    if (!runtime) return;
    runtime.stopping = true;
    runtime.guest?.close();
    await this.terminate(runtime);
    await runtime.task;
  }

  async applyTelemetry(profile: BrowserProfile): Promise<void> {
    const runtime = this.runtimes.get(profile.id);
    if (!runtime?.guest || !runtime.initialized || runtime.stopping || runtime.closed) throw new Error("Wait for the workspace to finish booting before applying telemetry.");
    await runtime.guest.apply(profile);
  }

  async closeAll(): Promise<void> {
    this.quitting = true;
    const results = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.close(id)));
    if (results.some((result) => result.status === "rejected")) { this.quitting = false; throw new Error("Some QEMU processes are still running. Close them before quitting."); }
  }

  async withOfflineWorkspace<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    if (this.has(profileId)) throw new Error("Close the workspace before modifying its profile.");
    return this.options.adios.withExclusiveWorkspace(profileId, action);
  }

  async purge(profileId: string, finish: () => Promise<void>): Promise<void> {
    if (this.has(profileId)) throw new Error("Close the workspace before purging it.");
    await this.options.adios.withExclusiveWorkspace(profileId, async (workspace) => {
      await this.overlays.purge(profileId);
      await workspace.purge();
      await finish();
    });
    this.states.delete(profileId); this.history.delete(profileId);
  }
}
