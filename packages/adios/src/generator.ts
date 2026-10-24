import { createHmac } from "node:crypto";
import { ProfileError } from "./errors.js";
import { deepFreeze, validateWorkspaceId } from "./model.js";
import type { GenerationOptions, HardwareDescriptors } from "./model.js";

export function generateHardwareDescriptors(workspaceId: string, seed: Uint8Array, options: GenerationOptions = {}): HardwareDescriptors {
  validateWorkspaceId(workspaceId);
  if (!(seed instanceof Uint8Array) || seed.byteLength !== 32) {
    throw new ProfileError("INVALID_INPUT", "Generation requires exactly 32 bytes of seed material.");
  }
  const counts = [options.storageCount ?? 1, options.networkCount ?? 1];
  for (const count of counts) if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new ProfileError("INVALID_INPUT", "Storage and network counts must be integers between 1 and 16.");
  }
  // Versioned, length-safe domain separation makes output stable and independent
  // of requested component counts and unrelated future descriptor additions.
  const bytes = (label: string) => createHmac("sha256", seed)
    .update(JSON.stringify(["adios-hardware", 1, workspaceId, label])).digest();
  const hex = (label: string, length: number) => bytes(label).toString("hex").slice(0, length).toUpperCase();
  const uuid = (label: string) => {
    const data = bytes(label).subarray(0, 16);
    data[6] = (data[6]! & 15) | 0x40;
    data[8] = (data[8]! & 63) | 0x80;
    const h = data.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  return deepFreeze({
    smbios: { manufacturer: "Adios Virtual Systems", productName: `Workspace Board ${hex("board-product", 8)}`,
      serialNumber: hex("board-serial", 24), version: "1.0" },
    storage: Array.from({ length: counts[0]! }, (_, index) => {
      const serial = hex(`volume-${index}`, 8);
      return { name: `disk${index}`, volumeSerial: `${serial.slice(0, 4)}-${serial.slice(4)}`, diskId: uuid(`disk-${index}`) };
    }),
    network: Array.from({ length: counts[1]! }, (_, index) => {
      const address = bytes(`nic-${index}`).subarray(0, 6);
      address[0] = (address[0]! | 2) & 0xfe;
      return { name: `nic${index}`, macAddress: address.toString("hex").match(/../g)!.join(":"),
        addressType: "locally-administered-unicast" as const };
    }),
    systemUuid: uuid("system-uuid"), machineGuid: uuid("machine-guid"),
  });
}
