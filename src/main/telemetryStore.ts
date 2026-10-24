import { EncryptedSettingsStore } from "@adios/hwid-profile-manager";
import { app } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ElectronAdiosKeys } from "./adiosKeys";
import { validateRuntime } from "../shared/runtime";
import type { RuntimeSimulation, TelemetryState, TelemetryTemplate } from "../shared/types";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid encrypted telemetry record.");
  return value as Record<string, unknown>;
}
function decode(value: unknown, fallback?: RuntimeSimulation | null): TelemetryState {
  if (value === null) return { runtime: validateRuntime(fallback), revision: 0, application: "saved" };
  const data = record(value);
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 1) throw new Error("Unsupported telemetry revision.");
  return { runtime: validateRuntime(data.runtime), revision: data.revision as number, application: "saved" };
}

export class TelemetryStore {
  private readonly settings: EncryptedSettingsStore;
  constructor() {
    const directory = join(app.getPath("userData"), "telemetry-vault");
    this.settings = new EncryptedSettingsStore({ directory, keys: new ElectronAdiosKeys(join(app.getPath("userData"), "keys", "telemetry-master.dat"), directory), lockTimeoutMs: 1000 });
  }
  async get(id: string, fallback?: RuntimeSimulation | null): Promise<TelemetryState> { return decode(await this.settings.load(id), fallback); }
  async save(id: string, runtime: unknown, revision: number): Promise<TelemetryState> {
    const configuration = validateRuntime(runtime);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid telemetry revision.");
    const result = await this.settings.update(id, (value) => {
      const current = decode(value);
      if (current.revision !== revision) throw new Error("Telemetry changed in another editor. Reload the profile before saving.");
      return { version: 1, revision: revision + 1, runtime: configuration };
    });
    return decode(result);
  }
  async purge(id: string): Promise<void> { await this.settings.purge(id); }
  private decodeTemplates(value: unknown): TelemetryTemplate[] {
    if (value === null) return [];
    const data = record(value);
    if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 20) throw new Error("Invalid telemetry templates.");
    return data.items.map((raw) => {
      const item = record(raw);
      if (typeof item.id !== "string" || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 64) throw new Error("Invalid telemetry template.");
      return { id: item.id, name: item.name, runtime: validateRuntime(item.runtime) };
    });
  }
  async templates(): Promise<TelemetryTemplate[]> { return this.decodeTemplates(await this.settings.load("templates")); }
  async saveTemplate(name: string, runtime: unknown): Promise<TelemetryTemplate[]> {
    if (typeof name !== "string" || !name.trim() || name.length > 64 || /[\u0000-\u001f]/.test(name)) throw new Error("Use a template name of 1–64 characters.");
    const config = validateRuntime(runtime);
    return this.decodeTemplates(await this.settings.update("templates", (value) => {
      const items = this.decodeTemplates(value);
      if (items.length >= 20) throw new Error("Remove a template before adding another (maximum 20).");
      return { version: 1, items: [...items, { id: randomUUID(), name: name.trim(), runtime: config }] };
    }));
  }
  async removeTemplate(id: string): Promise<TelemetryTemplate[]> {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid template ID.");
    return this.decodeTemplates(await this.settings.update("templates", (value) => ({ version: 1, items: this.decodeTemplates(value).filter((item) => item.id !== id) })));
  }
}
