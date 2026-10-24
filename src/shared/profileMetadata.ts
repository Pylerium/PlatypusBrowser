import { validateRuntime } from "./runtime";
import { normalizeBypassRules } from "./sessionConfig";
import { normalizeProxy } from "./proxyList";
import type { BrowserProfile, ProfileInput } from "./types";

export function normalizeTenant(value: unknown = "default"): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new Error("Tenant IDs must contain 1–64 letters, digits, dots, underscores or hyphens.");
  return value;
}

export function exportProfileMetadata(profile: BrowserProfile): string {
  return JSON.stringify({ format: "platypus-profile", version: 1, tenantId: normalizeTenant(profile.tenantId),
    name: profile.name, startUrl: profile.startUrl, runtime: validateRuntime(profile.runtime),
    proxy: profile.proxy ? { protocol: profile.proxy.protocol, host: profile.proxy.host, port: profile.proxy.port, requiresCredentials: profile.proxy.hasCredentials } : null,
    proxyBypassRules: normalizeBypassRules(profile.session?.proxyBypassRules), cookieCount: profile.session?.cookieCount ?? 0,
  }, null, 2);
}

/** Metadata clones get fresh IDs and no cookies or credentials. */
export function importProfileMetadata(contents: unknown): ProfileInput {
  if (typeof contents !== "string" || new TextEncoder().encode(contents).length > 65536) throw new Error("Profile metadata must fit within 64 KiB.");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(contents); } catch { throw new Error("Malformed profile metadata JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format !== "platypus-profile" || raw.version !== 1 ||
      typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 64 || typeof raw.startUrl !== "string" || raw.startUrl.length > 2048) throw new Error("Unsupported profile metadata.");
  const allowed = new Set(["format", "version", "tenantId", "name", "startUrl", "runtime", "proxy", "proxyBypassRules", "cookieCount"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("Profile metadata contains unsupported fields. Import cookies and credentials separately.");
  if (raw.cookieCount !== undefined && (!Number.isSafeInteger(raw.cookieCount) || (raw.cookieCount as number) < 0 || (raw.cookieCount as number) > 3000)) throw new Error("Invalid metadata cookie count.");
  let url: URL;
  try { url = new URL(raw.startUrl); } catch { throw new Error("Invalid metadata start URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid metadata start URL.");
  let proxy: ProfileInput["proxy"] = null;
  if (raw.proxy !== null) {
    if (!raw.proxy || typeof raw.proxy !== "object" || Array.isArray(raw.proxy) || Object.keys(raw.proxy).some((key) => !["protocol", "host", "port", "requiresCredentials"].includes(key))) throw new Error("Proxy metadata must not contain credentials.");
    const requiresCredentials = (raw.proxy as Record<string, unknown>).requiresCredentials;
    if (requiresCredentials !== undefined && typeof requiresCredentials !== "boolean") throw new Error("Invalid proxy metadata credential flag.");
    proxy = normalizeProxy(raw.proxy);
  }
  return { tenantId: normalizeTenant(raw.tenantId), name: raw.name.trim(), startUrl: url.toString(), proxy,
    runtime: validateRuntime(raw.runtime), proxyBypassRules: normalizeBypassRules(raw.proxyBypassRules) };
}
