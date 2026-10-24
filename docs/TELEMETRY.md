# QA telemetry configuration

Open **Telemetry** on a profile card. Every configurable field is generated from
`src/shared/telemetrySchema.ts`; the same schema validates preload arguments, IPC,
templates, imported JSON and saved records. The pasted collector output is an
inventory of observed values, rather than a configuration to copy onto every
profile. Native is the default for each field. Clearing a field restores its
original descriptor; resetting the entire configuration restores native APIs.

## Controls and coverage

| Collector area | Supported configuration | Boundary |
| --- | --- | --- |
| Navigator | CPU threads, memory, platform, user-agent, appVersion, vendor, languages, touch points, DNT and PDF support | Reported QA values; cookies, webdriver, product and engine identity stay native |
| Client hints | Hide `navigator.userAgentData`; local session also strips Sec-CH-UA headers | VM transport client hints and worker globals remain browser-controlled |
| Screen | Reported width, height, available width/height, color/pixel depth and pixel ratio | Does not resize the display, layout viewport, window or orientation |
| Media devices | Empty enumeration and denied capture | Electron permissions additionally deny capture; no synthetic real device is installed |
| WebGL 1/2 | Debug vendor/renderer strings where the native query succeeds | No fabricated context, extension or GPU capability |
| Canvas | Seeded subpixel offsets for 2D text | Deterministic; no readback noise, canvas taint bypass or worker interception |
| Audio | Seeded variation in completed offline render buffers | Promise-based offline rendering; live audio hardware and event-based completion remain native |
| Fonts | Deny local-font enumeration | Installed fonts and text measurements remain actual guest/host assets |
| Connection | Reported effective type, RTT, downlink and data saver | Does not shape packets or bandwidth |
| Battery | Static level/charging mock with EventTarget shape | No fabricated battery events or real power changes |
| Storage | Quota estimate mock | Does not change actual quota or persistence permissions |
| Performance | Hide nonstandard `performance.memory` | Clocks, navigation timing and real heap accounting are retained |
| Speech / gamepads | Empty voice/controller lists | Does not install voices or physical controllers |
| WebRTC | Block peer creation or force relay-only configurations, including `setConfiguration` | Relay requires TURN supplied by the application; restrictions are not a VPN |
| Client IP / headers / TLS | User-agent applied through the native browser configuration | Server-observed addressing and TLS are transport properties |

The runtime keeps an original descriptor journal per document. Each update first
restores that journal and then installs the new configuration, avoiding accumulated
wrappers and canvas offsets. Nonconfigurable descriptors are skipped. Simulation
is explicitly inspectable at `window.__platypusQa`, including skipped properties.
`Function.prototype.toString` and browser integrity checks are never disguised.
This is an application QA fixture rather than a guarantee of indistinguishable
hardware or zero network leakage.

## Persistence, IPC and update timing

Telemetry records and custom templates use Adios `EncryptedSettingsStore` with
AES-256-GCM, per-record HKDF derivation and authenticated record identity. They
live in `userData/telemetry-vault`, separate from hardware records and their
lifetime locks. The master key is OS-encrypted in `keys/telemetry-master.dat`.
Keep both vault and key in backups. A missing key for an existing vault fails
closed. Purging a profile also purges its telemetry record; reusable templates
remain until deleted explicitly.

The renderer bridge exposes only get/save/apply/template operations, with the same
manager-window, main-frame, URL and UUID validation as workspace IPC. Revision
checks reject stale editors, and Adios serializes record updates across processes.
The panel debounces saves by 350 ms, flushes on Save & close, and reports errors
without pretending settings were saved. Reload saved recovers a stale editor.
Existing four-field settings remain readable; profile edits migrate them into the
new vault. New telemetry updates use the Adios vault as their authoritative state.

Local browser documents receive configuration at document start through the
isolated preload and `contextBridge.executeInMainWorld`. Updates change current
main-document properties live. WebRTC policy changes reload the page to close
preexisting, untracked peer connections. A profile preload can synchronously read
only its own cached configuration; it never receives the manager's IPC API.
Electron subframes, workers and service workers are outside this preload's scope.
A single session-owned header hook keeps user-agent and Accept-Language aligned
for outgoing local browser requests, including frames and workers. It reads the
latest configuration on every request. Hiding client hints also strips local
Sec-CH-UA headers; this does not fabricate worker JavaScript properties.

