import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, lstat, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ExclusiveWorkspace } from "../src/index.js";
import { HardwareProfileManager, MemoryKeyring, ProfileError, generateHardwareDescriptors,
  validateProfile, validateWorkspaceId, exportWorkspace, createWorkspaceEnvironment, EncryptedSettingsStore } from "../src/index.js";

const key = Buffer.alloc(32, 17);
const seed = Buffer.alloc(32, 42);
const digest = (id: string) => createHash("sha256").update(id).digest("hex");
const code = (expected: string) => (error: unknown) => error instanceof ProfileError && error.code === expected;

test("large encrypted settings are opt-in, bounded and authenticated", async (t) => {
  const f = await fixture(t);
  const directory = join(f.parent, "session-settings");
  const settings = new EncryptedSettingsStore({ directory, keys: f.keys, maxRecordBytes: 5 * 1024 * 1024 });
  const value = { cookies: randomBytes(70000).toString("base64") };
  await settings.save("session-a", value);
  assert.deepEqual(await settings.load("session-a"), value);
  const stored = join(directory, "workspaces", digest("session-a"), "settings.enc");
  assert.equal((await readFile(stored, "utf8")).includes(value.cookies), false);
  await assert.rejects(new EncryptedSettingsStore({ directory, keys: f.keys }).load("session-a"));
  await assert.rejects(settings.save("session-a", { cookies: "x".repeat(5 * 1024 * 1024) }), /size limit/);
  assert.deepEqual(await settings.load("session-a"), value);
  await settings.purge("session-a");
  assert.equal(await settings.load("session-a"), null);
});

test("settings records authenticate identity, conceal plaintext, serialize updates, and purge independently", async (t) => {
  const f = await fixture(t);
  const directory = join(f.parent, "settings");
  const settings = new EncryptedSettingsStore({ directory, keys: f.keys });
  const value = { version: 1, revision: 1, runtime: { platform: "QA private platform", hardwareConcurrency: 3 } };
  await settings.save("workspace-a", value);
  assert.deepEqual(await settings.load("workspace-a"), value);
  const path = join(directory, "workspaces", digest("workspace-a"), "settings.enc");
  assert.equal((await readFile(path, "utf8")).includes("QA private platform"), false);
  const second = new EncryptedSettingsStore({ directory, keys: f.keys });
  await Promise.all(Array.from({ length: 5 }, (_, index) => (index % 2 ? second : settings).update("workspace-a", (current) => ({ ...(current as typeof value), revision: (current as typeof value).revision + 1 }))));
  assert.equal(((await settings.load("workspace-a")) as typeof value).revision, 6);
  await settings.save("workspace-b", {});
  const other = join(directory, "workspaces", digest("workspace-b"), "settings.enc");
  await writeFile(other, await readFile(path));
  await assert.rejects(settings.load("workspace-b"), code("INTEGRITY"));
  await assert.rejects(settings.save("workspace-a", { huge: "x".repeat(40000) }), /size limit/);
  assert.equal(((await settings.load("workspace-a")) as typeof value).revision, 6);
  await settings.purge("workspace-a");
  assert.equal(await settings.load("workspace-a"), null);
});
async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "adios-test-"));
  const directory = join(parent, "profiles");
  t.after(async () => {
    assert.equal(resolve(parent).startsWith(resolve(tmpdir())), true);
    await rm(parent, { recursive: true, force: true });
  });
  const keys = new MemoryKeyring("test", { test: key });
  t.after(() => keys.destroy());
  const manager = new HardwareProfileManager({ directory, keys });
  const workspaceDirectory = (id: string) => join(directory, "workspaces", digest(id));
  return { parent, directory, keys, manager, workspaceDirectory };
}

test("generation is deterministic, scoped, count-independent, and immutable", () => {
  const one = generateHardwareDescriptors("workspace-a", seed);
  assert.equal(createHash("sha256").update(JSON.stringify(one)).digest("hex"),
    "4811d61641c80dbfd119e7480fe604cc2e7d3b9d0fc726efe50dc1f7951a443e", "generator v1 output must remain compatible");
  assert.deepEqual(one, generateHardwareDescriptors("workspace-a", seed));
  assert.notDeepEqual(one, generateHardwareDescriptors("workspace-b", seed));
  assert.notDeepEqual(one, generateHardwareDescriptors("workspace-a", Buffer.alloc(32, 43)));
  const many = generateHardwareDescriptors("workspace-a", seed, { storageCount: 16, networkCount: 16 });
  assert.deepEqual(one.storage[0], many.storage[0]);
  assert.deepEqual(one.network[0], many.network[0]);
  assert.throws(() => { (one.smbios as { manufacturer: string }).manufacturer = "changed"; }, TypeError);
});

