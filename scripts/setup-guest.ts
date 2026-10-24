import { spawn } from "node:child_process";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateQemuConfig } from "../src/main/qemu/config";

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${executable} failed (${code}).`)));
  });
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const python = process.platform === "win32" ? resolve(".vm-build-tools/Scripts/python.exe") : resolve(".vm-build-tools/bin/python");
if (!(await exists(python))) await run("python", ["-m", "venv", resolve(".vm-build-tools")]);
await run(python, ["-m", "pip", "install", "-r", resolve("scripts/guest-requirements.txt")]);
await run(python, [resolve("scripts/download-guest.py")]);
const tsx = resolve("node_modules/tsx/dist/cli.mjs");
const image = resolve("vm-images/debian-13-browser-v1.qcow2");
if (!(await exists(image))) await run(process.execPath, [tsx, "scripts/build-guest.ts"]);
await run(process.execPath, [tsx, "scripts/verify-guest.ts"]);
const configPath = process.env.PLATYPUS_QEMU_CONFIG ?? (process.platform === "win32"
  ? join(process.env.APPDATA!, "platypus-browser", "qemu.json")
  : process.platform === "darwin" ? join(process.env.HOME!, "Library", "Application Support", "platypus-browser", "qemu.json")
    : join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME!, ".config"), "platypus-browser", "qemu.json"));
const config = { machine: "q35", qemuPath: process.env.QEMU_TEST_BINARY ?? "C:/Program Files/qemu/qemu-system-x86_64.exe",
  qemuImgPath: process.env.QEMU_TEST_IMG ?? "C:/Program Files/qemu/qemu-img.exe", baseImages: [{ path: image, format: "qcow2" }],
  accelerator: process.platform === "win32" ? "whpx" : process.platform === "darwin" ? "hvf" : "kvm", cpus: 2, memoryMiB: 2048,
  display: process.platform === "darwin" ? "cocoa" : "gtk", network: "user", bootTimeoutMs: 30000, shutdownTimeoutMs: 15000 };
validateQemuConfig(config);
await mkdir(dirname(configPath), { recursive: true });
if (await exists(configPath)) {
  const previous = JSON.parse(await readFile(configPath, "utf8"));
  if (previous.baseImages?.[0]?.path !== image) throw new Error(`Existing configuration was preserved. Select the new image manually in ${configPath}`);
  console.log("Existing QEMU configuration retained: " + configPath);
} else {
  const temporary = configPath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await link(temporary, configPath);
  } finally { await unlink(temporary); }
  console.log("QEMU host configuration created: " + configPath);
}
console.log("Ready: launch a workspace in PlatypusBrowser. Existing base images and workspace overlays were not replaced.");