The included Debian guest receives the latest runtime via QEMU's supported guest
agent and virtio-serial channel. QEMU connects to a single-use ephemeral listener
on host loopback; there is no externally listening QGA port, shared host mount,
browser debugging port, or arbitrary guest-command IPC operation. The main bundle
contains the fixed, trusted Python deployment action. Profile settings are passed
as bounded JSON arguments, never concatenated into Python or shell code.

On VM launch, the initial image browser opens only a guest-local placeholder until
the host installs the requested QA extension and launches the actual start URL.
Running is reported after guest deployment is acknowledged. **Apply to workspace**
restarts only Chromium with the new document-start configuration and HTTP
user-agent; the VM, hardware identity and disks stay in place. Open tabs may close.
The guest browser loads only the managed QA extension to prevent competing
extension overrides. The deployment stops Chromium before updating extension
files, uses content-addressed scripts and a new manifest version, and checks that
the new browser process starts. A readiness-only native messaging host runs as the
unprivileged guest user. It accepts only a bounded nonce from the pinned QA
extension origin, writes a readiness acknowledgement and executes no commands.
The browser starts on about:blank; only after this handshake does the main action
open the requested URL. Managed startup policy prevents old tabs from restoring
before the extension is ready. Custom images must provide the same Debian guest
contract, `qemu-guest-agent`, display and `workspace` account.

## Network boundaries

The local browser uses Electron's fixed-server proxy configuration to its own
main-process dispatcher gateway, with explicit
localhost, loopback and *.local bypass rules plus saved exceptions. External
starting URLs run a proxy preflight; diagnostic starting URLs can open even
when the upstream proxy is unavailable. Proxy credentials remain in OS-encrypted profile storage and never enter
telemetry exports. QUIC and DNS prefetch are disabled, WebRTC's native handling
policy is `disable_non_proxied_udp`, and proxied local documents additionally block
peer connections regardless of a less restrictive simulated setting. External destinations have no DIRECT
fallback; configured local exceptions deliberately connect directly. Permission grants are never synthesized.

Proxied VM profiles force QEMU `restrict=on` on every NIC, even when the host
configuration selects outbound NAT. One explicit guest forward carries a framed,
multiplexed stream to a per-workspace loopback gateway. The guest adapter exposes
a local SOCKS5 endpoint to Chromium; the host gateway opens CONNECT tunnels through
the configured HTTP/HTTPS proxy, or forwards through a SOCKS5
proxy with optional username/password authentication. Local hostname exceptions connect directly from the host gateway and
never receive upstream proxy credentials. Guest localhost/127.0.0.1 URLs reach
host diagnostics through this route; the QEMU transport itself remains restricted. Credentials remain on the host and are absent from QEMU arguments, guest
files, manifests and telemetry exports. Direct guest egress is blocked, including
when authentication fails or the upstream becomes unavailable. Other guest apps
need to explicitly use the guest SOCKS5 endpoint; arbitrary traffic is blocked
rather than transparently tunnelled. Proxy profiles also block document WebRTC,
QUIC and local target DNS resolution. See QEMU's
[restricted networking and guest forwarding](https://www.qemu.org/docs/master/system/qemu-manpage.html).

Authenticated HTTP proxy transport is supported for Webshare compatibility.
Basic credentials travel unencrypted between the host and an HTTP proxy; HTTPS
website content still uses end-to-end TLS. HTTPS proxy transport validates the
proxy certificate. Authenticated SOCKS5 is negotiated by the main-process gateway for both launch paths.

See the official [Electron session proxy API](https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig)
and [WebRTC handling policy](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwebrtciphandlingpolicypolicy).
The guest readiness channel follows Chrome's documented
[native messaging protocol](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
with a single allowed extension origin and no page-to-native message bridge.

## Verification

- `npm run check`: schema validation, deterministic canvas/audio, document-start
  properties, live/native resets, real HTTP user-agent, IPC authorization, stale
  revision rejection, schema-driven UI saves, encrypted templates and purge/restart.
- `npm --prefix packages/adios run check`: authenticated encryption, record substitution,
  concurrent settings updates, size bounds, descriptor compatibility and locking.
- `npm run test:qemu-electron`: real WHPX/GTK guest, browser-reported telemetry,
  actual HTTP header, blocked WebRTC, applying an edited configuration while the
  VM runs, native reset, visible window, shutdown, relaunch and purge.

The UI test writes `out/tests/telemetry-dashboard.png`. VM tests use temporary
vaults and overlays; they never replace a published base or modify user profiles.
