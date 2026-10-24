# Adios hardware profile manager

A Node.js/TypeScript library for generating and persisting workspace-scoped virtual hardware descriptors. It supplies JSON, environment variables, and registry-mock JSON to cooperating local processes. It does not change firmware, physical device identifiers, network adapters, the host registry, or OS hardware query results. Environment isolation still requires the host's process/container/VM and access controls.

## Build and verify

Requires Node.js 22 or newer. No runtime dependencies.

```powershell
npm ci
npm run check
```

`check` performs strict type checking, builds declarations and JavaScript, and runs the Node test suite. Tests cover deterministic generation, address bits, workspace separation, authenticated storage, corruption, key rotation, concurrent processes, link protection, export consistency, and cleanup. The POSIX permission check runs only on POSIX hosts.

## Integration

Inject a `KeyProvider` backed by your host's OS credential vault or KMS. The provider returns **fresh 32-byte Buffer copies**; Adios zeroes those copies after use. Persist the vault key across application restarts. Never generate a new master key on every launch or place the key inside the profile directory.

```ts
import { HardwareProfileManager } from "@adios/hwid-profile-manager";

const manager = new HardwareProfileManager({
  directory: "H:/ApplicationData/Adios", // dedicated private absolute path
  keys: osVaultKeyProvider,             // your implementation of KeyProvider
});

const workspace = manager.forWorkspace(browserProfile.id);
await workspace.create({ storageCount: 2, networkCount: 1 });
const profile = await workspace.load();
const payload = await workspace.export();

// Pass to the matching child process only. process.env is never mutated.
const env = await workspace.environment({ PATH: process.env.PATH });
// spawn(executable, args, { env });

// Optional: explicitly create plaintext files for a cooperating process.
const files = await workspace.materialize();
// files.statePath, files.registryMockPath, files.environmentPath

// Stop the workspace's processes and close readers before deleting its profile.
await workspace.purge();
```

For the sibling PlatypusBrowser application, use its stable browser profile UUID as `workspaceId`. Keep the Adios manager in the trusted main process and authorize requests there. Never expose arbitrary profile IDs, key material, or filesystem operations to untrusted browser content. Electron browser renderers do not automatically inherit environment variables supplied to a separate Node child process; a trusted, explicit adapter is required to consume these descriptors.

`examples/basic.ts` provides a compiled example using `MemoryKeyring`. After building, run `node dist/examples/basic.js` with `ADIOS_ENCRYPTION_KEY` set to a persistent secret 64-character hex key. The example does not print key material or descriptor contents. `MemoryKeyring` is an in-memory adapter, not an OS vault; call `destroy()` during shutdown.

## API and lifecycle

| Operation | Behavior |
| --- | --- |
| `manager.forWorkspace(id)` | Returns a frozen handle permanently scoped to that case-sensitive ID. |
| `create(id, options?)` | Generates and persists a new profile; rejects existing or orphaned state rather than replacing identity. |
| `load(id)` | Authenticates and validates the stored profile; returns a detached, deeply frozen snapshot. |
| `export(id)` | Returns frozen environment variables, profile JSON, and registry-mock JSON in memory. |
| `materialize(id)` | Explicitly writes `state.json`, `environment.json`, and `registry-mock.json` beside the encrypted record. |
| `rotateEncryption(id)` | Re-encrypts using the active key without changing identifiers or timestamps. |
| `purge(id)` | Removes module-owned exports, temporary files, and encrypted records; returns false if already absent. |
| `withExclusiveWorkspace(id, action)` | Holds the Adios cross-process lock throughout a long-lived external runtime. |

The scoped handle exposes create/load/export/materialize/rotateEncryption/purge without an ID argument, plus `environment(base?)`. There is no global active workspace or cached profile. Switching workspaces means using a different handle and passing only its exports to its own process. `environment()` defaults to an empty base; when a base is supplied, all existing `ADIOS_*` variables are removed case-insensitively before adding the selected workspace's values. Do not copy encryption-key environment variables into child processes.

`withExclusiveWorkspace` is a manager-level API for external runtimes such as QEMU. Await the entire child-process lifetime inside its callback, including cleanup and confirmed exit. Its frozen callback handle provides `workspaceId`, `load`, `create`, and `purge`; these serialize inside the existing lock. Do not call regular manager methods for the same ID from that callback, since they would try to acquire its held lock. Escaped handles reject operations after the callback ends, and queued operations drain before release. Forced host termination can leave a live external process and a stale lock; stop the process before explicit lock recovery.

Exported values use an `ADIOS_` prefix, including workspace/profile IDs, board fields, system UUID, machine GUID, and JSON arrays for storage and NICs. Registry mocks are JSON with `format: "adios-registry-mock"`, `version: 1`, workspace/profile IDs, and typed `REG_SZ` values under `keys`; they are input to your local adapter, not `.reg` files to import into Windows.

`ProfileError.code` distinguishes `INVALID_INPUT`, `NOT_FOUND`, `ALREADY_EXISTS`, `INTEGRITY`, `KEY_UNAVAILABLE`, `LOCK_TIMEOUT`, and `UNSAFE_PATH`. Filesystem errors retain native Node error codes. Authentication failures do not regenerate, replace, or fall back to another workspace's state. Purge does not require a working decryption key, so damaged records can still be explicitly removed.

