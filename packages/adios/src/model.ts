import { ProfileError } from "./errors.js";

export interface HardwareDescriptors {
  readonly smbios: {
    readonly manufacturer: string;
    readonly productName: string;
    readonly serialNumber: string;
    readonly version: string;
  };
  readonly storage: readonly {
    readonly name: string;
    readonly volumeSerial: string;
    readonly diskId: string;
  }[];
  readonly network: readonly {
    readonly name: string;
    readonly macAddress: string;
    readonly addressType: "locally-administered-unicast";
  }[];
  readonly systemUuid: string;
  readonly machineGuid: string;
}

export interface HardwareProfile {
  readonly schemaVersion: 1;
  readonly generatorVersion: 1;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly createdAt: string;
  readonly hardware: HardwareDescriptors;
}

export interface GenerationOptions {
  readonly storageCount?: number;
  readonly networkCount?: number;
}

export function validateWorkspaceId(id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new ProfileError("INVALID_INPUT", "Workspace ID must be 1–128 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit.");
  }
  return id;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9 ._-]{1,128}$/.test(value);
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Validate at every trust boundary and return a detached, immutable snapshot. */
export function validateProfile(value: unknown, expectedWorkspaceId: string): HardwareProfile {
  validateWorkspaceId(expectedWorkspaceId);
  const fail = (): never => { throw new ProfileError("INTEGRITY", "Hardware profile is invalid or belongs to another workspace."); };
  if (!record(value) || value.schemaVersion !== 1 || value.generatorVersion !== 1 ||
    value.workspaceId !== expectedWorkspaceId || !uuid(value.profileId) || typeof value.createdAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt || !record(value.hardware)) return fail();
  const hw = value.hardware;
  if (!record(hw.smbios) || !text(hw.smbios.manufacturer) || !text(hw.smbios.productName) ||
    !text(hw.smbios.serialNumber) || !text(hw.smbios.version) || !uuid(hw.systemUuid) || !uuid(hw.machineGuid) ||
    !Array.isArray(hw.storage) || hw.storage.length < 1 || hw.storage.length > 16 ||
    !Array.isArray(hw.network) || hw.network.length < 1 || hw.network.length > 16) return fail();
  const storage = hw.storage.map((drive: unknown) => {
    if (!record(drive) || !text(drive.name) || typeof drive.volumeSerial !== "string" ||
      !/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(drive.volumeSerial) || !uuid(drive.diskId)) return fail();
    return { name: drive.name, volumeSerial: drive.volumeSerial, diskId: drive.diskId };
  });
  const network = hw.network.map((nic: unknown) => {
    if (!record(nic) || !text(nic.name) || typeof nic.macAddress !== "string" ||
      !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(nic.macAddress) ||
      (parseInt(nic.macAddress.slice(0, 2), 16) & 3) !== 2 || nic.addressType !== "locally-administered-unicast") return fail();
    return { name: nic.name, macAddress: nic.macAddress, addressType: "locally-administered-unicast" as const };
  });
  for (const values of [storage.map((d) => d.name), storage.map((d) => d.diskId), storage.map((d) => d.volumeSerial),
    network.map((n) => n.name), network.map((n) => n.macAddress), [hw.systemUuid, hw.machineGuid, value.profileId]]) {
    if (new Set(values).size !== values.length) return fail();
  }
  return deepFreeze({ schemaVersion: 1, generatorVersion: 1, workspaceId: expectedWorkspaceId,
    profileId: value.profileId, createdAt: value.createdAt, hardware: {
      smbios: { manufacturer: hw.smbios.manufacturer, productName: hw.smbios.productName,
        serialNumber: hw.smbios.serialNumber, version: hw.smbios.version },
      storage, network, systemUuid: hw.systemUuid, machineGuid: hw.machineGuid,
    } });
}
