import { HardwareProfileManager, MemoryKeyring, ProfileError } from "../src/index.js";

const [directory, workspaceId, key] = process.argv.slice(2);
if (!directory || !workspaceId || !key) throw new Error("Missing worker arguments.");
const manager = new HardwareProfileManager({ directory, keys: new MemoryKeyring("test", { test: Buffer.from(key, "hex") }) });
try {
  const profile = await manager.create(workspaceId);
  process.stdout.write(JSON.stringify({ result: "created", profileId: profile.profileId }));
} catch (error) {
  if (error instanceof ProfileError && error.code === "ALREADY_EXISTS") {
    process.stdout.write(JSON.stringify({ result: "exists", profileId: (await manager.load(workspaceId)).profileId }));
  } else throw error;
}