## Generation contract

`generateHardwareDescriptors(workspaceId, seed, options?)` requires exactly 32 bytes of seed material. HMAC-SHA-256 derives each component independently using a versioned domain, the workspace ID, and its component label. Equal input produces equal descriptors; changing counts does not change existing components. A golden test pins generator version 1. The manager uses fresh cryptographic seed material at creation and stores descriptors, not the seed. Full profile metadata includes a creation timestamp and random profile UUID.

Descriptors include board manufacturer/product/serial/version, 1–16 storage devices with eight-hex-digit volume serials and UUID disk IDs, 1–16 NICs, system UUID, and machine GUID. UUIDs have version 4/variant bits set. MAC addresses set the locally administered bit and clear the group bit; generated prefixes do not claim an IEEE-assigned vendor OUI. See the [IEEE identifier guidance](https://standards-support.ieee.org/hc/en-us/articles/4888705676564-Guidelines-for-Use-of-Extended-Unique-Identifier-EUI-Organizationally-Unique-Identifier-OUI-and-Company-ID-CID).

Uniqueness is probabilistic. In particular, 32-bit volume serials have a limited namespace and should never serve as the sole workspace key. The actual association is the validated case-sensitive workspace ID and its authenticated profile record. Workspace IDs permit 1–128 ASCII letters, digits, dots, underscores, and hyphens, starting with a letter or digit. Paths use SHA-256 ID digests, avoiding Windows reserved-name and case-collision problems.

## Storage and key rotation

Records use AES-256-GCM with fresh 96-bit nonces and 256-bit salts. HKDF-SHA-256 derives a separate record key from the master key, salt, and workspace ID. The authenticated header includes the format/algorithm, workspace ID, key ID, salt, and nonce. Ciphertexts copied into another workspace fail authentication. The plaintext profile is independently schema-checked and workspace-bound after decryption. See [Node's crypto API](https://nodejs.org/api/crypto.html).

Storage layout:

```text
<directory>/
  locks/<sha256-workspace-id>.lock
  workspaces/<sha256-workspace-id>/
    profile.enc
    state.json                 # only after explicit materialize()
    environment.json           # only after explicit materialize()
    registry-mock.json         # only after explicit materialize()
```

Every operation uses an exclusive per-workspace filesystem lock, including reads and purge, across manager instances and local processes. Writes use exclusive temporary files, file synchronization, and rename; POSIX directory entries are synchronized as well. File size is bounded to 64 KiB. Symbolic links, junctions, hard-linked records, unexpected directories, and unknown purge targets are rejected. Use a local filesystem supporting exclusive creation and atomic rename; network filesystems and distributed locking are outside this implementation's guarantees.

The store uses POSIX modes 0700 for its private root and 0600 for files. On Windows, deploy it beneath a user-private directory with an appropriate ACL; POSIX modes do not establish Windows user isolation. The storage root and its ancestors must be trusted and must not be writable by hostile processes. The library is not a security boundary against an administrator or another process running with the same unrestricted credentials. Keep master keys separate from profile backups. Filenames expose workspace-ID digests and envelope key IDs, not encrypted descriptor values.

To rotate keys, configure a provider with both old and new key IDs, select the new active key, and call `rotateEncryption(id)` for each workspace in the host's workspace inventory. Retain old keys until all live records and required backups have migrated. The library does not maintain a second plaintext workspace index.

## Crash recovery and deletion limits

Locks are never automatically stolen based on age or PID, avoiding split ownership during slow operations or PID reuse. A crashed process can leave a lock. Stop **all** processes using this storage, verify that no writer remains, and remove only the matching `locks/<sha256-workspace-id>.lock` file before restarting. Normal operation removes locks in `finally` blocks. Do not delete a lock while another process may be working.

An interrupted atomic write can leave a uniquely named `.tmp` file. Existing committed records remain readable. An orphaned workspace directory with no committed record cannot be reused until explicitly purged; this prevents old plaintext exports being associated with a newly generated profile. Purge preflights all files, refuses unrecognized content, overwrites recognized files, syncs them, unlinks them, and removes the workspace directory. Partial failures are reported and purge can be retried. An interrupted purge can leave an unreadable, overwritten record; it must be purged again, not regenerated implicitly.

No filesystem module can guarantee physical erasure on SSDs, copy-on-write filesystems, snapshots, backups, or open file handles. Overwriting is a best-effort measure. Purge removes this module's live files and records; it cannot revoke previously returned snapshots, environment variables, external copies, or descriptors held by running processes. Stop consumers before purge and manage backups through your retention policy. Stronger cryptographic erasure requires independently destroyable per-workspace vault keys and deletion of all key backups. JavaScript strings and caller-owned copies also cannot be reliably zeroized by this library.

Application settings can opt into larger bounded encrypted records through
`new EncryptedSettingsStore({ directory, keys, maxRecordBytes })`. The default is
32768 bytes; explicit limits from 1024 bytes through 8 MiB are supported. Each
store enforces its limit on authenticated reads and writes, including the matching
encoded file bound. Hardware profiles retain their original limits.
