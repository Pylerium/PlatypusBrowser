# Workspace profiles and routing

The trusted local manager administers workspace profiles identified by independent
UUIDs. A profile has a validated, case-sensitive `tenantId` (default `default`),
a name, HTTP(S) start URL, runtime settings and an optional proxy endpoint.
`profiles.list(tenantId)` filters one tenant; omitting the argument lists all tenants
for the local administrator. Tenant IDs organize profiles; authentication and
remote tenant authorization are outside this local desktop manager. Browser pages
cannot invoke the manager APIs: every handler validates its sender and main frame.

## Runtime and execution

The existing telemetry schema validates userAgent, platform, hardwareConcurrency,
deviceMemory, screen geometry, devicePixelRatio and deterministic canvas text seeds,
plus the other supported QA settings. The Electron sandboxed preload invokes
`contextBridge.executeInMainWorld` at document start before page scripts. Overrides
retain/restorably replace property descriptors and remain inspectable through
`window.__platypusQa`. They do not change physical host resources or promise identical
rendering across different OS/browser/font versions. See [coverage](TELEMETRY.md).

Each fast local browser uses `persist:profile-<UUID>`. Each QEMU workspace uses its
own persistent overlay, guest browser, Adios identity and private guest-agent/QMP
channels. The VM path retains hardware-accelerated **q35**, as selected for SMBIOS
compatibility, rather than QEMU's literal `microvm` machine type. There is no silent
fallback from a VM to a host browser or software emulation.

## Routing and credentials

`ProxyDispatcher` is the main-process coordinator. Its `ProxyCredentialStore`
interface retrieves credentials only inside the main process. Local profiles get
independent ephemeral loopback SOCKS5 gateways; VM launches receive separately owned
gateways from the same dispatcher. HTTP/HTTPS upstreams use CONNECT. SOCKS5 upstreams
use no-auth or RFC 1929 username/password negotiation as configured. Authentication
failures never retry as unauthenticated or direct external connections.

Electron installs a fixed-server route to its profile gateway and explicit bypass
rules. Localhost, 127.0.0.1, IPv6 loopback and *.local are mandatory exceptions.
Custom exact hosts and *.domain patterns are supported. Proxied VMs retain restricted
QEMU networking; their gateway implements direct host diagnostic exceptions. All
other proxied VM traffic travels through the designated endpoint. Both `no_proxy`
and `NO_PROXY` are set for the guest browser environment.

Gateway listeners and active tunnels close with the owning browser/VM. Proxy checks
release temporary local gateways. No raw credentials or cookie values enter child
process arguments, QEMU manifests, workspace logs or metadata exports. Plain HTTP
and SOCKS5 authentication is unencrypted on the connection to the upstream proxy;
HTTPS proxy transport validates its TLS certificate.

## Bulk ingestion

Use **Import proxy list**, with optional Tenant ID in the profile form. Supported
file forms include:

```text
host.example.com:8080
host.example.com:8080:username:password
http://username:password@host.example.com:8080
socks5://username:password@host.example.com:1080
```

URLs support percent-encoded credentials. JSON arrays may contain endpoint strings
or `{protocol, host, port, username?, password?}` objects. Host-only lines default to
HTTP; the API can select SOCKS5 explicitly. Imports allow 1-100 entries / 200000 bytes.
Validation completes before storage mutation. New profiles are committed in one
encrypted snapshot, and existing protocol/host/port endpoints are skipped within
the selected tenant. Passwords containing colons work in the legacy line form.

```ts
await window.platypus.profiles.importProxies(text, "socks5", "team-a");
const profiles = await window.platypus.profiles.list("team-a");
```

## Encrypted state and metadata transfer

Profile parameters and proxy credentials reside in OS-protected `profiles.dat`.
Adios encrypted settings store cookie seeds and bypass rules in `session-vault`,
and runtime/template revisions in `telemetry-vault`. Adios master keys use OS secure
storage and remain outside the encrypted records. Missing keys and authentication
failures stop loading rather than replacing identities. Existing profiles without
a tenant ID remain in `default`.

**Export metadata** emits a versioned whitelist: tenant, name, start URL, validated
runtime, proxy endpoint with a credential-required flag, bypass rules and cookie
count. **Import metadata** creates a fresh UUID, browser partition and VM identity;
it imports neither cookies nor proxy credentials. Source values for those fields
are rejected. Add secrets separately through profile editing and cookie import.

```ts
const metadata = await window.platypus.profiles.exportMetadata(profileId);
const clone = await window.platypus.profiles.importMetadata(metadata);
```

JSON/Netscape cookie ingestion and both hydration paths are described in
[session state](SESSION_STATE.md). Replacing a saved import does not clear unrelated
cookies already stored by Chromium. Profile purge removes its encrypted settings,
browser session data and VM overlay through the existing cleanup journal.

## Verification

`npm run check` covers validation, build, runtime descriptors/canvas behavior,
protocol fixtures, tenant-scoped import/deduplication, metadata redaction/cloning,
sender authorization, cookie hydration and cleanup recovery.

`npm run test:proxy-electron -- "Webshare 10 proxies.txt"` is an opt-in live check
using the first endpoint over HTTP and SOCKS5 in actual Electron browsers.
`npm run test:qemu-electron` checks real hardware-backed guest launch, cookie delivery
to host diagnostics through proxy exceptions, telemetry updates and persistent relaunch.
