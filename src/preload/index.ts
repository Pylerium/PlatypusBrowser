import { contextBridge, ipcRenderer } from "electron";
import type { BrowserStatus, PlatypusApi, ProfileInput, WorkspaceStatus } from "../shared/types";

const api: PlatypusApi = {
  diagnostics: { localBackend: () => ipcRenderer.invoke("diagnostics:local-backend") },
  telemetry: {
    get: (id) => ipcRenderer.invoke("telemetry:get", id),
    save: (id, runtime, revision) => ipcRenderer.invoke("telemetry:save", id, runtime, revision),
    applyToWorkspace: (id) => ipcRenderer.invoke("telemetry:apply-workspace", id),
    templates: () => ipcRenderer.invoke("telemetry:templates"),
    saveTemplate: (name, runtime) => ipcRenderer.invoke("telemetry:save-template", name, runtime),
    removeTemplate: (id) => ipcRenderer.invoke("telemetry:remove-template", id),
  },
  workspace: {
    launch: (profileId) => ipcRenderer.invoke("workspace:launch", profileId),
    close: (profileId) => ipcRenderer.invoke("workspace:close", profileId),
    statuses: () => ipcRenderer.invoke("workspace:statuses"),
    logs: (profileId) => ipcRenderer.invoke("workspace:logs", profileId),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: WorkspaceStatus) => callback(status);
      ipcRenderer.on("workspace:status", listener);
      return () => ipcRenderer.removeListener("workspace:status", listener);
    },
  },
  profiles: {
    importProxies: (contents, protocol, tenantId) => ipcRenderer.invoke("profiles:import-proxies", contents, protocol, tenantId),
    exportMetadata: (id) => ipcRenderer.invoke("profiles:export-metadata", id),
    importMetadata: (contents) => ipcRenderer.invoke("profiles:import-metadata", contents),
    importCookies: (id, contents) => ipcRenderer.invoke("profiles:import-cookies", id, contents),
    configureSession: (id, rules) => ipcRenderer.invoke("profiles:configure-session", id, rules),
    list: (tenantId) => ipcRenderer.invoke("profiles:list", tenantId),
    save: (input: ProfileInput, id?: string) => ipcRenderer.invoke("profiles:save", input, id),
    remove: (id: string) => ipcRenderer.invoke("profiles:remove", id),
    hasPendingCleanup: () => ipcRenderer.invoke("profiles:has-pending-cleanup"),
  },
  browser: {
    statuses: () => ipcRenderer.invoke("browser:statuses"),
    launch: (profileId: string) => ipcRenderer.invoke("browser:launch", profileId),
    close: (profileId: string) => ipcRenderer.invoke("browser:close", profileId),
    checkProxy: (profileId: string) => ipcRenderer.invoke("browser:check-proxy", profileId),
    onStatus: (callback: (status: BrowserStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: BrowserStatus) => callback(status);
      ipcRenderer.on("browser:status", listener);
      return () => ipcRenderer.removeListener("browser:status", listener);
    },
  },
};

contextBridge.exposeInMainWorld("platypus", api);