test("generated identifiers are unique across 1000 workspaces and obey address bits", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 1000; index++) {
    const hw = generateHardwareDescriptors(`test-${index}`, seed, { networkCount: 2, storageCount: 2 });
    for (const identifier of [hw.systemUuid, hw.machineGuid, hw.smbios.serialNumber,
      ...hw.storage.flatMap((d) => [d.diskId, d.volumeSerial]), ...hw.network.map((n) => n.macAddress)]) {
      assert.equal(seen.has(identifier), false);
      seen.add(identifier);
    }
    for (const nic of hw.network) assert.equal(parseInt(nic.macAddress.slice(0, 2), 16) & 3, 2);
  }
});

test("reject unsafe IDs, weak seed lengths, and invalid component counts", () => {
  for (const id of ["", "..", "../escape", "a/b", "a\\b", "a\0b", "a b", "💻", "a".repeat(129)]) {
    assert.throws(() => validateWorkspaceId(id), code("INVALID_INPUT"));
  }
  for (const length of [0, 16, 31, 33]) assert.throws(() => generateHardwareDescriptors("a", Buffer.alloc(length)), code("INVALID_INPUT"));
  for (const storageCount of [-1, 0, 17, 1.5, NaN]) assert.throws(() => generateHardwareDescriptors("a", seed, { storageCount }), code("INVALID_INPUT"));
});

test("encrypted profiles survive new manager instances without leaking descriptors", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.create("a", { storageCount: 2, networkCount: 2 });
  const other = new HardwareProfileManager({ directory: f.directory, keys: f.keys });
  assert.deepEqual(await other.load("a"), profile);
  const files = await readdir(f.workspaceDirectory("a"));
  assert.deepEqual(files, ["profile.enc"]);
  const encrypted = await readFile(join(f.workspaceDirectory("a"), "profile.enc"), "utf8");
  for (const secret of [profile.hardware.systemUuid, profile.hardware.smbios.serialNumber, "Adios Virtual Systems"]) {
    assert.equal(encrypted.includes(secret), false);
  }
  const before = encrypted;
  await other.rotateEncryption("a");
  assert.notEqual(await readFile(join(f.workspaceDirectory("a"), "profile.enc"), "utf8"), before);
  assert.deepEqual(await other.load("a"), profile);
});

test("create is exclusive and never replaces corrupted or existing identities", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.create("a");
  await assert.rejects(f.manager.create("a"), code("ALREADY_EXISTS"));
  assert.deepEqual(await f.manager.load("a"), profile);
  const file = join(f.workspaceDirectory("a"), "profile.enc");
  await writeFile(file, "broken");
  await assert.rejects(f.manager.load("a"), code("INTEGRITY"));
  await assert.rejects(f.manager.create("a"), code("ALREADY_EXISTS"));
  assert.equal(await readFile(file, "utf8"), "broken");
});

test("authentication rejects modified ciphertext, metadata, and cross-workspace record substitution", async (t) => {
  const f = await fixture(t);
  await f.manager.create("a"); await f.manager.create("b");
  const file = join(f.workspaceDirectory("a"), "profile.enc");
  const original = await readFile(file, "utf8");
  for (const field of ["ciphertext", "tag", "salt", "iv"] as const) {
    const envelope = JSON.parse(original) as Record<string, string>;
    const bytes = Buffer.from(envelope[field]!, "base64"); bytes[0] = bytes[0]! ^ 1;
    envelope[field] = bytes.toString("base64");
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(f.manager.load("a"), code("INTEGRITY"));
  }
  await writeFile(join(f.workspaceDirectory("b"), "profile.enc"), original);
  await assert.rejects(f.manager.load("b"), code("INTEGRITY"));
  await writeFile(file, original);
  assert.equal((await f.manager.load("a")).workspaceId, "a");
});

test("missing/wrong keys fail closed and key rotation retains identity", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.create("a");
  const missing = new HardwareProfileManager({ directory: f.directory, keys: new MemoryKeyring("new", { new: randomBytes(32) }) });
  await assert.rejects(missing.load("a"), code("KEY_UNAVAILABLE"));
  const wrong = new HardwareProfileManager({ directory: f.directory, keys: new MemoryKeyring("test", { test: randomBytes(32) }) });
  await assert.rejects(wrong.load("a"), code("INTEGRITY"));
  const nextKey = randomBytes(32);
  const rotating = new HardwareProfileManager({ directory: f.directory, keys: new MemoryKeyring("next", { test: key, next: nextKey }) });
  await rotating.rotateEncryption("a");
  const nextOnly = new HardwareProfileManager({ directory: f.directory, keys: new MemoryKeyring("next", { next: nextKey }) });
  assert.deepEqual(await nextOnly.load("a"), profile);
  await assert.rejects(f.manager.load("a"), code("KEY_UNAVAILABLE"));
});

