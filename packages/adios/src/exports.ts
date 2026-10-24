import { deepFreeze, validateProfile } from "./model.js";
import type { HardwareProfile } from "./model.js";

export interface WorkspaceExports {
  readonly workspaceId: string;
  readonly profileId: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stateJson: string;
  /** JSON input for a cooperating registry adapter; never import into the host registry. */
  readonly registryMockJson: string;
}

export function exportWorkspace(profile: HardwareProfile, expectedWorkspaceId: string): WorkspaceExports {
  const validated = validateProfile(profile, expectedWorkspaceId);
  const hw = validated.hardware;
  const environment = {
    ADIOS_WORKSPACE_ID: validated.workspaceId, ADIOS_PROFILE_ID: validated.profileId,
    ADIOS_SYSTEM_UUID: hw.systemUuid, ADIOS_MACHINE_GUID: hw.machineGuid,
    ADIOS_BOARD_MANUFACTURER: hw.smbios.manufacturer, ADIOS_BOARD_PRODUCT: hw.smbios.productName,
    ADIOS_BOARD_SERIAL: hw.smbios.serialNumber, ADIOS_BOARD_VERSION: hw.smbios.version,
    ADIOS_STORAGE_JSON: JSON.stringify(hw.storage), ADIOS_NETWORK_JSON: JSON.stringify(hw.network),
  };
  return deepFreeze({ workspaceId: validated.workspaceId, profileId: validated.profileId, environment,
    stateJson: JSON.stringify(validated, null, 2) + "\n",
    registryMockJson: JSON.stringify({ format: "adios-registry-mock", version: 1, workspaceId: validated.workspaceId,
      profileId: validated.profileId, keys: {
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography": { MachineGuid: { type: "REG_SZ", value: hw.machineGuid } },
        "HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\BIOS": {
          BaseBoardManufacturer: { type: "REG_SZ", value: hw.smbios.manufacturer },
          BaseBoardProduct: { type: "REG_SZ", value: hw.smbios.productName },
          BaseBoardSerialNumber: { type: "REG_SZ", value: hw.smbios.serialNumber },
          BaseBoardVersion: { type: "REG_SZ", value: hw.smbios.version },
        },
      } }, null, 2) + "\n",
  });
}

/** Build an explicit child-process environment without mutating process.env. */
export function createWorkspaceEnvironment(exports: WorkspaceExports, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  // Windows environment variable names are case-insensitive.
  for (const [key, value] of Object.entries(base)) if (!key.toUpperCase().startsWith("ADIOS_")) clean[key] = value;
  return { ...clean, ...exports.environment };
}
