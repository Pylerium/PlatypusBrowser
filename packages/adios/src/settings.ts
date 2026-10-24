import { encryptRecord, decryptRecord } from "./crypto.js";
import type { KeyProvider } from "./crypto.js";
import { FileProfileStorage } from "./storage.js";
import { ProfileError } from "./errors.js";
import { validateWorkspaceId } from "./model.js";

/** Versioned application settings, in a dedicated vault separate from hardware leases. */
export class EncryptedSettingsStore {
  private readonly storage: FileProfileStorage;
  constructor(options: { directory: string; keys: KeyProvider; lockTimeoutMs?: number; maxRecordBytes?: number }) {
    this.maxRecordBytes = options.maxRecordBytes ?? 32768;
    if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1024 || this.maxRecordBytes > 8 * 1024 * 1024) throw new ProfileError("INVALID_INPUT", "Invalid encrypted record size limit.");
    this.storage = new FileProfileStorage(options.directory, options.lockTimeoutMs, Math.max(65536, Math.ceil(this.maxRecordBytes / 3) * 4 + 1024));
    this.keys = options.keys;
  }
  private readonly keys: KeyProvider;
  private readonly maxRecordBytes: number;
  async load(id: string): Promise<unknown | null> {
    validateWorkspaceId(id);
    return this.storage.withLock(id, async () => {
      const encoded = await this.storage.read(id, "settings.enc");
      return encoded ? decryptRecord(encoded, `adios-settings:${id}`, this.keys, this.maxRecordBytes) : null;
    });
  }
  async save(id: string, value: unknown): Promise<void> {
    await this.update(id, () => value);
  }
  async update(id: string, transform: (current: unknown | null) => unknown): Promise<unknown> {
    validateWorkspaceId(id);
    return this.storage.withLock(id, async () => {
      const previous = await this.storage.read(id, "settings.enc");
      const value = transform(previous ? await decryptRecord(previous, `adios-settings:${id}`, this.keys, this.maxRecordBytes) : null);
      let snapshot: unknown;
      try { snapshot = JSON.parse(JSON.stringify(value)); } catch { throw new ProfileError("INVALID_INPUT", "Settings must be JSON data."); }
      const encoded = await encryptRecord(`adios-settings:${id}`, snapshot, this.keys, this.maxRecordBytes);
      if (!previous) await this.storage.ensureWorkspace(id);
      await this.storage.write(id, "settings.enc", encoded);
      return snapshot;
    });
  }
  async purge(id: string): Promise<boolean> { return this.storage.withLock(id, () => this.storage.purge(id)); }
}
