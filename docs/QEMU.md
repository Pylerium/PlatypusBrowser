# Adios and QEMU integration

The trusted Electron main process runs a hardware-accelerated QEMU q35 VM for each browser profile UUID. Minimal q35 was selected because native QEMU `microvm` does not publish the required SMBIOS tables. See the [machine documentation](https://www.qemu.org/docs/master/system/i386/microvm.html) and [SMBIOS options](https://www.qemu.org/docs/master/system/invocation.html). Production launch never falls back to a host browser or software emulation.

## Host configuration

1. Install `qemu-system-x86_64` and `qemu-img`. Enable WHPX on Windows, KVM on Linux, or HVF on an x86 macOS host.
2. Run `npm run guest:setup` to build and verify the included Debian/Chromium image and create the host configuration automatically. Alternatively, prepare your own bootable x86_64 image with virtio drivers and the guest contract below. Bases must be standalone raw or qcow2 files, with no backing chain or external data file. Keep them immutable while any derived workspace exists.
3. Copy [qemu.example.json](../qemu.example.json) to a private configuration file. Set absolute real paths to executables and base images. Resolve symlinked executable/image files to their actual files first.
4. Set `PLATYPUS_QEMU_CONFIG` to its absolute path before starting the app. Otherwise, the app reads `qemu.json` under Electron's `app.getPath("userData")`. Invalid configuration produces an Error status.

```powershell
$env:PLATYPUS_QEMU_CONFIG = (Join-Path $PWD 'qemu.local.json')
npm run dev
```

The example uses `whpx`/`gtk` for Windows. The installed QEMU 11 SDL backend crashes with Windows access violation `0xC0000005`; GTK has been verified on this host. Use `kvm`/`gtk` on Linux or `hvf`/`cocoa` on an x86 macOS host. `display: "none"` supports headless guests. Default `network: "restricted"` blocks guest-initiated external connections; explicitly select `"user"` for outbound NAT. No host mounts, host port forwards, shell command strings, or hardware passthrough are added. A proxied profile forces every NIC into restricted mode and adds one explicit guest forward to its private loopback proxy gateway. The managed guest adapter configures Chromium automatically.

Missing Adios profiles are provisioned on first launch under the matching browser profile UUID. Existing profiles must authenticate successfully; corruption/key errors never regenerate identity. The number of configured base images must match an existing profile's Adios storage count. Newly provisioned profiles use the configured image count.

The OS-encrypted master key lives separately in `userData/keys/adios-master.dat`; encrypted records live in `userData/adios-vault`. Linux rejects the insecure `basic_text` backend. Back up the key with the corresponding OS account protections and vault. A missing key for an existing vault fails closed instead of issuing a replacement. Keys never cross IPC or enter child-process environments.

## Mapping and guest contract

| Adios value | QEMU/guest mapping |
| --- | --- |
| Board manufacturer/version | SMBIOS type 0 vendor/version |
| Board manufacturer/product/version/serial | SMBIOS types 1 and 2 |
| System UUID | `-uuid` and SMBIOS type 1 UUID |
| Storage volume serial | Exact virtio block-device `serial` value |
| NIC MAC | Exact `virtio-net-pci` MAC |
| Disk UUID, filesystem volume ID, Machine GUID | Guest manifest; these are OS/filesystem state, not QEMU machine properties |

The runtime supplies JSON through `-fw_cfg name=opt/org.platypus/workspace,file=...`:

```ts
{
  format: "platypus-workspace",
  version: 1,
  workspaceId,
  profileId,
  hardware, // complete validated Adios descriptors
  browser: { startUrl, runtime }
}
```

A Linux guest with the fw_cfg driver can read `/sys/firmware/qemu_fw_cfg/by_name/opt/org.platypus/workspace/raw`. Your image's trusted startup adapter must consume this before opening its browser and apply requested filesystem IDs, Machine GUID, navigator simulation, and URL. Assigning a device serial alone does not alter cloned filesystem serials or the Windows registry. The host does not modify filesystems inside bases or install adapters into arbitrary images.

The manifest contains virtual descriptors and browser settings, never vault keys or proxy credentials. It is stored in the private VM directory during execution, then overwritten/deleted after QEMU exits. The included [Debian image builder and adapter](GUEST_IMAGE.md) implement browser startup, machine identity, GPT disk IDs, and navigator/canvas simulation. Custom images must implement their own adapter.

## Locking and lifecycle

Adios `withExclusiveWorkspace(id, action)` holds its cross-process lock from decryption through confirmed QEMU exit and manifest cleanup. Its scoped `load/create/purge` methods avoid nested locking and are invalid after the callback ends. Other processes cannot boot, edit, purge, or load the same workspace while its runtime owns the lease. Electron additionally enforces one manager instance per user-data directory.

Each workspace gets persistent qcow2 overlays under `userData/qemu-workspaces/<sha256-id>`. `binding.json` pins its workspace/profile IDs and base paths, formats, sizes, and modification times. Existing overlays are inspected with `qemu-img` and must reference those bases. Explicit read-only backing nodes prevent writes to shared images. Restore a changed base or explicitly purge its affected workspaces. Guest overlays are private files, not independently encrypted disks; use host or guest disk encryption if required.

| Status | Meaning |
| --- | --- |
| Booting | Provisioning, process startup, QMP negotiation, or guest telemetry deployment |
| Running | Virtual CPUs are executing and the guest adapter acknowledged browser startup; page/application readiness is not implied |
| Terminated | QEMU exited |
| Error | Configuration/process failure, paused/panicked guest, or lost control channel |

Status revisions prevent stale snapshots replacing newer events. The typed bridge exposes `workspace.launch/close/statuses/logs/onStatus`; it exposes no arbitrary executable, QMP command, host path, or shell interface. Every handler validates the sender, main frame, manager URL, and profile UUID. In-memory stdout/stderr tails are bounded to 64 KiB each and discarded on purge.

The main process also owns a private guest-agent channel for the included Debian
adapter. It deploys the current QA configuration before opening the actual start
URL. The separate Telemetry panel saves while the VM runs; Apply to workspace
restarts Chromium with that configuration. See [telemetry architecture and coverage](TELEMETRY.md).

QEMU connects to a main-process-owned ephemeral IPv4 loopback listener for QMP. The listener closes after accepting one connection; QMP is not exposed on external interfaces or a fixed port. This avoids Windows display backend interference with stdio. Startup capability negotiation uses the configured boot timeout; runtime commands have separate short deadlines. stdout/stderr remain available for process logs. Startup errors include the process exit code, including Windows exception codes.

The controller polls QMP status while running and terminates a runtime whose control channel fails. Close requests QMP `system_powerdown`, then `quit`, then process termination if necessary. Forced power-off can lose unflushed guest data. App quit drains VMs. Locks are released only after confirmed exit. If force-kill cannot be confirmed, the lease remains held and shutdown reports failure. Forced manager termination can leave an orphan QEMU process and its lock. Stop that process and all writers before manually recovering its Adios lock; locks are never stolen by age or PID.

## Purge and recovery

Purge journals deletion before removing runtime assets, acquires the same Adios lease, overwrites/unlinks recognized overlay files, purges the encrypted record, clears local browser data, and completes the journal. Unknown files, links, and unexpected paths cause refusal. Partial failures remain queued and retry at startup. Windows Chromium handles can defer local browser directory deletion until exit; startup recovery avoids reopening those sessions. Base images and the shared master key remain available for other workspaces.

Overwriting cannot guarantee physical erasure on SSDs, snapshots, backups, or existing external copies. Use disk encryption and retention policies for those layers. Storage roots and their ancestors must be private and trusted. POSIX files/directories use restrictive modes; Windows deployments must use an appropriate user-private ACL. Use local filesystems supporting exclusive creation and atomic rename.

## Verification

`npm run check` runs strict type checks, a production build, QMP/image-tool fixture tests, real Electron rendering tests, and real Electron IPC/key/purge/restart tests. The fixtures exercise process orchestration but are not VMs.

`npm run test:qemu-real` uses real QEMU with a temporary blank disk to verify hardware acceleration, SMBIOS strings in firmware memory, QOM disk serial/MAC values, overlay creation, controller shutdown, and purge. It defaults to the Windows installation path; override `QEMU_TEST_BINARY` and `QEMU_TEST_IMG` elsewhere. This was verified with QEMU 11 and WHPX on this host. The test boots firmware, not a guest OS or browser.

`npm run test:qemu-real -- --gtk` exercises the visible display backend. `npm run test:qemu-electron` uses the installed host configuration and guest image to test real renderer IPC, visible QEMU launch, heartbeat monitoring, shutdown, relaunch, and purge in a temporary Electron user-data directory. Set `QEMU_TEST_CONFIG` to override its host configuration path.
