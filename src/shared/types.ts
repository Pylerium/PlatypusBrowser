export type ProxyProtocol = "http" | "https" | "socks5";
export interface ImportedCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
}
export interface SessionConfiguration {
  revision: number;
  cookieCount: number;
  proxyBypassRules: string[];
}

export interface RuntimeSimulation {
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  platform?: string | null;
  canvasSeed?: number | null;
  userAgent?: string | null;
  appVersion?: string | null;
  vendor?: string | null;
  languages?: string | null;
  maxTouchPoints?: number | null;
  doNotTrack?: string | null;
  pdfViewerEnabled?: boolean | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  colorDepth?: number | null;
  devicePixelRatio?: number | null;
  webglVendor?: string | null;
  webglRenderer?: string | null;
  audioSeed?: number | null;
  mediaBlocked?: boolean | null;
  sensorsBlocked?: boolean | null;
  batteryLevel?: number | null;
  batteryCharging?: boolean | null;
  emptyVoices?: boolean | null;
  emptyGamepads?: boolean | null;
  localFontsBlocked?: boolean | null;
  connectionType?: string | null;
  connectionRtt?: number | null;
  connectionDownlink?: number | null;
  saveData?: boolean | null;
  storageQuotaMiB?: number | null;
  hidePerformanceMemory?: boolean | null;
  webrtcPolicy?: "blocked" | "relay" | null;
  hideClientHints?: boolean | null;
}

export interface TelemetryTemplate { id: string; name: string; runtime: RuntimeSimulation | null }
export interface TelemetryState {
  runtime: RuntimeSimulation | null;
  revision: number;
  application: "saved" | "local-live" | "local-reloaded" | "workspace-pending";
}

export interface ProxySettings {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  hasCredentials: boolean;
}

export interface ProxyProfileInput extends Omit<ProxySettings, "hasCredentials"> {
  username?: string;
  password?: string;
  clearCredentials?: boolean;
  hasCredentials?: boolean;
}

export interface BrowserProfileInput {
  tenantId?: string;
  runtime?: RuntimeSimulation | null;
  id: string;
  name: string;
  startUrl: string;
  proxy: (ProxySettings & Partial<Pick<ProxyProfileInput, "username" | "password" | "clearCredentials">>) | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserProfile extends Omit<BrowserProfileInput, "proxy"> {
  proxy: ProxySettings | null;
  session?: SessionConfiguration;
}

export type ProfileInput = Pick<BrowserProfileInput, "name" | "startUrl" | "runtime" | "tenantId"> & {
  proxy: ProxyProfileInput | null;
  proxyBypassRules?: string[];
};

export interface ProxyCredentials {
  username: string;
  password: string;
}

export interface BrowserStatus {
  profileId: string;
  state: "connecting" | "running" | "closed" | "error";
  windowOpen: boolean;
  message?: string;
}

export interface ProxyCheckResult {
  latencyMs: number;
}

export interface WorkspaceStatus {
  profileId: string;
  revision: number;
  state: "booting" | "running" | "terminated" | "error";
  processRunning: boolean;
  message?: string;
}

export interface WorkspaceLogs { stdout: string; stderr: string }

export interface PlatypusApi {
  diagnostics: { localBackend(): Promise<{ reachable: boolean; statusCode?: number; latencyMs: number }> };
  telemetry: {
    get(profileId: string): Promise<TelemetryState>;
    save(profileId: string, runtime: RuntimeSimulation | null, revision: number): Promise<TelemetryState>;
    applyToWorkspace(profileId: string): Promise<void>;
    templates(): Promise<TelemetryTemplate[]>;
    saveTemplate(name: string, runtime: RuntimeSimulation | null): Promise<TelemetryTemplate[]>;
    removeTemplate(id: string): Promise<TelemetryTemplate[]>;
  };
  workspace: {
    launch(profileId: string): Promise<void>;
    close(profileId: string): Promise<void>;
    statuses(): Promise<WorkspaceStatus[]>;
    logs(profileId: string): Promise<WorkspaceLogs>;
    onStatus(callback: (status: WorkspaceStatus) => void): () => void;
  };
  profiles: {
    importProxies(contents: string, protocol?: ProxyProtocol, tenantId?: string): Promise<{ created: number; skipped: number }>;
    exportMetadata(id: string): Promise<string>;
    importMetadata(contents: string): Promise<BrowserProfile>;
    importCookies(id: string, contents: string): Promise<SessionConfiguration>;
    configureSession(id: string, proxyBypassRules: string[]): Promise<SessionConfiguration>;
    list(tenantId?: string): Promise<BrowserProfile[]>;
    save(input: ProfileInput, id?: string): Promise<BrowserProfile>;
    remove(id: string): Promise<{ cleanupPending: boolean }>;
    hasPendingCleanup(): Promise<boolean>;
  };
  browser: {
    statuses(): Promise<BrowserStatus[]>;
    launch(profileId: string): Promise<void>;
    close(profileId: string): Promise<void>;
    checkProxy(profileId: string): Promise<ProxyCheckResult>;
    onStatus(callback: (status: BrowserStatus) => void): () => void;
  };
}