test("workspace handles cannot switch or contaminate exports or process.env", async (t) => {
  const f = await fixture(t);
  const a = f.manager.forWorkspace("A"); const b = f.manager.forWorkspace("a");
  await a.create(); await b.create();
  assert.notEqual((await a.load()).profileId, (await b.load()).profileId);
  assert.throws(() => { (a as { workspaceId: string }).workspaceId = "a"; }, TypeError);
  const payload = await a.export();
  assert.equal(JSON.parse(payload.stateJson).workspaceId, "A");
  assert.equal(JSON.parse(payload.registryMockJson).workspaceId, "A");
  const base = { PATH: "existing", ADIOS_WORKSPACE_ID: "old", adios_custom: "stale" };
  const env = createWorkspaceEnvironment(payload, base);
  assert.equal(env.ADIOS_WORKSPACE_ID, "A"); assert.equal(env.adios_custom, undefined); assert.equal(env.PATH, "existing");
  assert.equal(base.ADIOS_WORKSPACE_ID, "old");
  assert.equal((await b.environment()).ADIOS_WORKSPACE_ID, "a");
  assert.throws(() => exportWorkspace(JSON.parse(payload.stateJson), "b"), code("INTEGRITY"));
});

test("profile validation rejects malformed, duplicate, and cross-workspace descriptors", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.create("a", { networkCount: 2 });
  assert.throws(() => validateProfile(profile, "b"), code("INTEGRITY"));
  for (const mutate of [
    (p: any) => { p.schemaVersion = 2; },
    (p: any) => { p.hardware.network[0].macAddress = "01:00:00:00:00:01"; },
    (p: any) => { p.hardware.network[1].macAddress = p.hardware.network[0].macAddress; },
    (p: any) => { p.hardware.smbios.serialNumber = "bad\nvalue"; },
    (p: any) => { p.hardware.systemUuid = "invalid"; },
    (p: any) => { p.createdAt = "2026-02-30T00:00:00.000Z"; },
  ]) {
    const copy: unknown = JSON.parse(JSON.stringify(profile)); mutate(copy);
    assert.throws(() => validateProfile(copy, "a"), code("INTEGRITY"));
  }
});

test("materialized exports agree and purge removes all files without touching another workspace", async (t) => {
  const f = await fixture(t);
  await f.manager.create("a"); const b = await f.manager.create("b");
  const exports = await f.manager.materialize("a");
  assert.equal(JSON.parse(await readFile(exports.statePath, "utf8")).profileId, exports.profileId);
  assert.equal(JSON.parse(await readFile(exports.registryMockPath, "utf8")).workspaceId, "a");
  assert.equal(JSON.parse(await readFile(exports.environmentPath, "utf8")).ADIOS_WORKSPACE_ID, "a");
  assert.equal(await f.manager.purge("a"), true);
  await assert.rejects(lstat(f.workspaceDirectory("a")), { code: "ENOENT" });
  await assert.rejects(f.manager.forWorkspace("a").export(), code("NOT_FOUND"));
  assert.equal(await f.manager.purge("a"), false);
  assert.deepEqual(await f.manager.load("b"), b);
  assert.deepEqual(await readdir(join(f.directory, "locks")), []);
});

test("orphaned plaintext and encrypted temporary files require purge before recreation", async (t) => {
  const f = await fixture(t);
  await f.manager.create("a");
  const path = f.workspaceDirectory("a");
  await rm(join(path, "profile.enc"));
  await writeFile(join(path, "state.json"), "leftover");
  await writeFile(join(path, "profile.enc.00000000-0000-4000-8000-000000000000.tmp"), "interrupted");
  await assert.rejects(f.manager.create("a"), code("INTEGRITY"));
  assert.equal(await f.manager.purge("a"), true);
  await f.manager.create("a");
});

test("unexpected files and oversized records fail safely without deleting unrelated data", async (t) => {
  const f = await fixture(t);
  await f.manager.create("a");
  const directory = f.workspaceDirectory("a");
  await writeFile(join(directory, "unrelated.txt"), "keep");
  await assert.rejects(f.manager.purge("a"), code("UNSAFE_PATH"));
  assert.equal(await readFile(join(directory, "unrelated.txt"), "utf8"), "keep");
  await writeFile(join(directory, "profile.enc"), Buffer.alloc(65537));
  await assert.rejects(f.manager.load("a"), code("UNSAFE_PATH"));
});

