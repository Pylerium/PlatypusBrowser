import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { hasCode, ProfileError } from "./errors.js";
import { validateWorkspaceId } from "./model.js";

export type ExportFile = "state.json" | "registry-mock.json" | "environment.json";
const knownFile = /^(profile\.enc|settings\.enc|state\.json|registry-mock\.json|environment\.json)(\.[0-9a-f-]{36}\.tmp)?$/;

/** Dedicated private local directory. Its ancestors must be owned by a trusted user. */
export class FileProfileStorage {
  private root: string;
  private initialization: Promise<void> | undefined;
  constructor(directory: string, private readonly lockTimeoutMs = 5000, private readonly maxFileBytes = 65536) {
    if (typeof directory !== "string" || !directory || !isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 65536 || maxFileBytes > 16 * 1024 * 1024 ||
      !Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 300000) {
      throw new ProfileError("INVALID_INPUT", "Use an absolute, dedicated storage directory and a lock timeout of 1–300000 milliseconds.");
    }
    this.root = resolve(directory);
  }

  private async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.assertDirectory(this.root);
      this.root = await realpath(this.root);
      if (process.platform !== "win32") await chmod(this.root, 0o700);
      for (const name of ["workspaces", "locks"]) {
        const path = join(this.root, name);
        await mkdir(path, { recursive: true, mode: 0o700 });
        await this.assertDirectory(path);
        if (process.platform !== "win32") await chmod(path, 0o700);
      }
    })();
    return this.initialization;
  }

  private async assertDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProfileError("UNSAFE_PATH", "Profile storage contains an unexpected directory or symbolic link.");
  }

  private digest(workspaceId: string): string {
    validateWorkspaceId(workspaceId);
    return createHash("sha256").update(workspaceId, "utf8").digest("hex");
  }

  private workspacePath(workspaceId: string): string {
    const path = join(this.root, "workspaces", this.digest(workspaceId));
    // Exact parent check before every operation, including deletion.
    if (dirname(path) !== join(this.root, "workspaces")) throw new ProfileError("UNSAFE_PATH", "Workspace path escaped storage.");
    return path;
  }

  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  /** All operations, including reads and exports, serialize across processes. */
  async withLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const digest = this.digest(workspaceId);
    await this.initialize();
    await this.assertDirectory(this.root);
    await this.assertDirectory(join(this.root, "workspaces"));
    await this.assertDirectory(join(this.root, "locks"));
    const lockPath = join(this.root, "locks", `${digest}.lock`);
    const deadline = performance.now() + this.lockTimeoutMs;
    while (true) {
      let handle;
      try { handle = await open(lockPath, "wx", 0o600); } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const info = await lstat(lockPath).catch((failure: unknown) => {
          if (hasCode(failure, "ENOENT")) return null;
          throw failure;
        });
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) {
          throw new ProfileError("UNSAFE_PATH", "Unexpected workspace lock path.");
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ProfileError("LOCK_TIMEOUT", "Workspace is locked. A crashed writer may require explicit lock recovery.");
        await setTimeout(Math.min(25, remaining));
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }));
        await handle.sync();
        return await operation();
      } finally {
        await handle.close();
        await unlink(lockPath);
      }
    }
  }

  async ensureWorkspace(workspaceId: string): Promise<void> {
    const path = this.workspacePath(workspaceId);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await this.assertDirectory(path);
    if ((await readdir(path)).length !== 0) {
      throw new ProfileError("INTEGRITY", "Orphaned workspace files require explicit purge before profile creation.");
    }
  }

  private async existingWorkspace(workspaceId: string): Promise<string | null> {
    const path = this.workspacePath(workspaceId);
    try { await this.assertDirectory(path); } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    return path;
  }

  private async regularFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > this.maxFileBytes) {
      throw new ProfileError("UNSAFE_PATH", "Unexpected profile file type, link count, or size.");
    }
  }

  async read(workspaceId: string, name: "profile.enc" | "settings.enc" = "profile.enc"): Promise<Buffer | null> {
    const directory = await this.existingWorkspace(workspaceId);
    if (!directory) return null;
    const path = join(directory, name);
    try { await this.regularFile(path); } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > this.maxFileBytes) throw new ProfileError("UNSAFE_PATH", "Unsafe profile file.");
      const buffer = Buffer.alloc(this.maxFileBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > this.maxFileBytes) throw new ProfileError("INTEGRITY", "Encrypted profile exceeds the size limit.");
      return buffer.subarray(0, offset);
    } finally { await file.close(); }
  }

  async write(workspaceId: string, name: "profile.enc" | "settings.enc" | ExportFile, contents: Buffer | string): Promise<string> {
    if (!knownFile.test(name) || name.endsWith(".tmp")) throw new ProfileError("INVALID_INPUT", "Invalid storage filename.");
    if (Buffer.byteLength(contents) > this.maxFileBytes) throw new ProfileError("INVALID_INPUT", "Profile export exceeds the size limit.");
    const directory = await this.existingWorkspace(workspaceId);
    if (!directory) throw new ProfileError("NOT_FOUND", "Workspace profile does not exist.");
    const target = join(directory, name);
    try { await this.regularFile(target); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      // Persist the directory entry on POSIX. Windows does not allow directory fsync.
      await this.syncDirectory(directory);
      return target;
    } finally {
      await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
    }
  }

  /** Removes only module-owned files. Overwrite is best effort at the media level. */
  async purge(workspaceId: string): Promise<boolean> {
    const directory = await this.existingWorkspace(workspaceId);
    if (!directory) return false;
    const entries = await readdir(directory);
    for (const name of entries) {
      if (!knownFile.test(name)) throw new ProfileError("UNSAFE_PATH", "Workspace contains an unrecognized file; purge refused.");
      await this.regularFile(join(directory, name));
    }
    // Remove plaintext exports first; retain the encrypted record until last so
    // a failed cleanup remains retryable without silently regenerating identity.
    entries.sort((a, b) => Number(a === "profile.enc") - Number(b === "profile.enc"));
    for (const name of entries) {
      const path = join(directory, name);
      const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > this.maxFileBytes) throw new ProfileError("UNSAFE_PATH", "Unsafe purge target.");
        const zeros = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < zeros.length) {
          const { bytesWritten } = await handle.write(zeros, offset, zeros.length - offset, offset);
          if (bytesWritten === 0) throw new Error("Could not overwrite workspace file.");
          offset += bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      await unlink(path);
      await this.syncDirectory(directory);
    }
    await rmdir(directory);
    await this.syncDirectory(dirname(directory));
    return true;
  }
}
