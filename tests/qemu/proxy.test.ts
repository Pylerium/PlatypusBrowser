import assert from "node:assert/strict";
import { createServer, createConnection } from "node:net";
import type { Socket } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { ProxyGateway } from "../../src/main/qemu/proxyGateway";
import { parseProxyList } from "../../src/shared/proxyList";

async function read(socket: Socket, size: number): Promise<Buffer> {
  while (true) { const data = socket.read(size); if (data) return data; await once(socket, "readable"); }
}
async function connect(port: number, target = "example.com", targetPort = 443): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect"); socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual(await read(socket, 2), Buffer.from([5, 0]));
  const host = Buffer.from(target);
  const targetBytes = Buffer.alloc(2); targetBytes.writeUInt16BE(targetPort);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, targetBytes]));
  return socket;
}

test("gateway authenticates CONNECT, preserves tunnel bytes and closes active connections", async (t) => {
  let header = "";
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (data) => {
      header = data.toString();
      socket.write("HTTP/1.1 200 Connection established\r\n\r\nhello");
      socket.on("data", (chunk) => socket.write(chunk));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gateway = await ProxyGateway.create({ protocol: "http", host: "127.0.0.1", port: (server.address() as { port: number }).port, hasCredentials: true }, { username: "test", password: "secret" });
  t.after(() => { gateway.close(); server.close(); });
  const socket = await connect(gateway.port); t.after(() => socket.destroy());
  assert.equal((await read(socket, 10))[1], 0);
  assert.equal((await read(socket, 5)).toString(), "hello");
  assert.match(header, /^CONNECT example.com:443 HTTP\/1.1/);
  assert.ok(header.includes("Proxy-Authorization: Basic " + Buffer.from("test:secret").toString("base64")));
  socket.write("payload"); assert.equal((await read(socket, 7)).toString(), "payload");
  const closed = once(socket, "close"); socket.resume(); gateway.close(); await closed;
});

test("upstream rejection fails closed and returns no upstream authentication body", async (t) => {
  const server = createServer((socket) => { socket.on("error", () => undefined); socket.once("data", () => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\nprivate response")); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gateway = await ProxyGateway.create({ protocol: "http", host: "127.0.0.1", port: (server.address() as { port: number }).port, hasCredentials: false });
  t.after(() => { gateway.close(); server.close(); });
  const socket = await connect(gateway.port); t.after(() => socket.destroy());
  assert.equal((await read(socket, 10))[1], 1);
});

test("Webshare import accepts CRLF and colons in passwords, rejects malformed lines without exposing secrets", () => {
  const values = parseProxyList("\uFEFF127.0.0.1:8080:user:pass:word\r\n\r\n");
  assert.equal(values[0]!.protocol, "http"); assert.equal(values[0]!.password, "pass:word");
  assert.throws(() => parseProxyList("127.0.0.1:99999:user:private"), /^Error: Proxy line 1: invalid endpoint or credentials\.$/);
  assert.throws(() => parseProxyList("bad-private-line"), /Proxy line 1: invalid/);
  assert.throws(() => parseProxyList("127.0.0.1:80:u:p\n127.0.0.1:80:u:p"), /duplicate endpoint/);
});

test("SOCKS5 authentication stays in the gateway and is never sent into the target tunnel", async (t) => {
  let observed = "";
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    void (async () => {
      assert.deepEqual(await read(socket, 3), Buffer.from([5, 1, 2])); socket.write(Buffer.from([5, 2]));
      const auth = await read(socket, 2); assert.equal(auth[0], 1);
      const username = (await read(socket, auth[1]!)).toString();
      const password = (await read(socket, (await read(socket, 1))[0]!)).toString();
      observed = `${username}:${password}`; socket.write(Buffer.from([1, 0]));
      const request = await read(socket, 5); assert.deepEqual(request.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
      assert.equal((await read(socket, request[4]!)).toString(), "example.com"); await read(socket, 2);
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]));
      socket.on("data", (data) => socket.write(data)); socket.resume();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gateway = await ProxyGateway.create({ protocol: "socks5", host: "127.0.0.1", port: (server.address() as { port: number }).port, hasCredentials: true }, { username: "fixture-user", password: "fixture-password" });
  t.after(() => { gateway.close(); server.close(); });
  const socket = await connect(gateway.port); t.after(() => socket.destroy());
  assert.equal((await read(socket, 10))[1], 0); assert.equal(observed, "fixture-user:fixture-password");
  socket.write("target-data"); assert.equal((await read(socket, 11)).toString(), "target-data");
});

test("gateway routes loopback diagnostics directly without sending proxy credentials", async (t) => {
  let received = "";
  const server = createServer((socket) => { socket.on("error", () => undefined); socket.on("data", (chunk) => { received += chunk.toString(); socket.write("ok"); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gateway = await ProxyGateway.create({ protocol: "http", host: "127.0.0.1", port: 9, hasCredentials: true }, { username: "private-proxy-user", password: "private-proxy-password" });
  t.after(() => { gateway.close(); server.close(); });
  const socket = await connect(gateway.port, "localhost", (server.address() as { port: number }).port);
  t.after(() => socket.destroy());
  assert.equal((await read(socket, 10))[1], 0);
  socket.write("diagnostic"); assert.equal((await read(socket, 2)).toString(), "ok");
  assert.equal(received, "diagnostic");
});
