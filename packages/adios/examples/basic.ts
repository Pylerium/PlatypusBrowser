import { resolve } from "node:path";
import { HardwareProfileManager, MemoryKeyring, ProfileError } from "../src/index.js";

// Demonstration only: a production host should implement KeyProvider with its OS vault.
const encodedKey = process.env.ADIOS_ENCRYPTION_KEY;
if (!encodedKey || !/^[0-9a-fA-F]{64}$/.test(encodedKey)) {
  throw new Error("Set ADIOS_ENCRYPTION_KEY to a persistent, secret 32-byte key encoded as 64 hex characters.");
}
const key = Buffer.from(encodedKey, "hex");
const keys = new MemoryKeyring("v1", { v1: key });
key.fill(0);
delete process.env.ADIOS_ENCRYPTION_KEY;

try {
  const manager = new HardwareProfileManager({ directory: resolve(".adios"), keys });
  const workspace = manager.forWorkspace("example-workspace");
  try { await workspace.create({ storageCount: 2, networkCount: 1 }); } catch (error) {
    if (!(error instanceof ProfileError) || error.code !== "ALREADY_EXISTS") throw error;
  }
  const payload = await workspace.export();
  // Pass this scoped environment only to the process belonging to this workspace.
  // Descriptors are consumed explicitly; they do not override OS hardware APIs.
  const environment = await workspace.environment({ PATH: process.env.PATH });
  console.log(JSON.stringify({ workspaceId: payload.workspaceId, profileId: payload.profileId,
    environmentKeys: Object.keys(environment) }, null, 2));
} finally {
  keys.destroy();
}
