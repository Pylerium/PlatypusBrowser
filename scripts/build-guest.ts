import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, stat, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";
import { QmpClient } from "../src/main/qemu/qmp";
import { launchProcess, runTool } from "../src/main/qemu/process";

const root = resolve("vm-images");
const work = join(root, "build");
const image = join(root, "debian-13-browser-v1.qcow2");
const disk = join(work, "provisioning.qcow2");
const qemu = process.env.QEMU_TEST_BINARY ?? "C:/Program Files/qemu/qemu-system-x86_64.exe";
const img = process.env.QEMU_TEST_IMG ?? "C:/Program Files/qemu/qemu-img.exe";
const accelerator = process.platform === "win32" ? "whpx" : process.platform === "darwin" ? "hvf" : "kvm";
await mkdir(work, { recursive: true });
if (await stat(image).then(() => true, () => false)) throw new Error("Base image already exists; build a new version instead of replacing live backing images.");
await build({ entryPoints: ["src/shared/runtime.ts"], outfile: join(work, "runtime.iife.js"), bundle: true, platform: "browser", format: "iife", globalName: "PlatypusRuntime" });
const files: { path: string; permissions: string; encoding: string; content: string }[] = [];
async function guestFile(source: string, target: string, permissions = "0755") {
  files.push({ path: target, permissions, encoding: "b64", content: (await readFile(source)).toString("base64") });
}
function textFile(path: string, content: string, permissions = "0644") {
  files.push({ path, permissions, encoding: "b64", content: Buffer.from(content).toString("base64") });
}
await guestFile("guest/apply-workspace.py", "/usr/local/lib/platypus/apply-workspace.py");
await guestFile("guest/browser-session.py", "/usr/local/bin/platypus-browser-session");
await guestFile("guest/machine-id-hook", "/etc/initramfs-tools/hooks/platypus-machine-id");
await guestFile("guest/machine-id-init", "/etc/initramfs-tools/scripts/init-bottom/platypus-machine-id");
await guestFile("guest/provision.sh", "/usr/local/sbin/platypus-provision-image");
await guestFile("guest/network.network", "/etc/systemd/network/10-platypus.network", "0644");
await guestFile(join(work, "runtime.iife.js"), "/usr/local/share/platypus/runtime.iife.js", "0644");
textFile("/etc/systemd/system/platypus-prepare.service", `[Unit]\nDescription=Apply isolated Platypus workspace identity\nAfter=local-fs.target systemd-modules-load.service\nBefore=display-manager.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/lib/platypus/apply-workspace.py\nRemainAfterExit=yes\nStandardOutput=journal+console\nStandardError=journal+console\n[Install]\nWantedBy=multi-user.target\n`);
textFile("/etc/systemd/system/lightdm.service.d/platypus.conf", "[Unit]\nRequires=platypus-prepare.service\nAfter=platypus-prepare.service\n");
textFile("/etc/lightdm/lightdm.conf.d/50-platypus.conf", "[Seat:*]\nautologin-user=workspace\nautologin-user-timeout=0\nuser-session=openbox\nautologin-session=openbox\nxserver-command=X -nolisten tcp\n");
textFile("/etc/modules-load.d/platypus.conf", "qemu_fw_cfg\nvirtio_gpu\n");
const cloud = {
  hostname: "platypus-image", manage_etc_hosts: true, disable_root: true, ssh_pwauth: false,
  users: [{ name: "workspace", gecos: "Platypus workspace", shell: "/bin/bash", lock_passwd: true, groups: ["video", "audio", "render"] }],
  package_update: true, package_upgrade: false,
  apt: { conf: 'APT::Install-Recommends "false";\nAPT::Install-Suggests "false";\nAcquire::Retries "5";\n' },
  packages: ["linux-image-amd64", "xserver-xorg-core", "xserver-xorg-input-libinput", "x11-xserver-utils", "lightdm", "lightdm-gtk-greeter",
    "openbox", "chromium", "chromium-sandbox", "dbus-x11", "fonts-dejavu-core", "fonts-noto-color-emoji", "python3", "gdisk", "qemu-guest-agent", "ca-certificates"],
  write_files: files, runcmd: [["/usr/local/sbin/platypus-provision-image"]],
};
await writeFile(join(work, "user-data"), "#cloud-config\n" + JSON.stringify(cloud, null, 2) + "\n");
await writeFile(join(work, "meta-data"), "instance-id: platypus-browser-image-v1\nlocal-hostname: platypus-image\n");
const python = process.platform === "win32" ? resolve(".vm-build-tools/Scripts/python.exe") : resolve(".vm-build-tools/bin/python");
await runTool(launchProcess, python, [resolve("scripts/make-cloud-seed.py"), work]);
if (!(await stat(disk).then(() => true, () => false))) {
  console.log("Creating a standalone 16 GiB provisioning disk...");
  await runTool(launchProcess, img, ["convert", "-f", "qcow2", "-O", "qcow2", join(work, "debian-13-generic-amd64.qcow2"), disk], 120000);
  await runTool(launchProcess, img, ["resize", disk, "16G"]);
}
const serial = join(work, "provisioning.log");
const args = ["-machine", "q35", "-accel", accelerator, "-m", "4096", "-smp", "2", "-display", "none", "-no-reboot",
  "-drive", `file=${disk},format=qcow2,if=virtio,discard=unmap`, "-drive", `file=${join(work, "seed.iso")},format=raw,if=virtio,readonly=on`,
  "-netdev", "user,id=net0,ipv6=off", "-device", "virtio-net-pci,netdev=net0", "-serial", `file:${serial}`, "-monitor", "none", "-qmp", "stdio", "-S"];
