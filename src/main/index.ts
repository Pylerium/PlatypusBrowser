import { app, BrowserWindow, ipcMain, screen, session } from "electron";
import { get as httpGet } from "node:http";
import type { IpcMainInvokeEvent } from "electron";
import type { Session } from "electron";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserProfile, BrowserStatus, ProfileInput, RuntimeSimulation } from "../shared/types";
import { ProfileStore } from "./profileStore";
import { runtimeArgumentPrefix, validateRuntime } from "../shared/runtime";
import { HardwareProfileManager } from "@adios/hwid-profile-manager";
import { ElectronAdiosKeys } from "./adiosKeys";
import { WorkspaceController } from "./qemu/controller";
import { loadQemuConfig } from "./qemu/config";
import { TelemetryStore } from "./telemetryStore";
import { GuestRuntime } from "./qemu/guestRuntime";
import { ProxyDispatcher } from "./proxyDispatcher";
import { parseProxyList } from "../shared/proxyList";
import { exportProfileMetadata, importProfileMetadata, normalizeTenant } from "../shared/profileMetadata";
import { updateNetworkTelemetry } from "./networkPolicy";
import { SessionStateStore, sessionSummary } from "./sessionState";
import { bypassesProxy, normalizeBypassRules, noProxyValue } from "../shared/sessionConfig";

const store = new ProfileStore();
const telemetry = new TelemetryStore();
const sessionStates = new SessionStateStore();
const proxyDispatcher = new ProxyDispatcher(store);
for (const key of ["no_proxy", "NO_PROXY"]) process.env[key] = [...new Set([...(process.env[key] ?? "").split(",").filter(Boolean), ...noProxyValue(normalizeBypassRules()).split(",")])].join(",");
const localRuntime = new Map<number, RuntimeSimulation | null>();
const telemetryOperations = new Map<string, Promise<unknown>>();
const profileWindows = new Map<string, BrowserWindow>();
const activeProfileOperations = new Set<string>();
let managerWindow: BrowserWindow | null = null;
let isQuitting = false;
let shutdownFinished = false;
let shutdownInProgress = false;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
const workspaces = new WorkspaceController({
  guest: async (profile) => {
    const state = await sessionStates.get(profile.id);
    return GuestRuntime.create(profile, undefined, state, await proxyDispatcher.createGateway(profile, state.proxyBypassRules));
  },
  adios: new HardwareProfileManager({
    directory: join(app.getPath("userData"), "adios-vault"),
    keys: new ElectronAdiosKeys(join(app.getPath("userData"), "keys", "adios-master.dat"), join(app.getPath("userData"), "adios-vault")),
    lockTimeoutMs: 1000,
  }),
  overlayDirectory: join(app.getPath("userData"), "qemu-workspaces"),
  config: () => loadQemuConfig(resolve(process.env.PLATYPUS_QEMU_CONFIG ?? join(app.getPath("userData"), "qemu.json"))),
  status: (status) => {
    if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send("workspace:status", status);
  },
});

app.setPath("sessionData", join(app.getPath("userData"), "session-data"));
for (const flag of ["enable-automation", "test-type", "remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk"]) {
  app.commandLine.removeSwitch(flag);
}
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("dns-prefetch-disable");
app.commandLine.appendSwitch("disable-quic");

const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const rendererHtml = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const managerUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(rendererHtml).href;
const profileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const downloadGuardedSessions = new WeakSet<Session>();

async function effectiveProfile(id: string): Promise<BrowserProfile> {
  const profile = (await store.list()).find((item) => item.id === id);
  if (!profile) throw new Error("This profile no longer exists.");
  return { ...profile, session: sessionSummary(await sessionStates.get(id)), runtime: (await telemetry.get(id, profile.runtime)).runtime };
}

function serializeTelemetry<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const task = (telemetryOperations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
  telemetryOperations.set(id, task);
  void task.finally(() => { if (telemetryOperations.get(id) === task) telemetryOperations.delete(id); }).catch(() => undefined);
  return task;
}

