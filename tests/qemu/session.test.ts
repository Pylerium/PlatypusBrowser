import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCookies, parseCookieImport } from "../../src/main/cookieImport";
import { bypassesProxy, normalizeBypassRules, noProxyValue } from "../../src/shared/sessionConfig";

test("cookie JSON normalizes common exports and preserves scope, flags and expiry", () => {
  const cookies = parseCookieImport(JSON.stringify({ cookies: [
    { domain: ".example.com", path: "/private", name: "sid", value: "secret", secure: true, httpOnly: true, sameSite: "None", expires: 1900000000 },
    { url: "http://localhost:5000/", name: "local", value: "fixture", hostOnly: true, session: true, expires: -1 },
  ] }));
  assert.equal(cookies[0]!.domain, ".example.com"); assert.equal(cookies[0]!.sameSite, "no_restriction");
  assert.equal(cookies[0]!.expirationDate, 1900000000); assert.equal(cookies[0]!.httpOnly, true);
  assert.equal(cookies[1]!.domain, undefined); assert.equal(cookies[1]!.expirationDate, undefined);
  assert.deepEqual(normalizeCookies(cookies), cookies);
});

test("Netscape import supports HttpOnly comments, CRLF, session cookies and empty values", () => {
  const cookies = parseCookieImport("# Netscape HTTP Cookie File\r\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1900000000\tsid\tsecret\r\nlocalhost\tFALSE\t/\tFALSE\t0\tempty\t\r\n");
  assert.equal(cookies.length, 2); assert.equal(cookies[0]!.httpOnly, true);
  assert.equal(cookies[0]!.domain, ".example.com"); assert.equal(cookies[1]!.value, "");
  assert.equal(cookies[1]!.domain, undefined); assert.equal(cookies[1]!.expirationDate, undefined);
});

test("cookie parser rejects malformed data, unsafe flags, partition broadening and invalid scope without echoing secrets", () => {
  for (const value of [
    { name: "x", value: "secret", domain: "https://example.com" },
    { name: "x", value: "secret", url: "file:///secret" },
    { name: "x", value: "secret", domain: "example.com", url: "https://other.com" },
    { name: "x", value: "secret", domain: "example.com", url: "https://sub.example.com" },
    { name: "x", value: "secret", domain: "example.com", firstPartyDomain: "other.com" },
    { name: "x", value: "secret", domain: "example.com", secure: "false" },
    { name: "x", value: "secret", domain: "example.com", sameSite: "none", secure: false },
    { name: "x", value: "secret", domain: "example.com", partitionKey: "https://other.com" },
    { name: "__Host-x", value: "secret", domain: ".example.com", secure: true },
  ]) assert.throws(() => parseCookieImport(JSON.stringify([value])), /^Error: Invalid or unsupported cookie at position 1\.$/);
  assert.throws(() => parseCookieImport('[{"value":"secret"}'), /^Error: Cookie JSON is malformed\.$/);
  assert.throws(() => parseCookieImport("x\tFALSE\t/\tFALSE\tinvalid\tx\tsecret"), /row 1/);
  assert.throws(() => parseCookieImport(" ".repeat(4 * 1024 * 1024 + 1)), /4 MiB/);
});

test("bypass defaults are explicit, deduplicated and portable to no_proxy", () => {
  const rules = normalizeBypassRules(["LOCALHOST", "*.lab.internal"]);
  assert.equal(rules.filter((rule) => rule === "localhost").length, 1);
  for (const host of ["127.0.0.1", "localhost", "telemetry.local", "flask.lab.internal"]) assert.ok(bypassesProxy(host, rules));
  for (const host of ["localhost.example.com", "example.local.attacker.com", "example.com"]) assert.equal(bypassesProxy(host, rules), false);
  assert.ok(noProxyValue(rules).includes(".local")); assert.ok(noProxyValue(rules).includes(".lab.internal"));
  for (const invalid of [["*"], ["<-loopback>"], ["localhost;*"]]) assert.throws(() => normalizeBypassRules(invalid));
});
