import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProxyList } from "../../src/shared/proxyList";
import { exportProfileMetadata, importProfileMetadata, normalizeTenant } from "../../src/shared/profileMetadata";
import { ProxyDispatcher } from "../../src/main/proxyDispatcher";
import type { BrowserProfile } from "../../src/shared/types";

test("bulk endpoints support mixed protocols, JSON, IPv6 and percent-encoded credentials", () => {
  const values = parseProxyList("http://user:pass%40word@proxy.example.com:8080\nsocks5://sock:private@127.0.0.1:1080\n[::1]:3128");
  assert.deepEqual(values.map((proxy) => proxy.protocol), ["http", "socks5", "http"]);
  assert.equal(values[0]!.password, "pass@word"); assert.equal(values[2]!.host, "[::1]");
  assert.equal(parseProxyList("127.0.0.1:1080", "socks5")[0]!.protocol, "socks5");
  assert.equal(parseProxyList('[{"protocol":"socks5","host":"proxy.example.com","port":1080}]')[0]!.protocol, "socks5");
  for (const source of ["ftp://u:private@proxy:21", "socks5://user:private@proxy:1080/path", "proxy:123:u:private\nbad-private", "socks5://user:" + "a".repeat(256) + "@proxy:1080"]) {
    assert.throws(() => parseProxyList(source), (error: Error) => !error.message.includes("private") && /invalid/.test(error.message));
  }
});

const profile: BrowserProfile = { id: "08b51da8-4022-41ee-bd3b-df21a1432089", tenantId: "tenant-a", name: "Fixture", startUrl: "https://example.com/", runtime: { platform: "QA Platform", canvasSeed: 0 },
  proxy: { protocol: "socks5", host: "proxy.example.com", port: 1080, hasCredentials: true }, session: { revision: 1, cookieCount: 3, proxyBypassRules: ["*.lab.internal"] }, createdAt: "", updatedAt: "" };

test("profile metadata whitelists fields, excludes identity and secrets, and normalizes tenant/routing settings", () => {
  const exported = exportProfileMetadata({ ...profile, proxy: { ...profile.proxy, username: "private-user", password: "private-pass" }, cookies: [{ value: "private-cookie" }] } as BrowserProfile);
  assert.ok(!exported.includes("private-")); assert.ok(!exported.includes(profile.id));
  const imported = importProfileMetadata(exported);
  assert.equal(imported.tenantId, "tenant-a"); assert.equal(imported.runtime?.canvasSeed, 0);
  assert.equal(imported.proxy?.username, undefined); assert.ok(imported.proxyBypassRules!.includes("localhost"));
  const metadata = JSON.parse(exported);
  assert.throws(() => importProfileMetadata(JSON.stringify({ ...metadata, cookies: [] })), /unsupported fields/);
  assert.throws(() => importProfileMetadata(JSON.stringify({ ...metadata, proxy: { ...metadata.proxy, password: "secret" } })), /must not contain credentials/);
  assert.throws(() => importProfileMetadata(JSON.stringify({ ...metadata, startUrl: "https://user:secret@example.com" })), /start URL/);
  assert.equal(normalizeTenant(), "default"); assert.throws(() => normalizeTenant("../escape"));
});

test("dispatcher isolates profile listeners and releases routes without exporting credentials", async () => {
  const dispatcher = new ProxyDispatcher({ getProxyCredentials: async () => ({ username: "user", password: "secret" }) });
  try {
    const first = await dispatcher.localRules(profile, []);
    assert.equal(await dispatcher.localRules(profile, []), first);
    const second = await dispatcher.localRules({ ...profile, id: "second-profile" }, []);
    assert.notEqual(first, second); assert.ok(!first.includes("secret"));
    dispatcher.release(profile.id); assert.throws(() => dispatcher.expectedLocalRoute(profile.id), /unavailable/);
  } finally { dispatcher.close(); }
});