function isTrustedManagerUrl(candidate: string): boolean {
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(managerUrl);
    return candidateUrl.origin === expectedUrl.origin && candidateUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

function assertTrustedManager(event: IpcMainInvokeEvent): void {
  if (isQuitting) throw new Error("The application is shutting down.");
  if (
    !managerWindow ||
    event.sender !== managerWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !event.senderFrame ||
    !isTrustedManagerUrl(event.senderFrame.url)
  ) {
    throw new Error("This operation is only available from the trusted profile manager window.");
  }
}

function validateProfileId(profileId: unknown): asserts profileId is string {
  if (typeof profileId !== "string" || !profileIdPattern.test(profileId)) {
    throw new Error("Invalid profile identifier.");
  }
}

function getProfileStorageDirectory(profileId: string): string {
  validateProfileId(profileId);
  const expected = resolve(app.getPath("sessionData"), "Partitions", `profile-${profileId}`);
  const storagePath = session.fromPartition(`persist:profile-${profileId}`).getStoragePath();
  if (!storagePath || resolve(storagePath) !== expected) {
    throw new Error("Electron returned an unexpected profile storage path; refusing to delete it.");
  }
  return expected;
}

async function retryPendingProfilePurges(): Promise<void> {
  for (const profileId of await store.getPendingPurges()) {
    try {
      validateProfileId(profileId);
      await purgeProfileData(profileId);
    } catch (error) {
      console.error(`Deferred profile data cleanup failed for ${profileId}:`, error);
    }
  }
}

async function purgeProfileData(profileId: string, clearSession = false): Promise<void> {
  proxyDispatcher.release(profileId);
  await workspaces.purge(profileId, async () => {
    await telemetry.purge(profileId);
    await sessionStates.purge(profileId);
    validateProfileId(profileId);
    // Startup recovery must not instantiate a session: doing so reopens Chromium's
    // Windows file handles and makes the deferred directory impossible to remove.
    const directory = clearSession ? getProfileStorageDirectory(profileId)
      : resolve(app.getPath("sessionData"), "Partitions", `profile-${profileId}`);
    if (clearSession) {
      const profileSession = session.fromPartition(`persist:profile-${profileId}`);
      await profileSession.closeAllConnections();
      await profileSession.clearData();
      await profileSession.clearCache();
      await profileSession.clearAuthCache();
      await profileSession.clearHostResolverCache();
      await profileSession.cookies.flushStore();
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await store.completePurge(profileId);
  });
}

function sendStatus(profileId: string, state: BrowserStatus["state"], message?: string): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send("browser:status", {
      profileId,
      state,
      windowOpen: profileWindows.has(profileId),
      message,
    } satisfies BrowserStatus);
  }
}

async function getProfileSession(profile: BrowserProfile): Promise<Session> {
  const profileSession = session.fromPartition(`persist:profile-${profile.id}`);
  const routing = await sessionStates.get(profile.id);
  await profileSession.setProxy({
    mode: profile.proxy ? "fixed_servers" : "direct",
    proxyRules: await proxyDispatcher.localRules(profile, routing.proxyBypassRules),
    proxyBypassRules: routing.proxyBypassRules.join(";"),
  });
  await profileSession.closeAllConnections();
  updateNetworkTelemetry(profileSession, validateRuntime(profile.runtime));
  profileSession.setUserAgent(profile.runtime?.userAgent ?? app.userAgentFallback, profile.runtime?.languages ?? app.getLocale());
  profileSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  profileSession.setPermissionCheckHandler(() => false);
  if (!downloadGuardedSessions.has(profileSession)) {
    profileSession.on("will-download", (event, item) => {
      event.preventDefault();
      sendStatus(profile.id, "error", `Download blocked: ${item.getFilename()}`);
    });
    downloadGuardedSessions.add(profileSession);
  }
  return profileSession;
}