console.log(`Provisioning Debian desktop/Chromium with ${accelerator}; serial log: ${serial}`);
const child = launchProcess(qemu, args);
await writeFile(join(work, "process.json"), JSON.stringify({ builderPid: process.pid, qemuPid: child.pid, createdAt: new Date().toISOString() }));
let closed = false;
let exitCode: number | null = null;
let stderr = "";
const exit = new Promise<void>((resolve) => child.once("close", (code) => { closed = true; exitCode = code; resolve(); }));
child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384); });
const qmp = new QmpClient(child, 30000, () => undefined);
try {
  await qmp.initialize(); await qmp.command("cont");
  const deadline = Date.now() + 45 * 60 * 1000;
  let last = 0;
  while (!closed) {
    if (Date.now() > deadline) throw new Error("Guest provisioning exceeded 45 minutes.");
    await setTimeout(3000);
    const log = await readFile(serial, "utf8").catch(() => "");
    if (log.includes("PLATYPUS_IMAGE_BUILD_FAILED")) throw new Error("Guest provisioning failed; inspect provisioning.log.");
    if (Date.now() - last > 25000) { console.log(log.trim().split(/\r?\n/).filter(Boolean).slice(-2).join("\n").slice(-600)); last = Date.now(); }
  }
  await exit;
  const log = await readFile(serial, "utf8");
  assert.equal(exitCode, 0, stderr);
  assert.ok(log.includes("PLATYPUS_IMAGE_BUILD_COMPLETE"), "Guest did not complete image preparation.");
  console.log("Guest provisioning completed. Compacting the sealed base...");
  const temporary = image + ".tmp";
  await runTool(launchProcess, img, ["convert", "-c", "-f", "qcow2", "-O", "qcow2", disk, temporary], 600000);
  await rename(temporary, image);
  const info = JSON.parse(await runTool(launchProcess, img, ["info", "--output=json", image]));
  assert.equal(info.format, "qcow2"); assert.equal(info["backing-filename"], undefined);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(image)) hash.update(chunk);
  await writeFile(image + ".json", JSON.stringify({ version: 1, builtAt: new Date().toISOString(), source: JSON.parse(await readFile(join(work, "source.json"), "utf8")), sha256: hash.digest("hex"), virtualSize: info["virtual-size"] }, null, 2));
  console.log("Browser base image ready: " + image);
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (!closed) { await qmp.command("quit").catch(() => undefined); if (!closed) child.kill("SIGKILL"); await exit; }
  qmp.close();
}