test("workspace directory links cannot redirect reads or purges", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.load("missing"), code("NOT_FOUND"));
  const outside = join(f.parent, "outside"); await mkdir(outside);
  await writeFile(join(outside, "profile.enc"), "do not delete");
  await symlink(outside, f.workspaceDirectory("a"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.manager.load("a"), code("UNSAFE_PATH"));
  await assert.rejects(f.manager.purge("a"), code("UNSAFE_PATH"));
  assert.equal(await readFile(join(outside, "profile.enc"), "utf8"), "do not delete");
});

test("stale locks time out without unsafe automatic takeover", async (t) => {
  const f = await fixture(t);
  await f.manager.create("a");
  const lock = join(f.directory, "locks", `${digest("a")}.lock`);
  await writeFile(lock, "interrupted writer");
  const impatient = new HardwareProfileManager({ directory: f.directory, keys: f.keys, lockTimeoutMs: 50 });
  await assert.rejects(impatient.load("a"), code("LOCK_TIMEOUT"));
  assert.equal(await readFile(lock, "utf8"), "interrupted writer");
  await rm(lock);
  assert.equal((await impatient.load("a")).workspaceId, "a");
});

test("hard-linked records cannot be read or overwritten by purge", async (t) => {
  const f = await fixture(t);
  await f.manager.create("a");
  const file = join(f.workspaceDirectory("a"), "profile.enc");
  const outside = join(f.parent, "outside.enc");
  await link(file, outside);
  const original = await readFile(outside);
  await assert.rejects(f.manager.load("a"), code("UNSAFE_PATH"));
  await assert.rejects(f.manager.purge("a"), code("UNSAFE_PATH"));
  assert.deepEqual(await readFile(outside), original);
});

test("missing keys leave no workspace record and operations recover after failure", async (t) => {
  const f = await fixture(t);
  const provider = {
    activeKey: async () => { throw new ProfileError("KEY_UNAVAILABLE", "Offline"); },
    keyById: async () => { throw new ProfileError("KEY_UNAVAILABLE", "Offline"); },
  };
  const unavailable = new HardwareProfileManager({ directory: f.directory, keys: provider });
  await assert.rejects(unavailable.create("a"), code("KEY_UNAVAILABLE"));
  await assert.rejects(lstat(f.workspaceDirectory("a")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(f.directory, "locks")), []);
  await f.manager.create("a");
  assert.equal((await f.manager.load("a")).workspaceId, "a");
});

test("multiple processes cannot create competing profiles for one workspace", async (t) => {
  const f = await fixture(t);
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const results = await Promise.all(Array.from({ length: 6 }, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [worker, f.directory, "shared", key.toString("hex")], { timeout: 20000 });
    return JSON.parse(stdout) as { result: string; profileId: string };
  }));
  assert.equal(results.filter((r) => r.result === "created").length, 1);
  assert.equal(new Set(results.map((r) => r.profileId)).size, 1);
  assert.equal((await f.manager.load("shared")).profileId, results[0]!.profileId);
});

test("destroyed keyrings cannot decrypt or create and never alter caller key buffers", async (t) => {
  const f = await fixture(t);
  await f.manager.create("a");
  f.keys.destroy();
  await assert.rejects(f.manager.load("a"), code("KEY_UNAVAILABLE"));
  await assert.rejects(f.manager.create("b"), code("KEY_UNAVAILABLE"));
  assert.equal(key.equals(Buffer.alloc(32, 17)), true);
  assert.throws(() => new MemoryKeyring("x", { x: Buffer.alloc(31) }), code("KEY_UNAVAILABLE"));
});

test("private POSIX permissions are applied where supported", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await f.manager.create("a");
  assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.workspaceDirectory("a"), "profile.enc"))).mode & 0o777, 0o600);
});

test("exclusive runtime lease blocks other managers, drains work, and invalidates escaped handles", async (t) => {
  const f = await fixture(t);
  const other = new HardwareProfileManager({ directory: f.directory, keys: f.keys, lockTimeoutMs: 40 });
  let escaped: ExclusiveWorkspace | undefined;
  await f.manager.withExclusiveWorkspace("vm", async (workspace) => {
    escaped = workspace;
    await workspace.create();
    assert.equal((await workspace.load()).workspaceId, "vm");
    await assert.rejects(other.load("vm"), code("LOCK_TIMEOUT"));
    await assert.rejects(other.purge("vm"), code("LOCK_TIMEOUT"));
    // A failed operation must not poison the lease queue.
    await assert.rejects(workspace.create(), code("ALREADY_EXISTS"));
    assert.equal((await workspace.load()).workspaceId, "vm");
  });
  await assert.rejects(escaped!.load(), code("INVALID_INPUT"));
  assert.equal((await other.load("vm")).workspaceId, "vm");
});
