import { app, safeStorage } from "electron";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { validateRuntime } from "../shared/runtime";
import { normalizeProxy } from "../shared/proxyList";
import { normalizeTenant } from "../shared/profileMetadata";
import type { ProxyCredentialStore } from "./credentialStore";
import type {
  BrowserProfile,
  ProfileInput,
  ProxyCredentials,
  ProxyProtocol,
} from "../shared/types";

const encryptedFileHeader = "PLATYPUS_ENCRYPTED_V1\n";
const profileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StoredProxy {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

interface ValidatedProxy extends StoredProxy {
  clearCredentials?: boolean;
}

interface StoredProfile extends Omit<BrowserProfile, "proxy"> {
  proxy: StoredProxy | null;
}

interface ValidatedProfileInput extends Omit<ProfileInput, "proxy"> {
  proxy: ValidatedProxy | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isProfileId = (value: unknown): value is string =>
  typeof value === "string" && profileIdPattern.test(value);

function validateInput(input: ProfileInput): ValidatedProfileInput {
  if (
    !input ||
    typeof input.name !== "string" ||
    typeof input.startUrl !== "string" ||
    input.startUrl.length > 2048
  ) {
    throw new Error("Profile name and starting URL are required.");
  }
  const name = input.name.trim();
  if (!name || name.length > 64) {
    throw new Error("Profile name must be between 1 and 64 characters.");
  }

  let startUrl: URL;
  try {
    startUrl = new URL(input.startUrl);
  } catch {
    throw new Error("Enter a valid starting URL using http or https.");
  }
  if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
    throw new Error("Starting URLs must use http or https.");
  }
  if (startUrl.username || startUrl.password) {
    throw new Error("Starting URLs must not contain embedded credentials.");
  }

  let proxy: ValidatedProxy | null = null;
  if (input.proxy) {
    const candidate = normalizeProxy(input.proxy);
    if (input.proxy.clearCredentials !== undefined && typeof input.proxy.clearCredentials !== "boolean") throw new Error("Invalid proxy credential setting.");
    proxy = { ...candidate, ...(input.proxy.clearCredentials ? { clearCredentials: true } : {}) };

  }

  return { tenantId: normalizeTenant(input.tenantId), name, startUrl: startUrl.toString(), proxy, runtime: validateRuntime(input.runtime) };
}

function isStoredProfile(value: unknown): value is StoredProfile {
  if (!isObject(value)) return false;
  if (
    typeof value.id !== "string" ||
    !profileIdPattern.test(value.id) ||
    typeof value.name !== "string" ||
    typeof value.startUrl !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }
  let proxy: ProfileInput["proxy"] = null;
  if (value.proxy !== null) {
    if (
      !isObject(value.proxy) ||
      (value.proxy.protocol !== "http" &&
        value.proxy.protocol !== "https" &&
        value.proxy.protocol !== "socks5") ||
      typeof value.proxy.host !== "string" ||
      typeof value.proxy.port !== "number" ||
      (value.proxy.username !== undefined && typeof value.proxy.username !== "string") ||
      (value.proxy.password !== undefined && typeof value.proxy.password !== "string")
    ) {
      return false;
    }
    proxy = {
      protocol: value.proxy.protocol,
      host: value.proxy.host,
      port: value.proxy.port,
      username: value.proxy.username,
      password: value.proxy.password,
    };
  }
  try {
    validateRuntime(value.runtime);
    validateInput({ tenantId: normalizeTenant(value.tenantId), name: value.name, startUrl: value.startUrl, proxy });
    return true;
  } catch {
    return false;
  }
}

function toPublicProfile(stored: StoredProfile): BrowserProfile {
  const profile = { ...stored, tenantId: normalizeTenant(stored.tenantId) };
  if (!profile.proxy) return { ...profile, proxy: null };
  const { username, password, ...proxy } = profile.proxy;
  return {
    ...profile,
    proxy: { ...proxy, hasCredentials: Boolean(username && password) },
  };
}

export class ProfileStore implements ProxyCredentialStore {
  private readonly filePath = join(app.getPath("userData"), "profiles.dat");
  private readonly legacyFilePath = join(app.getPath("userData"), "profiles.json");
  private profiles = new Map<string, StoredProfile>();
  private pendingPurges = new Set<string>();
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  async list(tenantId?: string): Promise<BrowserProfile[]> {
    const selected = tenantId === undefined ? undefined : normalizeTenant(tenantId);
    await this.initialize();
    return [...this.profiles.values()]
      .filter((profile) => selected === undefined || normalizeTenant(profile.tenantId) === selected)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toPublicProfile);
  }

  async save(input: ProfileInput, id?: string): Promise<BrowserProfile> {
    await this.initialize();
    return this.withMutation(async () => {
      const validated = validateInput(input);
      const existing = id ? this.profiles.get(id) : undefined;
      if (id && !existing) throw new Error("The requested profile does not exist.");

      const now = new Date().toISOString();
      let proxy: StoredProxy | null = null;
      if (validated.proxy) {
        const {
          clearCredentials = false,
          ...candidateProxy
        } = validated.proxy;
        proxy = candidateProxy;
        if (existing?.proxy) {
          const credentialsProvided = Boolean(proxy.username && proxy.password);
          const sameProxyEndpoint =
            existing.proxy.protocol === proxy.protocol &&
            existing.proxy.host.toLowerCase() === proxy.host.toLowerCase() &&
            existing.proxy.port === proxy.port;
          if (!credentialsProvided && !clearCredentials && sameProxyEndpoint) {
            if (existing.proxy.username && existing.proxy.password) {
              proxy.username = existing.proxy.username;
              proxy.password = existing.proxy.password;
            }
          }
        }
      }
      const profile: StoredProfile = {
        tenantId: input.tenantId === undefined ? normalizeTenant(existing?.tenantId) : validated.tenantId,
        name: validated.name,
        startUrl: validated.startUrl,
        runtime: validated.runtime,
        proxy,
        id: existing?.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const nextProfiles = new Map(this.profiles);
      nextProfiles.set(profile.id, profile);
      await this.persist(nextProfiles);
      this.profiles = nextProfiles;
      return toPublicProfile(profile);
    });
  }

  /** Bulk endpoint creation commits one encrypted snapshot after validating every item. */
  async saveMany(inputs: ProfileInput[]): Promise<BrowserProfile[]> {
    if (!Array.isArray(inputs) || inputs.length > 100) throw new Error("Import at most 100 profiles.");
    await this.initialize();
    return this.withMutation(async () => {
      const validated = inputs.map(validateInput);
      const now = new Date().toISOString();
      const created: StoredProfile[] = validated.map(({ proxy, ...input }) => ({
        ...input, proxy: proxy ? { protocol: proxy.protocol, host: proxy.host, port: proxy.port, ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}) } : null,
        id: randomUUID(), createdAt: now, updatedAt: now,
      }));
      const next = new Map(this.profiles);
      for (const profile of created) next.set(profile.id, profile);
      await this.persist(next); this.profiles = next;
      return created.map(toPublicProfile);
    });
  }

  async removeAndQueuePurge(id: string): Promise<void> {
    await this.initialize();
    return this.withMutation(async () => {
      if (!this.profiles.has(id)) throw new Error("The requested profile does not exist.");
      const nextProfiles = new Map(this.profiles);
      const nextPurges = new Set(this.pendingPurges);
      nextProfiles.delete(id);
      nextPurges.add(id);
      await this.persist(nextProfiles, nextPurges);
      this.profiles = nextProfiles;
      this.pendingPurges = nextPurges;
    });
  }

  async getPendingPurges(): Promise<string[]> {
    await this.initialize();
    return [...this.pendingPurges];
  }

  async completePurge(id: string): Promise<void> {
    await this.initialize();
    return this.withMutation(async () => {
      if (!this.pendingPurges.has(id)) return;
      const nextPurges = new Set(this.pendingPurges);
      nextPurges.delete(id);
      await this.persist(this.profiles, nextPurges);
      this.pendingPurges = nextPurges;
    });
  }

  async hasPendingCleanup(): Promise<boolean> {
    await this.initialize();
    return this.pendingPurges.size > 0;
  }

  async getProxyCredentials(id: string): Promise<ProxyCredentials | null> {
    await this.initialize();
    const proxy = this.profiles.get(id)?.proxy;
    return proxy?.username && proxy.password
      ? { username: proxy.username, password: proxy.password }
      : null;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.load();
    await this.initialization;
  }

  private async load(): Promise<void> {
    await mkdir(app.getPath("userData"), { recursive: true });
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      throw new Error(
        "Secure OS-backed storage is unavailable. Set up a supported Linux keyring (GNOME Keyring or KWallet) before using Platypus Browser.",
      );
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("OS-backed encryption is unavailable; profile data was not loaded.");
    }

    let contents: string;
    let wasEncrypted = false;
    let shouldReEncrypt = false;
    let legacyPath: string | null = null;
    try {
      let file: Buffer;
      try {
        file = await readFile(this.filePath);
      } catch (error) {
        if (!isObject(error) || error.code !== "ENOENT") throw error;
        try {
          file = await readFile(this.legacyFilePath);
          legacyPath = this.legacyFilePath;
        } catch (legacyError) {
          if (isObject(legacyError) && legacyError.code === "ENOENT") {
            this.profiles = new Map();
            this.initialized = true;
            return;
          }
          throw legacyError;
        }
      }
      const serialized = file.toString("utf8");
      if (serialized.startsWith(encryptedFileHeader)) {
        wasEncrypted = true;
        const encrypted = Buffer.from(serialized.slice(encryptedFileHeader.length), "base64");
        if (encrypted.length === 0) throw new Error("Encrypted profile data is empty.");
        const decrypted = await safeStorage.decryptStringAsync(encrypted);
        contents = decrypted.result;
        shouldReEncrypt = decrypted.shouldReEncrypt;
      } else {
        contents = serialized;
      }
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        this.profiles = new Map();
        this.initialized = true;
        return;
      }
      throw new Error(
        `Could not decrypt or read saved profile data. No profile data was replaced. ${
          error instanceof Error ? error.message : "Unknown storage error."
        }`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error("Saved profile data is malformed and was left unchanged.");
    }
    const rawProfiles = Array.isArray(parsed)
      ? parsed
      : isObject(parsed) && Array.isArray(parsed.profiles) && Array.isArray(parsed.pendingPurges)
        ? parsed.profiles
        : null;
    const rawPendingPurges = Array.isArray(parsed)
      ? []
      : isObject(parsed) && Array.isArray(parsed.profiles) && Array.isArray(parsed.pendingPurges)
        ? parsed.pendingPurges
        : null;
    if (
      !rawProfiles ||
      !rawProfiles.every(isStoredProfile) ||
      !rawPendingPurges ||
      !rawPendingPurges.every(isProfileId)
    ) {
      throw new Error("Saved profile data is invalid and was left unchanged.");
    }
    const profiles = rawProfiles.filter(isStoredProfile);
    const pendingPurges = rawPendingPurges.filter(isProfileId);
    this.profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    this.pendingPurges = new Set(pendingPurges);
    if (!wasEncrypted || shouldReEncrypt || legacyPath) {
      await this.persist(this.profiles);
    }
    if (legacyPath || wasEncrypted) await this.removeLegacyPlaintext();
    this.initialized = true;
  }

  private async removeLegacyPlaintext(): Promise<void> {
    try {
      await unlink(this.legacyFilePath);
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") {
        throw new Error(
          "Encrypted profiles were saved, but the old plaintext profile file could not be removed. Close the app and remove profiles.json manually before continuing.",
        );
      }
    }
  }

  private async persist(
    profiles: Map<string, StoredProfile>,
    pendingPurges = this.pendingPurges,
  ): Promise<void> {
    const plaintext = `${JSON.stringify({
      profiles: [...profiles.values()],
      pendingPurges: [...pendingPurges],
    }, null, 2)}\n`;
    const encrypted = await safeStorage.encryptStringAsync(plaintext);
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${encryptedFileHeader}${encrypted.toString("base64")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