async function checkProxyConnectivity(
  profileId: string,
  profile: BrowserProfile,
  profileSession: Session,
): Promise<{ latencyMs: number }> {
  if (!profile.proxy) throw new Error("Configure a proxy before verifying this profile.");
  const expectedRoute = proxyDispatcher.expectedLocalRoute(profileId);
  const selectedRoutes = (await profileSession.resolveProxy("https://example.com"))
    .split(";")
    .map((route) => route.trim().toLowerCase())
    .filter(Boolean);
  if (selectedRoutes.length !== 1 || selectedRoutes[0] !== expectedRoute) {
    throw new Error("Chromium did not resolve this request to the configured proxy only.");
  }

  const checkWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      session: profileSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  checkWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockOutsidePreflightOrigin = (
    event: Electron.Event,
    targetUrl: string,
  ) => {
    try {
      if (new URL(targetUrl).origin !== "https://example.com") event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  checkWindow.webContents.on("will-navigate", blockOutsidePreflightOrigin);
  checkWindow.webContents.on("will-redirect", blockOutsidePreflightOrigin);
  const startedAt = performance.now();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      checkWindow.loadURL("https://example.com"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Proxy check timed out after 8 seconds.")), 8000);
      }),
    ]);
    return { latencyMs: Math.round(performance.now() - startedAt) };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!checkWindow.isDestroyed()) checkWindow.destroy();
  }
}

async function launchProfile(profileId: string): Promise<void> {
  if (workspaces.has(profileId)) throw new Error("Close the QEMU workspace before opening its local browser.");
  if (profileWindows.has(profileId)) {
    profileWindows.get(profileId)?.focus();
    return;
  }
  beginProfileOperation(profileId);
  sendStatus(profileId, "connecting");
  try {
    const profile = await effectiveProfile(profileId);
    const profileSession = await getProfileSession(profile);
    if (profile.proxy && !bypassesProxy(new URL(profile.startUrl).hostname, (await sessionStates.get(profile.id)).proxyBypassRules)) {
      await checkProxyConnectivity(profileId, profile, profileSession);
    }
    await sessionStates.hydrate(profile.id, profileSession);
    profile.runtime = (await telemetry.get(profileId, profile.runtime)).runtime;
    updateNetworkTelemetry(profileSession, profile.runtime ?? null);
    profileSession.setUserAgent(profile.runtime?.userAgent ?? app.userAgentFallback, profile.runtime?.languages ?? app.getLocale());
    const runtime = validateRuntime(profile.runtime);
    const browserWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 500,
      show: false,
      title: `${profile.name} - Platypus Browser`,
      webPreferences: {
        preload: fileURLToPath(new URL("../preload/runtime.cjs", import.meta.url)),
        additionalArguments: [`${runtimeArgumentPrefix}${encodeURIComponent(JSON.stringify(runtime))}`, "--platypus-live-runtime"],
        session: profileSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });

    profileWindows.set(profileId, browserWindow);
    const contentsId = browserWindow.webContents.id;
    localRuntime.set(browserWindow.webContents.id, profile.proxy ? { ...runtime, webrtcPolicy: "blocked" } : runtime);
    browserWindow.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    browserWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    browserWindow.webContents.on("will-navigate", (event, targetUrl) => {
      if (!["http:", "https:"].includes(new URL(targetUrl).protocol)) event.preventDefault();
    });
    browserWindow.webContents.on("did-fail-load", (_event, errorCode, description) => {
      if (errorCode !== -3) sendStatus(profileId, "error", `Page load failed: ${description}`);
    });
    browserWindow.once("ready-to-show", () => browserWindow.show());
    browserWindow.once("closed", () => {
      localRuntime.delete(contentsId);
      profileWindows.delete(profileId);
      proxyDispatcher.release(profileId);
      if (!isQuitting) sendStatus(profileId, "closed");
    });
    await browserWindow.loadURL(profile.startUrl);
    sendStatus(profileId, "running");
  } catch (error) {
    profileWindows.get(profileId)?.close();
    profileWindows.delete(profileId);
    proxyDispatcher.release(profileId);
    sendStatus(profileId, "error", error instanceof Error ? error.message : "Browser launch failed.");
    throw error;
  } finally {
    activeProfileOperations.delete(profileId);
  }
}

