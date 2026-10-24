import { validateProfile } from "@adios/hwid-profile-manager";
import type { HardwareProfile } from "@adios/hwid-profile-manager";
import type { QemuConfig } from "./config";

export function buildQemuArguments(config: QemuConfig, input: HardwareProfile, overlays: readonly string[], launchPath: string, controlAddress = "stdio", proxyPort?: number): string[] {
  if (proxyPort !== undefined && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) throw new Error("Invalid guest proxy gateway port.");
  const profile = validateProfile(input, input.workspaceId);
  const hardware = profile.hardware;
  if (overlays.length !== hardware.storage.length || config.baseImages.length !== overlays.length) throw new Error("Base image, overlay, and Adios disk counts must match.");
  const board = hardware.smbios;
  const machine = `q35,mem-merge=off${process.platform === "linux" ? ",dump-guest-core=off" : ""}`;
  const args = ["-no-user-config", "-nodefaults", "-no-reboot", "-machine", machine,
    "-accel", config.accelerator, "-m", String(config.memoryMiB), "-smp", String(config.cpus),
    "-name", `workspace-${profile.profileId}`, "-uuid", hardware.systemUuid,
    "-smbios", `type=0,vendor=${board.manufacturer},version=${board.version}`,
    "-smbios", `type=1,manufacturer=${board.manufacturer},product=${board.productName},version=${board.version},serial=${board.serialNumber},uuid=${hardware.systemUuid}`,
    "-smbios", `type=2,manufacturer=${board.manufacturer},product=${board.productName},version=${board.version},serial=${board.serialNumber}`,
    "-display", config.display, "-monitor", "none", "-serial", "none", "-parallel", "none", "-qmp", controlAddress, "-S",
    "-fw_cfg", `name=opt/org.platypus/workspace,file=${launchPath.replaceAll(",", ",,")}`,
    "-fw_cfg", `name=opt/org.platypus/machine-id,string=${hardware.machineGuid.replaceAll("-", "")}`];
  hardware.storage.forEach((disk, index) => {
    const base = config.baseImages[index]!;
    // Explicit read-only backing nodes prevent writes to shared base images and
    // prevent an overlay header from selecting another workspace's backing file.
    args.push("-blockdev", JSON.stringify({ driver: "file", "node-name": `basefile${index}`, filename: base.path, "read-only": true }),
      "-blockdev", JSON.stringify({ driver: base.format, "node-name": `base${index}`, file: `basefile${index}`, "read-only": true,
        ...(base.format === "qcow2" ? { backing: null } : {}) }),
      "-blockdev", JSON.stringify({ driver: "file", "node-name": `overlayfile${index}`, filename: overlays[index] }),
      "-blockdev", JSON.stringify({ driver: "qcow2", "node-name": `disk${index}`, file: `overlayfile${index}`, backing: `base${index}` }),
      "-device", `virtio-blk-pci,id=blk${index},drive=disk${index},serial=${disk.volumeSerial}${index === 0 ? ",bootindex=1" : ""}`);
  });
  hardware.network.forEach((nic, index) => args.push("-netdev", `user,id=net${index},ipv6=off${proxyPort || config.network === "restricted" ? ",restrict=on" : ""}${proxyPort && index === 0 ? `,guestfwd=tcp:10.0.2.100:1080-tcp:127.0.0.1:${proxyPort}` : ""}`,
    "-device", `virtio-net-pci,id=nic${index},netdev=net${index},mac=${nic.macAddress}`));
  if (config.display !== "none") args.push("-device", "virtio-vga", "-device", "qemu-xhci", "-device", "usb-kbd", "-device", "usb-tablet");
  return args;
}
