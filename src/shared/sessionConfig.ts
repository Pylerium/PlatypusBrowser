export const localProxyBypassRules = ["127.0.0.1", "localhost", "*.local", "[::1]"];

/** A portable hostname-only subset shared by Chromium, Node and guest routing. */
export function normalizeBypassRules(value: unknown = []): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Use at most 100 proxy bypass hosts.");
  const rules = value.map((raw) => {
    if (typeof raw !== "string") throw new Error("Invalid proxy bypass host.");
    const rule = raw.trim().toLowerCase();
    if (rule !== "[::1]" && !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(rule)) throw new Error("Proxy bypass rules must be hostnames, IPv4 addresses or *.domain patterns.");
    if (rule.includes("..") || rule.split(".").some((label) => label.length > 63)) throw new Error("Invalid proxy bypass host.");
    return rule;
  });
  return [...new Set([...localProxyBypassRules, ...rules])];
}

export function noProxyValue(rules: string[]): string {
  return normalizeBypassRules(rules).map((rule) => rule.startsWith("*.") ? rule.slice(1) : rule === "[::1]" ? "::1" : rule).join(",");
}

export function bypassesProxy(host: string, rules: string[]): boolean {
  let hostname = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname.includes(":")) { try { hostname = new URL(`http://[${hostname}]`).hostname.replace(/^\[|\]$/g, ""); } catch { return false; } }
  return normalizeBypassRules(rules).some((rule) => rule.startsWith("*.")
    ? hostname.endsWith(rule.slice(1)) : hostname === rule.replace(/^\[|\]$/g, ""));
}
