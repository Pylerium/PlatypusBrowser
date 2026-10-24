# Session state

The manager preload exposes these authorized main-process operations:

```ts
await window.platypus.profiles.importCookies(profileId, cookieFileText);
await window.platypus.profiles.configureSession(profileId, ["*.lab.internal"]);
await window.platypus.profiles.save({
  name: "Diagnostics", startUrl: "http://localhost:5000/", proxy,
  proxyBypassRules: ["telemetry.internal"],
}, profileId);
```

Both APIs require the trusted manager frame, a valid existing profile UUID, and an
offline workspace/local browser. They use the existing serialized profile operation
queue and Adios workspace lease. Omitting `proxyBypassRules` on save preserves its
current value. Core local exceptions are always appended and deduplicated. Rules
accept exact hostname/IPv4 literals, IPv6 loopback and `*.domain` patterns; arbitrary
Chromium rule directives and global wildcards are rejected.

Cookie ingestion accepts an array or a `{cookies: [...]}` wrapper. Required fields
are string `name`, string `value`, and either `domain` or an HTTP(S) `url`. Optional
fields include `path`, `secure`, `httpOnly`, `hostOnly`, `session`, `expirationDate`,
`expires`, `expiration`, and `sameSite`. Expiries are Unix seconds; session flags or
0/-1 expiry omit persistence. SameSite values are `unspecified`, `lax`, `strict`,
`none` or `no_restriction`. SameSite=None requires Secure. Cookie name prefixes and
URL/domain relationships are validated. Partitioned cookies are rejected rather
than imported into a broader scope. Unknown non-security metadata is ignored.
Netscape records use seven tab-separated columns, including an empty final value.

Malformed files are rejected before any encrypted mutation. Errors identify a row
or cookie position without echoing secrets. Duplicate domain/path/name keys use the
last value. Browser-level cookie validation can still reject a cookie, for example
an invalid public suffix; that stops navigation instead of silently dropping it.
Imports merge their keys into the jar and never clear unrelated cookies. Importing
`[]` clears future hydration only. This feature imports cookies, not localStorage,
IndexedDB or arbitrary authenticated application state.

The local path uses `session.fromPartition("persist:profile-" + id).cookies.set()`
and `flushStore()`: the same Cookies API as `session.defaultSession.cookies`,
scoped to each workspace so manager and sibling profile sessions stay isolated.
See the [Electron Cookies API](https://www.electronjs.org/docs/latest/api/cookies)
and [persistent session partitions](https://www.electronjs.org/docs/latest/api/session).

Adios `EncryptedSettingsStore` uses an opt-in `maxRecordBytes` of 5 MiB for this
vault, covering the bounded cookie payload and settings envelope. Other settings
and hardware records retain their existing default limits. Writes retain Adios's
authentication, per-profile locking and atomic replacement behavior.
