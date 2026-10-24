import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface BaseImage { path: string; format: "raw" | "qcow2" }
export interface QemuConfig {
  qemuPath: string;
  qemuImgPath: string;
  baseImages: BaseImage[];
  accelerator: "whpx" | "kvm" | "hvf";
  cpus: number;
  memoryMiB: number;
  display: "sdl" | "gtk" | "cocoa" | "none";
  network: "restricted" | "user";
  bootTimeoutMs: number;
  shutdownTimeoutMs: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !/[\u0000-\u001f]/.test(value);
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isInteger(result) || result < min || result > max) throw new Error("Invalid QEMU resource or timeout setting.");
  return result;
}

export function validateQemuConfig(value: unknown, platform = process.platform): QemuConfig {
  if (!object(value) || !absolute(value.qemuPath) || !absolute(value.qemuImgPath) ||
    !Array.isArray(value.baseImages) || value.baseImages.length < 1 || value.baseImages.length > 16) {
    throw new Error("QEMU configuration requires absolute executable paths and 1–16 base images.");
  }
  if (value.machine !== undefined && value.machine !== "q35") {
    throw new Error("Use machine q35: native microvm does not publish the required SMBIOS tables.");
  }
  const accelerator = platform === "win32" ? "whpx" : platform === "linux" ? "kvm" : platform === "darwin" ? "hvf" : undefined;
  if (!accelerator || (value.accelerator !== undefined && value.accelerator !== accelerator)) {
    throw new Error("Configure the host hardware accelerator (WHPX on Windows, KVM on Linux, HVF on macOS). Software fallback is disabled.");
  }
  const display = value.display ?? (platform === "darwin" ? "cocoa" : "gtk");
  if (!["sdl", "gtk", "cocoa", "none"].includes(display as string)) throw new Error("Unsupported QEMU display.");
  const network = value.network ?? "restricted";
  if (network !== "restricted" && network !== "user") throw new Error("Unsupported QEMU network policy.");
  const baseImages = value.baseImages.map((image: unknown): BaseImage => {
    if (!object(image) || !absolute(image.path) || (image.format !== "raw" && image.format !== "qcow2")) throw new Error("Each base image requires an absolute path and an explicit raw/qcow2 format.");
    return { path: image.path, format: image.format };
  });
  return { qemuPath: value.qemuPath, qemuImgPath: value.qemuImgPath, baseImages, accelerator,
    cpus: integer(value.cpus, 2, 1, 64), memoryMiB: integer(value.memoryMiB, 2048, 256, 131072),
    display: display as QemuConfig["display"], network,
    bootTimeoutMs: integer(value.bootTimeoutMs, 30000, 1000, 300000),
    shutdownTimeoutMs: integer(value.shutdownTimeoutMs, 15000, 100, 120000) };
}

export async function requireRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("QEMU paths must reference regular, unlinked files.");
}

export async function loadQemuConfig(path: string): Promise<QemuConfig> {
  try {
    await requireRegularFile(path);
    if ((await lstat(path)).size > 65536) throw new Error("QEMU configuration is too large.");
    const config = validateQemuConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
    for (const file of [config.qemuPath, config.qemuImgPath, ...config.baseImages.map((image) => image.path)]) await requireRegularFile(file);
    return config;
  } catch (error) {
    throw new Error(`QEMU host configuration could not be loaded (${path}). ${error instanceof Error ? error.message : "Invalid configuration."}`);
  }
}
