import { randomBytes, randomUUID } from "node:crypto";
import { encryptProfile, decryptProfile } from "./crypto.js";
import type { KeyProvider } from "./crypto.js";
import { ProfileError } from "./errors.js";
import { createWorkspaceEnvironment, exportWorkspace } from "./exports.js";
import type { WorkspaceExports } from "./exports.js";
import { generateHardwareDescriptors } from "./generator.js";
import { validateProfile, validateWorkspaceId } from "./model.js";
import type { GenerationOptions, HardwareProfile } from "./model.js";
import { FileProfileStorage } from "./storage.js";

export interface ManagerOptions {
  readonly directory: string;
  readonly keys: KeyProvider;
  readonly lockTimeoutMs?: number;
}
export interface MaterializedExports {
  readonly workspaceId: string;
  readonly profileId: string;
  readonly statePath: string;
  readonly registryMockPath: string;
  readonly environmentPath: string;
}

/** Scoped operations for a long-lived external runtime. Do not nest normal manager calls for the same ID. */
export interface ExclusiveWorkspace {
  readonly workspaceId: string;
  load(): Promise<HardwareProfile>;
  create(options?: GenerationOptions): Promise<HardwareProfile>;
  purge(): Promise<boolean>;
}

export class HardwareProfileManager {
  private readonly storage: FileProfileStorage;
  private readonly keys: KeyProvider;
  constructor(options: ManagerOptions) {
    if (!options?.keys || typeof options.keys.activeKey !== "function" || typeof options.keys.keyById !== "function") {
      throw new ProfileError("INVALID_INPUT", "An encryption key provider is required.");
    }
    this.keys = options.keys;
    this.storage = new FileProfileStorage(options.directory, options.lockTimeoutMs);
  }

  /** No process-global active workspace: each handle is permanently bound to one ID. */
  forWorkspace(workspaceId: string): WorkspaceContext {
    return new WorkspaceContext(this, validateWorkspaceId(workspaceId));
  }

  async create(workspaceId: string, options: GenerationOptions = {}): Promise<HardwareProfile> {
    validateWorkspaceId(workspaceId);
    // Snapshot caller-owned options before awaiting locks.
    const generation = { ...options };
    return this.storage.withLock(workspaceId, () => this.createUnlocked(workspaceId, generation));
  }

  private async createUnlocked(workspaceId: string, generation: GenerationOptions): Promise<HardwareProfile> {
      if (await this.storage.read(workspaceId)) throw new ProfileError("ALREADY_EXISTS", "Workspace already has a hardware profile.");
      const seed = randomBytes(32);
      let hardware;
      try { hardware = generateHardwareDescriptors(workspaceId, seed, generation); } finally { seed.fill(0); }
      const profile = validateProfile({ schemaVersion: 1, generatorVersion: 1, workspaceId,
        profileId: randomUUID(), createdAt: new Date().toISOString(), hardware }, workspaceId);
      // Obtain and validate the key before creating any workspace records.
      const encoded = await encryptProfile(profile, this.keys);
      await this.storage.ensureWorkspace(workspaceId);
      await this.storage.write(workspaceId, "profile.enc", encoded);
      return profile;
  }

  /** Hold the same cross-process lock for an entire VM lifetime, including its startup and teardown. */
  async withExclusiveWorkspace<T>(workspaceId: string, action: (workspace: ExclusiveWorkspace) => Promise<T>): Promise<T> {
    return this.storage.withLock(workspaceId, async () => {
      let accepting = true;
      let queue = Promise.resolve();
      const run = <R>(operation: () => Promise<R>): Promise<R> => {
        if (!accepting) return Promise.reject(new ProfileError("INVALID_INPUT", "Workspace lease has ended."));
        const result = queue.then(operation);
        queue = result.then(() => undefined, () => undefined);
        return result;
      };
      const workspace: ExclusiveWorkspace = Object.freeze({ workspaceId,
        load: () => run(() => this.readUnlocked(workspaceId)),
        create: (options: GenerationOptions = {}) => {
          const snapshot = { ...options };
          return run(() => this.createUnlocked(workspaceId, snapshot));
        },
        purge: () => run(() => this.storage.purge(workspaceId)),
      });
      try { return await action(workspace); } finally { accepting = false; await queue; }
    });
  }

  private async readUnlocked(workspaceId: string): Promise<HardwareProfile> {
    const encoded = await this.storage.read(workspaceId);
    if (!encoded) throw new ProfileError("NOT_FOUND", "Workspace hardware profile does not exist.");
    return decryptProfile(encoded, workspaceId, this.keys);
  }

  async load(workspaceId: string): Promise<HardwareProfile> {
    return this.storage.withLock(workspaceId, () => this.readUnlocked(workspaceId));
  }

  async export(workspaceId: string): Promise<WorkspaceExports> {
    return this.storage.withLock(workspaceId, async () => exportWorkspace(await this.readUnlocked(workspaceId), workspaceId));
  }

  /** Re-encrypt without changing descriptors. Retain old keys until all records migrate. */
  async rotateEncryption(workspaceId: string): Promise<void> {
    return this.storage.withLock(workspaceId, async () => {
      const profile = await this.readUnlocked(workspaceId);
      await this.storage.write(workspaceId, "profile.enc", await encryptProfile(profile, this.keys));
    });
  }

  /** Explicit opt-in to plaintext files for cooperating local processes. */
  async materialize(workspaceId: string): Promise<MaterializedExports> {
    return this.storage.withLock(workspaceId, async () => {
      const payload = exportWorkspace(await this.readUnlocked(workspaceId), workspaceId);
      const statePath = await this.storage.write(workspaceId, "state.json", payload.stateJson);
      const registryMockPath = await this.storage.write(workspaceId, "registry-mock.json", payload.registryMockJson);
      const environmentPath = await this.storage.write(workspaceId, "environment.json", JSON.stringify(payload.environment, null, 2) + "\n");
      return Object.freeze({ workspaceId, profileId: payload.profileId, statePath, registryMockPath, environmentPath });
    });
  }

  /** Idempotent; errors remain visible so the caller can retry incomplete cleanup. */
  async purge(workspaceId: string): Promise<boolean> {
    return this.storage.withLock(workspaceId, () => this.storage.purge(workspaceId));
  }
}

export class WorkspaceContext {
  constructor(private readonly manager: HardwareProfileManager, readonly workspaceId: string) {
    validateWorkspaceId(workspaceId);
    Object.freeze(this);
  }
  create(options?: GenerationOptions): Promise<HardwareProfile> { return this.manager.create(this.workspaceId, options); }
  load(): Promise<HardwareProfile> { return this.manager.load(this.workspaceId); }
  export(): Promise<WorkspaceExports> { return this.manager.export(this.workspaceId); }
  materialize(): Promise<MaterializedExports> { return this.manager.materialize(this.workspaceId); }
  purge(): Promise<boolean> { return this.manager.purge(this.workspaceId); }
  rotateEncryption(): Promise<void> { return this.manager.rotateEncryption(this.workspaceId); }
  async environment(base: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
    const snapshot = { ...base };
    return createWorkspaceEnvironment(await this.export(), snapshot);
  }
}
