import type { ProxyProfileInput, ProxyProtocol } from "./types";

export function normalizeProxy(value: unknown): ProxyProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proxy endpoint.");
  const raw = value as Record<string, unknown>;
  if (!["http", "https", "socks5"].includes(raw.protocol as string) || typeof raw.host !== "string" ||
      typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) throw new Error("Invalid proxy endpoint.");
  const host = raw.host.trim();
  if (!host || host.length > 253 || /[\s/@?#\\\u0000-\u001f]/.test(host)) throw new Error("Invalid proxy endpoint.");
  let normalizedHost: string;
  try { normalizedHost = new URL(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${raw.port}`).hostname; }
  catch { throw new Error("Invalid proxy endpoint."); }
  if ((raw.username !== undefined && typeof raw.username !== "string") || (raw.password !== undefined && typeof raw.password !== "string")) throw new Error("Invalid proxy credentials.");
  const username = (raw.username as string | undefined)?.trim() ?? "", password = (raw.password as string | undefined) ?? "";
  if (Boolean(username) !== Boolean(password) || username.length > 256 || password.length > 1024 || /[:\u0000-\u001f\u007f]/.test(username) || /[\u0000-\u001f\u007f]/.test(password)) throw new Error("Invalid proxy credentials.");
  if (raw.protocol === "socks5" && (new TextEncoder().encode(username).length > 255 || new TextEncoder().encode(password).length > 255)) throw new Error("SOCKS5 credentials must fit within 255 bytes each.");
  return { protocol: raw.protocol as ProxyProtocol, host: normalizedHost.toLowerCase(), port: raw.port, ...(username ? { username, password } : {}) };
}

export function parseProxyList(text: string, defaultProtocol: ProxyProtocol = "http"): ProxyProfileInput[] {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 200000 || !["http", "https", "socks5"].includes(defaultProtocol)) throw new Error("Proxy import exceeds its limit or uses an unsupported protocol.");
  const source = text.replace(/^\uFEFF/, "").trim();
  let rows: unknown[];
  if (source.startsWith("[") && !/^\[[0-9a-f:]+\]:/i.test(source)) {
    try { const parsed: unknown = JSON.parse(source); if (!Array.isArray(parsed)) throw 0; rows = parsed; }
    catch { throw new Error("Proxy JSON must be an array of endpoints."); }
  } else rows = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rows.length || rows.length > 100) throw new Error("Import between 1 and 100 proxy lines.");
  const seen = new Set<string>();
  return rows.map((row, index) => {
    let proxy: ProxyProfileInput;
    try {
      let input: unknown = row;
      if (typeof row === "string") {
        if (row.includes("://")) {
          const url = new URL(row);
          if ((url.pathname && url.pathname !== "/") || url.search || url.hash) throw 0;
          const protocol = url.protocol.slice(0, -1);
          input = { protocol, host: url.hostname, port: Number(url.port || ({ http: 80, https: 443, socks5: 1080 } as Record<string, number>)[protocol]), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
        } else {
          const match = /^(\[[^\]]+\]|[^:\s]+):(\d+)(?::([^:]+):(.+))?$/.exec(row);
          if (!match) throw 0;
          input = { protocol: defaultProtocol, host: match[1], port: Number(match[2]), username: match[3], password: match[4] };
        }
      } else if (row && typeof row === "object") input = { protocol: defaultProtocol, ...row };
      proxy = normalizeProxy(input);
    } catch { throw new Error(`Proxy line ${index + 1}: invalid endpoint or credentials.`); }
    const endpoint = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
    if (seen.has(endpoint)) throw new Error(`Proxy line ${index + 1}: duplicate endpoint.`);
    seen.add(endpoint);
    return proxy;
  });
}