function beginProfileOperation(profileId: string): void {
  if (activeProfileOperations.has(profileId)) {
    throw new Error("Another operation for this profile is already in progress.");
  }
  activeProfileOperations.add(profileId);
}

function assertNotRunning(profileId: string): void {
  if (profileWindows.has(profileId) || workspaces.has(profileId) || activeProfileOperations.has(profileId)) {
    throw new Error("Close this profile's workspace and local browser before changing or deleting it.");
  }
}

function registerIpc(): void {
  ipcMain.handle("diagnostics:local-backend", (event) => {
    assertTrustedManager(event);
    const started = Date.now();
    return new Promise<{ reachable: boolean; statusCode?: number; latencyMs: number }>(resolve => {
      const request = httpGet("http://127.0.0.1:5000/", response => {
        resolve({ reachable: true, statusCode: response.statusCode, latencyMs: Date.now() - started }); response.destroy();
      });
      request.setTimeout(2000, () => request.destroy(new Error("Local diagnostic probe timed out.")));
      request.on("error", () => resolve({ reachable: false, latencyMs: Date.now() - started }));
    });
  });
  ipcMain.handle("browser:statuses", event => {
    assertTrustedManager(event);
    return [...profileWindows.entries()].filter(([, window]) => !window.isDestroyed()).map(([profileId, window]): BrowserStatus => ({
      profileId, state: window.webContents.isLoadingMainFrame() ? "connecting" : "running", windowOpen: true,
    }));
  });
  ipcMain.handle("profiles:import-proxies", async (event, contents: string, protocol = "http", tenant = "default") => {
    assertTrustedManager(event);
    const tenantId = normalizeTenant(tenant);
    const proxies = parseProxyList(contents, protocol as import("../shared/types").ProxyProtocol);
    return serializeTelemetry("bulk-proxy-import", async () => {
      const existing = await store.list(tenantId);
      const inputs = proxies.filter((proxy) => !existing.some((profile) => profile.proxy?.protocol === proxy.protocol && profile.proxy.host === proxy.host && profile.proxy.port === proxy.port))
        .map((proxy): ProfileInput => ({ tenantId, name: `Proxy ${proxy.protocol} ${proxy.host}:${proxy.port}`.slice(0, 64), startUrl: "https://ipv4.webshare.io/", proxy }));
      if (inputs.length) await store.saveMany(inputs);
      return { created: inputs.length, skipped: proxies.length - inputs.length };
    });
  });
  ipcMain.handle("profiles:export-metadata", async (event, id: string) => {
    assertTrustedManager(event); validateProfileId(id);
    return serializeTelemetry(id, async () => exportProfileMetadata(await effectiveProfile(id)));
  });
  ipcMain.handle("profiles:import-metadata", async (event, contents: unknown) => {
    assertTrustedManager(event);
    const input = importProfileMetadata(contents);
    const created = await store.save(input);
    try {
      await sessionStates.configure(created.id, input.proxyBypassRules);
      return await effectiveProfile(created.id);
    } catch (error) {
      await store.removeAndQueuePurge(created.id);
      await purgeProfileData(created.id).catch(() => undefined);
      throw error;
    }
  });
  ipcMain.handle("profiles:import-cookies", async (event, id: string, contents: unknown) => {
    assertTrustedManager(event); validateProfileId(id);
    return serializeTelemetry(id, async () => {
      assertNotRunning(id);
      if (!(await store.list()).some((profile) => profile.id === id)) throw new Error("Profile does not exist.");
      return workspaces.withOfflineWorkspace(id, () => sessionStates.importCookies(id, contents));
    });
  });
  ipcMain.handle("profiles:configure-session", async (event, id: string, rules: unknown) => {
    assertTrustedManager(event); validateProfileId(id);
    return serializeTelemetry(id, async () => {
      assertNotRunning(id);
      if (!(await store.list()).some((profile) => profile.id === id)) throw new Error("Profile does not exist.");
      return workspaces.withOfflineWorkspace(id, () => sessionStates.configure(id, rules));
    });
  });
  ipcMain.on("runtime:current", (event) => {
    // A profile preload can read only its own main-frame settings. No manager API
    // or profile identifier is accepted from page content.
    event.returnValue = event.senderFrame === event.sender.mainFrame && localRuntime.has(event.sender.id)
      ? localRuntime.get(event.sender.id) : null;
  });
  ipcMain.handle("telemetry:get", async (event, id: string) => {
    assertTrustedManager(event); validateProfileId(id);
    const profile = (await store.list()).find((item) => item.id === id);
    if (!profile) throw new Error("Profile does not exist.");
    return telemetry.get(id, profile.runtime);
  });
  ipcMain.handle("telemetry:save", async (event, id: string, value: unknown, revision: number) => {
    assertTrustedManager(event); validateProfileId(id);
    return serializeTelemetry(id, async () => {
      if (!(await store.list()).some((item) => item.id === id)) throw new Error("Profile does not exist.");
      const saved = await telemetry.save(id, value, revision);
      const profile = await effectiveProfile(id);
      const window = profileWindows.get(id);
      if (window && !window.isDestroyed()) {
        const previousPolicy = localRuntime.get(window.webContents.id)?.webrtcPolicy ?? null;
        const runtime = profile.proxy ? { ...saved.runtime, webrtcPolicy: "blocked" as const } : saved.runtime;
        localRuntime.set(window.webContents.id, runtime);
        updateNetworkTelemetry(window.webContents.session, runtime);
        window.webContents.session.setUserAgent(runtime?.userAgent ?? app.userAgentFallback, runtime?.languages ?? app.getLocale());
        window.webContents.setUserAgent(runtime?.userAgent ?? app.userAgentFallback);
        window.webContents.send("runtime:update", runtime);
        saved.application = "local-live";
        if (previousPolicy !== (runtime?.webrtcPolicy ?? null)) {
          await window.webContents.session.closeAllConnections();
          await window.webContents.loadURL(window.webContents.getURL() || profile.startUrl);
          saved.application = "local-reloaded";
        }
      } else if (workspaces.has(id)) saved.application = "workspace-pending";
      return saved;
    });
  });
  ipcMain.handle("telemetry:apply-workspace", async (event, id: string) => {
    assertTrustedManager(event); validateProfileId(id);
    return serializeTelemetry(id, async () => workspaces.applyTelemetry(await effectiveProfile(id)));
  });
  ipcMain.handle("telemetry:templates", (event) => { assertTrustedManager(event); return telemetry.templates(); });
  ipcMain.handle("telemetry:save-template", (event, name: string, runtime: unknown) => { assertTrustedManager(event); return telemetry.saveTemplate(name, runtime); });
  ipcMain.handle("telemetry:remove-template", (event, id: string) => { assertTrustedManager(event); return telemetry.removeTemplate(id); });
  ipcMain.handle("workspace:launch", async (event, profileId: string) => {
    assertTrustedManager(event);
    validateProfileId(profileId);
    if (profileWindows.has(profileId)) throw new Error("Close the local browser before launching its QEMU workspace.");
    beginProfileOperation(profileId);
    try {
      const profile = await effectiveProfile(profileId);
      await workspaces.launch(profile);
    } finally { activeProfileOperations.delete(profileId); }
  });
  ipcMain.handle("workspace:close", (event, profileId: string) => {
    assertTrustedManager(event);
    validateProfileId(profileId);
    return workspaces.close(profileId);
  });
  ipcMain.handle("workspace:statuses", (event) => {
    assertTrustedManager(event);
    return workspaces.statuses();
  });
  ipcMain.handle("workspace:logs", (event, profileId: string) => {
    assertTrustedManager(event);
    validateProfileId(profileId);
    return workspaces.logs(profileId);
  });
  ipcMain.handle("profiles:list", (event, tenantId?: string) => {
    assertTrustedManager(event);
    return store.list(tenantId).then((profiles) => Promise.all(profiles.map(async (profile) => ({ ...profile, session: sessionSummary(await sessionStates.get(profile.id)), runtime: (await telemetry.get(profile.id, profile.runtime)).runtime }))));
  });
  ipcMain.handle("profiles:has-pending-cleanup", (event) => {
    assertTrustedManager(event);
    return store.hasPendingCleanup();
  });
  ipcMain.handle("profiles:save", async (event, input: ProfileInput, id?: string) => {
    assertTrustedManager(event);
    const bypassRules = input?.proxyBypassRules === undefined ? undefined : normalizeBypassRules(input.proxyBypassRules);
    const save = async () => {
      const profile = await store.save(input, id);
      const state = await telemetry.get(profile.id, profile.runtime);
      await telemetry.save(profile.id, profile.runtime, state.revision);
      if (bypassRules) await sessionStates.configure(profile.id, bypassRules);
      return { ...profile, session: sessionSummary(await sessionStates.get(profile.id)) };
    };
    if (id) {
      validateProfileId(id);
      assertNotRunning(id);
      return serializeTelemetry(id, () => workspaces.withOfflineWorkspace(id, save));
    }
    return save();
  });
  ipcMain.handle("profiles:remove", async (event, id: string) => {
    assertTrustedManager(event);
    validateProfileId(id);
    return serializeTelemetry(id, async () => {
    assertNotRunning(id);
    beginProfileOperation(id);
    try {
      await store.removeAndQueuePurge(id);
      let cleanupPending = true;
      try {
        await purgeProfileData(id, true);
        cleanupPending = false;
      } catch (error) {
        console.error(`Profile data cleanup will be retried after restart for ${id}:`, error);
      }
      return { cleanupPending };
    } finally {
      activeProfileOperations.delete(id);
    }
    });
  });
  ipcMain.handle("browser:launch", (event, profileId: string) => {
    assertTrustedManager(event);
    validateProfileId(profileId);
    return launchProfile(profileId);
  });
  ipcMain.handle("browser:close", (event, profileId: string) => {
    assertTrustedManager(event);
    validateProfileId(profileId);
    profileWindows.get(profileId)?.close();
  });
  ipcMain.handle("browser:check-proxy", async (event, profileId: string) => {
    assertTrustedManager(event);
    validateProfileId(profileId);
    beginProfileOperation(profileId);
    try {
      const profile = (await store.list()).find((item) => item.id === profileId);
      if (!profile) throw new Error("This profile no longer exists.");
      if (!profile.proxy) throw new Error("Configure a proxy for this profile before testing it.");

      const profileSession = await getProfileSession(profile);
      return await checkProxyConnectivity(profileId, profile, profileSession);
    } finally {
      if (!profileWindows.has(profileId)) proxyDispatcher.release(profileId);
      activeProfileOperations.delete(profileId);
    }
  });
}

