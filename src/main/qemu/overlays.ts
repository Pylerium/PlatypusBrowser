import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { validateWorkspaceId } from "@adios/hwid-profile-manager";
import type { HardwareProfile } from "@adios/hwid-profile-manager";
import type { BrowserProfile } from "../../shared/types";
import { requireRegularFile } from "./config";
import type { QemuConfig } from "./config";
import { runTool } from "./process";
import type { LaunchProcess } from "./process";

const absent = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const allowedFile = /^(binding\.json|launch\.json|disk-\d+\.qcow2)(\.[0-9a-f-]{36}\.tmp)?$/;

/** All workspace calls must execute inside the Adios exclusive lease. */
export class OverlayStore {
  private root: string;
  constructor(directory: string, private readonly launch: LaunchProcess) {
    if (!isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) throw new Error("VM storage requires a dedicated absolute directory.");
    this.root = resolve(directory);
  }

  private async directory(workspaceId: string, create: boolean): Promise<string | undefined> {
    validateWorkspaceId(workspaceId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Unsafe VM storage root.");
    this.root = await realpath(this.root);
    const path = join(this.root, createHash("sha256").update(workspaceId).digest("hex"));
    if (dirname(path) !== this.root) throw new Error("VM path escaped its storage root.");
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path).catch((error: unknown) => { if (absent(error)) return undefined; throw error; });
    if (!info) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe VM workspace directory.");
    return path;
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    try { await requireRegularFile(path); } catch (error) { if (!absent(error)) throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      await this.syncDirectory(dirname(path));
    } finally {
      await unlink(temporary).catch((error: unknown) => { if (!absent(error)) throw error; });
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async wipe(path: string): Promise<void> {
    await requireRegularFile(path);
    const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe VM purge target.");
      const zeros = Buffer.alloc(1024 * 1024);
      for (let offset = 0; offset < info.size;) {
        const length = Math.min(zeros.length, info.size - offset);
        const { bytesWritten } = await handle.write(zeros, 0, length, offset);
        if (bytesWritten === 0) throw new Error("VM overlay overwrite failed.");
        offset += bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
    await unlink(path);
    await this.syncDirectory(dirname(path));
  }

  async clearLaunchManifest(workspaceId: string): Promise<void> {
    const directory = await this.directory(workspaceId, false);
    if (!directory) return;
    try { await this.wipe(join(directory, "launch.json")); } catch (error) { if (!absent(error)) throw error; }
  }

  private async inspect(config: QemuConfig, path: string): Promise<Record<string, unknown>> {
    const result: unknown = JSON.parse(await runTool(this.launch, config.qemuImgPath, ["info", "--output=json", path]));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid qemu-img inspection output.");
    return result as Record<string, unknown>;
  }

  async prepare(config: QemuConfig, profile: HardwareProfile, browser: BrowserProfile): Promise<{ overlays: string[]; launchPath: string }> {
    if (config.baseImages.length !== profile.hardware.storage.length) throw new Error("The Adios disk count does not match the configured base images.");
    const directory = (await this.directory(profile.workspaceId, true))!;
    const bases = [];
    for (const base of config.baseImages) {
      await requireRegularFile(base.path);
      const info = await lstat(base.path);
      const inspected = await this.inspect(config, base.path);
      if (inspected.format !== base.format || inspected["backing-filename"] || JSON.stringify(inspected["format-specific"] ?? {}).includes('"data-file"')) {
        throw new Error("Base images must match their configured format and contain no backing chain or external data file.");
      }
      bases.push({ path: await realpath(base.path), format: base.format, size: info.size, mtimeMs: info.mtimeMs });
    }
    const binding = { version: 1, workspaceId: profile.workspaceId, profileId: profile.profileId, bases };
    const bindingPath = join(directory, "binding.json");
    let existing: string | undefined;
    try {
      await requireRegularFile(bindingPath);
      if ((await lstat(bindingPath)).size > 65536) throw new Error("Oversized VM binding.");
      existing = await readFile(bindingPath, "utf8");
    } catch (error) { if (!absent(error)) throw error; }
    if (existing !== undefined) {
      if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(binding)) throw new Error("VM overlay binding or base image changed. Restore the original base or explicitly purge this workspace.");
    } else {
      if ((await readdir(directory)).length !== 0) throw new Error("Orphaned VM state requires explicit purge.");
      await this.atomicWrite(bindingPath, JSON.stringify(binding));
    }
    const overlays: string[] = [];
    for (let index = 0; index < bases.length; index++) {
      const path = join(directory, `disk-${index}.qcow2`);
      let exists = true;
      try { await requireRegularFile(path); } catch (error) { if (!absent(error)) throw error; exists = false; }
      if (!exists) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await runTool(this.launch, config.qemuImgPath, ["create", "-f", "qcow2", "-F", bases[index]!.format, "-b", bases[index]!.path, temporary]);
          await requireRegularFile(temporary);
          if (process.platform !== "win32") await chmod(temporary, 0o600);
          const image = await open(temporary, "r+");
          try { await image.sync(); } finally { await image.close(); }
          await rename(temporary, path);
          await this.syncDirectory(directory);
        } finally {
          await unlink(temporary).catch((error: unknown) => { if (!absent(error)) throw error; });
        }
      }
      const inspected = await this.inspect(config, path);
      const backing = inspected["full-backing-filename"] ?? inspected["backing-filename"];
      if (inspected.format !== "qcow2" || typeof backing !== "string" || await realpath(backing) !== bases[index]!.path ||
        inspected["backing-filename-format"] !== bases[index]!.format || JSON.stringify(inspected["format-specific"] ?? {}).includes('"data-file"')) {
        throw new Error("Overlay does not reference the expected read-only base image.");
      }
      overlays.push(path);
    }
    const launchPath = join(directory, "launch.json");
    await this.atomicWrite(launchPath, JSON.stringify({ format: "platypus-workspace", version: 1,
      workspaceId: profile.workspaceId, profileId: profile.profileId, hardware: profile.hardware,
      browser: { startUrl: browser.startUrl, runtime: browser.runtime ?? null } }));
    return { overlays, launchPath };
  }

  async purge(workspaceId: string): Promise<void> {
    const directory = await this.directory(workspaceId, false);
    if (!directory) return;
    const files = await readdir(directory);
    // Preflight every target before overwriting any file. No recursive deletion.
    for (const name of files) {
      if (!allowedFile.test(name)) throw new Error("VM purge refused an unknown file.");
      await requireRegularFile(join(directory, name));
    }
    for (const name of files) {
      const path = join(directory, name);
      await this.wipe(path);
    }
    await rmdir(directory);
    await this.syncDirectory(this.root);
  }
}
