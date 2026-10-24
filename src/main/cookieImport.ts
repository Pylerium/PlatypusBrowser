import { isIP } from "node:net";
import type { ImportedCookie } from "../shared/types";

const maxBytes = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function normalizeCookies(value: unknown): ImportedCookie[] {
  if (!Array.isArray(value) || value.length > 3000) throw new Error("Cookie imports must contain an array of at most 3000 cookies.");
  const cookies = new Map<string, ImportedCookie>();
  value.forEach((raw, index) => {
    try {
      if (!object(raw) || typeof raw.name !== "string" || typeof raw.value !== "string") throw 0;
      if (/[\x00-\x20\x7f()<>@,;:\\"/\[\]?={}]/.test(raw.name) || /[\x00-\x1f\x7f;]/.test(raw.value) || Buffer.byteLength(raw.name + raw.value) > 4096) throw 0;
      for (const flag of ["secure", "httpOnly", "hostOnly", "session", "partitioned"]) if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") throw 0;
      if (raw.partitionKey !== undefined || raw.partitioned === true || (raw.firstPartyDomain !== undefined && raw.firstPartyDomain !== "")) throw 0;
      let url: URL | undefined;
      if (raw.url !== undefined) {
        if (typeof raw.url !== "string") throw 0;
        url = new URL(raw.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw 0;
      }
      let domain: string | undefined;
      if (raw.domain !== undefined) {
        if (typeof raw.domain !== "string" || !raw.domain || /[\s/:@?#\\]/.test(raw.domain)) throw 0;
        const dotted = raw.domain.startsWith(".");
        const host = raw.domain.replace(/^\./, "").toLowerCase();
        if (!host || host.startsWith(".") || host.includes("..") || host.endsWith(".")) throw 0;
        const normalized = new URL("https://" + host).hostname;
        domain = (dotted ? "." : "") + normalized;
        if (url && url.hostname !== normalized && !((raw.hostOnly === false || (dotted && raw.hostOnly !== true)) && url.hostname.endsWith("." + normalized))) throw 0;
      }
      if (!url && !domain) throw 0;
      const secure = raw.secure === undefined ? url?.protocol === "https:" : raw.secure;
      const host = domain?.replace(/^\./, "") ?? url!.hostname;
      const path = raw.path ?? "/";
      if (typeof path !== "string" || !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path) || path.length > 2048) throw 0;
      url ??= new URL(`${secure ? "https" : "http"}://${host}${path}`);
      if (secure && url.protocol !== "https:") throw 0;
      const hostOnly = raw.hostOnly === true || (!domain || (!domain.startsWith(".") && raw.hostOnly !== false)) || isIP(host) !== 0;
      const sameSiteMap: Record<string, ImportedCookie["sameSite"]> = { unspecified: "unspecified", none: "no_restriction", no_restriction: "no_restriction", lax: "lax", strict: "strict" };
      const sameSite = raw.sameSite === undefined ? "unspecified" : typeof raw.sameSite === "string" ? sameSiteMap[raw.sameSite.toLowerCase()] : undefined;
      if (!sameSite || (sameSite === "no_restriction" && !secure)) throw 0;
      const expiry = raw.expirationDate ?? raw.expires ?? raw.expiration;
      if (expiry !== undefined && (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry < -1 || expiry > 253402300799)) throw 0;
      if (raw.name.startsWith("__Secure-") && !secure) throw 0;
      if (raw.name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/")) throw 0;
      const cookie: ImportedCookie = { url: url.origin + path, name: raw.name, value: raw.value, path, secure: Boolean(secure), httpOnly: raw.httpOnly === true, sameSite,
        ...(!hostOnly ? { domain: "." + host } : {}),
        ...(raw.session !== true && typeof expiry === "number" && expiry > 0 ? { expirationDate: expiry } : {}) };
      cookies.set(JSON.stringify([host, path, cookie.name]), cookie);
    } catch { throw new Error(`Invalid or unsupported cookie at position ${index + 1}.`); }
  });
  const result = [...cookies.values()];
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error("Cookie import exceeds 4 MiB.");
  return result;
}

export function parseCookieImport(contents: unknown): ImportedCookie[] {
  if (typeof contents !== "string" || Buffer.byteLength(contents) > maxBytes) throw new Error("Provide a cookie file no larger than 4 MiB.");
  const text = contents.replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("Cookie file is empty.");
  if (text.trimStart().startsWith("[") || text.trimStart().startsWith("{")) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("Cookie JSON is malformed."); }
    return normalizeCookies(object(value) && Array.isArray(value.cookies) ? value.cookies : value);
  }
  const rows: unknown[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) return;
    const httpOnly = line.startsWith("#HttpOnly_");
    const fields = (httpOnly ? line.slice(10) : line).split("\t");
    if (fields.length !== 7 || !/^(TRUE|FALSE)$/i.test(fields[1]!) || !/^(TRUE|FALSE)$/i.test(fields[3]!) || !/^\d+$/.test(fields[4]!)) throw new Error(`Invalid Netscape cookie row ${index + 1}.`);
    rows.push({ domain: fields[0], hostOnly: fields[1]!.toUpperCase() === "FALSE", path: fields[2], secure: fields[3]!.toUpperCase() === "TRUE", expirationDate: Number(fields[4]), name: fields[5], value: fields[6], httpOnly });
  });
  if (!rows.length) throw new Error("No Netscape cookie records found.");
  return normalizeCookies(rows);
}
