import { safeStorage } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProfileError } from "@adios/hwid-profile-manager";
import type { EncryptionKey, KeyProvider } from "@adios/hwid-profile-manager";

const absent = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** The master key is OS-encrypted and kept outside the Adios descriptor vault. */
export class ElectronAdiosKeys implements KeyProvider {
  constructor(private readonly path: string, private readonly vaultDirectory: string) {}
  async activeKey(): Promise<EncryptionKey> { return this.readKey("electron-v1", true); }
  async keyById(id: string): Promise<EncryptionKey> { return this.readKey(id, false); }
  private async readKey(id: string, allowCreation: boolean): Promise<EncryptionKey> {
    if (id !== "electron-v1") throw new ProfileError("KEY_UNAVAILABLE", "Unknown Adios encryption key ID.");
    if ((process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") || !(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new ProfileError("KEY_UNAVAILABLE", "OS-backed encryption is required for the Adios vault.");
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let exists = true;
    try { await lstat(this.path); } catch (error) { if (!absent(error)) throw error; exists = false; }
    if (!exists) {
      const entries = await readdir(join(this.vaultDirectory, "workspaces")).catch((error: unknown) => { if (absent(error)) return []; throw error; });
      if (!allowCreation || entries.length !== 0) throw new ProfileError("KEY_UNAVAILABLE", "The Adios master key is missing. Restore its backup; existing vaults never receive a replacement key.");
      const raw = randomBytes(32);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const encrypted = await safeStorage.encryptStringAsync(raw.toString("hex"));
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
        // Exclusive atomic publication: another process can never replace the key.
        await link(temporary, this.path).catch((error: unknown) => {
          if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
        });
      } finally {
        raw.fill(0);
        await unlink(temporary).catch((error: unknown) => { if (!absent(error)) throw error; });
      }
    }
    const info = await lstat(this.path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) throw new ProfileError("KEY_UNAVAILABLE", "Unsafe Adios master key file.");
    const decrypted = await safeStorage.decryptStringAsync(await readFile(this.path));
    if (!/^[0-9a-f]{64}$/.test(decrypted.result)) throw new ProfileError("KEY_UNAVAILABLE", "Invalid Adios master key material.");
    return { id, bytes: Buffer.from(decrypted.result, "hex") };
  }
}
