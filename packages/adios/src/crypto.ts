import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ProfileError } from "./errors.js";
import { validateProfile } from "./model.js";
import type { HardwareProfile } from "./model.js";

export interface EncryptionKey {
  readonly id: string;
  /** A fresh copy; the manager zeroes this buffer after use. */
  readonly bytes: Buffer;
}

/** Implement with an OS credential vault or a KMS. Never store keys beside profiles. */
export interface KeyProvider {
  activeKey(): Promise<EncryptionKey>;
  keyById(id: string): Promise<EncryptionKey>;
}

export class MemoryKeyring implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();
  private destroyed = false;
  constructor(private readonly activeId: string, keys: Readonly<Record<string, Uint8Array>>) {
    try {
      for (const [id, bytes] of Object.entries(keys)) {
        const copy = Buffer.from(bytes);
        try { validateKey({ id, bytes: copy }); } catch (error) { copy.fill(0); throw error; }
        this.keys.set(id, copy);
      }
      if (!this.keys.has(activeId)) throw new ProfileError("KEY_UNAVAILABLE", "Active encryption key is unavailable.");
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  async activeKey(): Promise<EncryptionKey> { return this.keyById(this.activeId); }
  async keyById(id: string): Promise<EncryptionKey> {
    const bytes = this.keys.get(id);
    if (this.destroyed || !bytes) throw new ProfileError("KEY_UNAVAILABLE", "Encryption key is unavailable.");
    return { id, bytes: Buffer.from(bytes) };
  }
  destroy(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.destroyed = true;
  }
}

function validateKey(key: EncryptionKey): void {
  if (!key || typeof key.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(key.id) ||
    !Buffer.isBuffer(key.bytes) || key.bytes.length !== 32) {
    throw new ProfileError("KEY_UNAVAILABLE", "Encryption keys require a safe key ID and exactly 32 bytes.");
  }
}

interface Envelope {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

const header = (workspaceId: string, envelope: Omit<Envelope, "ciphertext" | "tag">) =>
  Buffer.from(JSON.stringify(["adios-profile", envelope.version, envelope.algorithm, workspaceId,
    envelope.keyId, envelope.salt, envelope.iv]));
const derive = (master: Buffer, salt: Buffer, workspaceId: string) =>
  Buffer.from(hkdfSync("sha256", master, salt, Buffer.from(JSON.stringify(["adios-storage", 1, workspaceId])), 32));

export async function encryptRecord(workspaceId: string, value: unknown, provider: KeyProvider, maxRecordBytes = 32768): Promise<Buffer> {
  validateRecordLimit(maxRecordBytes);
  const key = await provider.activeKey();
  let derived: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    validateKey(key);
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const envelope = { version: 1 as const, algorithm: "aes-256-gcm" as const, keyId: key.id,
      salt: salt.toString("base64"), iv: iv.toString("base64") };
    derived = derive(key.bytes, salt, workspaceId);
    const cipher = createCipheriv("aes-256-gcm", derived, iv, { authTagLength: 16 });
    cipher.setAAD(header(workspaceId, envelope));
    plaintext = Buffer.from(JSON.stringify(value));
    if (plaintext.length > maxRecordBytes) throw new ProfileError("INVALID_INPUT", "Encrypted record exceeds its size limit.");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ ...envelope, ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }) + "\n");
  } finally {
    key?.bytes?.fill(0);
    derived?.fill(0);
    plaintext?.fill(0);
  }
}

function validateRecordLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 8 * 1024 * 1024) throw new ProfileError("INVALID_INPUT", "Invalid encrypted record size limit.");
}

function base64(value: unknown, length?: number, maxBytes = 65536): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ProfileError("INTEGRITY", "Invalid encrypted profile encoding.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length)) {
    throw new ProfileError("INTEGRITY", "Invalid encrypted profile field length.");
  }
  return bytes;
}

export async function decryptRecord(encoded: Buffer, workspaceId: string, provider: KeyProvider, maxRecordBytes = 32768): Promise<unknown> {
  validateRecordLimit(maxRecordBytes);
  if (encoded.length > Math.ceil(maxRecordBytes / 3) * 4 + 1024) throw new ProfileError("INTEGRITY", "Encrypted record exceeds its size limit.");
  let envelope: Envelope;
  let salt: Buffer;
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    const value: unknown = JSON.parse(encoded.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1 || candidate.algorithm !== "aes-256-gcm" || typeof candidate.keyId !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(candidate.keyId)) throw new Error();
    salt = base64(candidate.salt, 32); iv = base64(candidate.iv, 12); tag = base64(candidate.tag, 16);
    ciphertext = base64(candidate.ciphertext, undefined, Math.ceil(maxRecordBytes / 3) * 4);
    if (ciphertext.length > maxRecordBytes) throw new Error();
    envelope = candidate as unknown as Envelope;
  } catch {
    throw new ProfileError("INTEGRITY", "Encrypted profile is malformed or unsupported.");
  }
  const key = await provider.keyById(envelope.keyId);
  let derived: Buffer | undefined;
  let plaintext: Buffer | undefined;
  const chunks: Buffer[] = [];
  try {
    validateKey(key);
    if (key.id !== envelope.keyId) throw new ProfileError("KEY_UNAVAILABLE", "Key provider returned an unexpected key ID.");
    derived = derive(key.bytes, salt, workspaceId);
    const decipher = createDecipheriv("aes-256-gcm", derived, iv, { authTagLength: 16 });
    decipher.setAAD(header(workspaceId, envelope));
    decipher.setAuthTag(tag);
    chunks.push(decipher.update(ciphertext));
    chunks.push(decipher.final());
    plaintext = Buffer.concat(chunks);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ProfileError && error.code === "KEY_UNAVAILABLE") throw error;
    throw new ProfileError("INTEGRITY", "Profile authentication or validation failed.");
  } finally {
    key?.bytes?.fill(0); derived?.fill(0); plaintext?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function encryptProfile(profile: HardwareProfile, provider: KeyProvider): Promise<Buffer> {
  return encryptRecord(profile.workspaceId, validateProfile(profile, profile.workspaceId), provider);
}

export async function decryptProfile(encoded: Buffer, workspaceId: string, provider: KeyProvider): Promise<HardwareProfile> {
  return validateProfile(await decryptRecord(encoded, workspaceId, provider), workspaceId);
}