async function createManagerWindow(): Promise<void> {
  const area = screen.getPrimaryDisplay().workAreaSize;
  managerWindow = new BrowserWindow({
    width: Math.min(1440, area.width),
    height: Math.min(920, area.height),
    minWidth: 800,
    minHeight: 600,
    title: "Platypus Browser",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  managerWindow.on("closed", () => {
    managerWindow = null;
  });
  managerWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedManagerUrl(targetUrl)) event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    await managerWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await managerWindow.loadFile(rendererHtml);
  }
}

if (singleInstance) app.whenReady().then(async () => {
  registerIpc();
  try {
    await retryPendingProfilePurges();
  } catch (error) {
    console.error("Deferred profile cleanup could not be checked:", error);
  }
  await createManagerWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createManagerWindow();
  });
});

app.on("second-instance", () => { managerWindow?.show(); managerWindow?.focus(); });

app.on("before-quit", (event) => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  isQuitting = true;
  void workspaces.closeAll().then(() => {
    proxyDispatcher.close();
    shutdownFinished = true;
    app.quit();
  }).catch((error: unknown) => {
    shutdownInProgress = false;
    isQuitting = false;
    console.error("Workspace shutdown failed:", error);
    if (!managerWindow || managerWindow.isDestroyed()) void createManagerWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
