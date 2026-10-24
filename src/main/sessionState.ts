import { EncryptedSettingsStore } from "@adios/hwid-profile-manager";
import { app } from "electron";
import type { Session } from "electron";
import { join } from "node:path";
import { ElectronAdiosKeys } from "./adiosKeys";
import { normalizeCookies, parseCookieImport } from "./cookieImport";
import { normalizeBypassRules } from "../shared/sessionConfig";
import type { ImportedCookie, SessionConfiguration } from "../shared/types";

interface State { version: 1; revision: number; cookies: ImportedCookie[]; proxyBypassRules: string[] }
function decode(value: unknown): State {
  if (value === null) return { version: 1, revision: 0, cookies: [], proxyBypassRules: normalizeBypassRules() };
  const data = value as State;
  if (!data || data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error("Invalid encrypted session state.");
  return { version: 1, revision: data.revision, cookies: normalizeCookies(data.cookies), proxyBypassRules: normalizeBypassRules(data.proxyBypassRules) };
}
export function sessionSummary(state: State): SessionConfiguration {
  return { revision: state.revision, cookieCount: state.cookies.length, proxyBypassRules: state.proxyBypassRules };
}
export class SessionStateStore {
  private readonly settings: EncryptedSettingsStore;
  constructor() {
    const directory = join(app.getPath("userData"), "session-vault");
    this.settings = new EncryptedSettingsStore({ directory, keys: new ElectronAdiosKeys(join(app.getPath("userData"), "keys/session-master.dat"), directory), lockTimeoutMs: 1000, maxRecordBytes: 5 * 1024 * 1024 });
  }
  async get(id: string): Promise<State> { return decode(await this.settings.load(id)); }
  async importCookies(id: string, contents: unknown): Promise<SessionConfiguration> {
    const cookies = parseCookieImport(contents);
    return sessionSummary(decode(await this.settings.update(id, (raw) => { const current = decode(raw); return { ...current, revision: current.revision + 1, cookies }; })));
  }
  async configure(id: string, rules: unknown): Promise<SessionConfiguration> {
    const proxyBypassRules = normalizeBypassRules(rules);
    return sessionSummary(decode(await this.settings.update(id, (raw) => { const current = decode(raw); return { ...current, revision: current.revision + 1, proxyBypassRules }; })));
  }
  async hydrate(id: string, target: Session): Promise<void> {
    const state = await this.get(id);
    for (let i = 0; i < state.cookies.length; i++) {
      const cookie = state.cookies[i]!;
      if (cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1000) continue;
      try { await target.cookies.set(cookie); }
      catch { throw new Error(`Could not hydrate imported cookie ${i + 1}. Profile navigation was stopped.`); }
    }
    await target.cookies.flushStore();
  }
  async purge(id: string): Promise<void> { await this.settings.purge(id); }
}
