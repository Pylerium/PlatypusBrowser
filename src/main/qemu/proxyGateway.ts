import { createServer, createConnection, isIP } from "node:net";
import type { Server, Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type { ProxyCredentials, ProxySettings } from "../../shared/types";
import { bypassesProxy } from "../../shared/sessionConfig";

/** Read protocol frames without losing coalesced tunnel bytes. */
class Reader {
  private buffer = Buffer.alloc(0);
  private wake?: () => void;
  private ended = false;
  private readonly data = (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake?.(); };
  private readonly end = () => { this.ended = true; this.wake?.(); };
  constructor(private readonly socket: Socket) {
    socket.on("data", this.data); socket.on("close", this.end); socket.on("error", this.end);
  }
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.ended) throw new Error("Proxy connection closed.");
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
    const result = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return result;
  }
  async headers(): Promise<string> {
    let result = "";
    while (!result.endsWith("\r\n\r\n")) {
      if (result.length >= 16384) throw new Error("Oversized proxy response.");
      result += (await this.read(1)).toString("latin1");
    }
    return result;
  }
  release(): void {
    this.socket.pause(); this.socket.off("data", this.data); this.socket.off("close", this.end); this.socket.off("error", this.end);
    if (this.buffer.length) this.socket.unshift(this.buffer);
  }
}

/** Per-VM SOCKS gateway. Only the configured upstream is ever dialled. */
export class ProxyGateway {
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private mux?: Server;
  private constructor(private readonly server: Server, private readonly proxy: ProxySettings, private readonly credentials?: ProxyCredentials, private readonly bypassRules: string[] = []) {}
  get port(): number { return ((this.mux ?? this.server).address() as { port: number }).port; }
  static async create(proxy: ProxySettings, credentials?: ProxyCredentials, bypassRules: string[] = []): Promise<ProxyGateway> {
    const server = createServer();
    const gateway = new ProxyGateway(server, proxy, credentials, bypassRules);
    server.on("connection", (socket) => { gateway.track(socket); void gateway.handle(socket); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return gateway;
  }
  /** QEMU character forwarding is one persistent byte stream; multiplex browser connections over it. */
  async enableMultiplexing(): Promise<void> {
    const socksPort = this.port;
    const mux = createServer((transport) => {
      this.track(transport); transport.setTimeout(0);
      const streams = new Map<number, Socket>();
      let buffer = Buffer.alloc(0);
      const send = (id: number, data: Buffer = Buffer.alloc(0)) => {
        const header = Buffer.alloc(8); header.writeUInt32BE(id); header.writeUInt32BE(data.length, 4);
        return transport.write(Buffer.concat([header, data]));
      };
      transport.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const id = buffer.readUInt32BE(), length = buffer.readUInt32BE(4);
          if (!id || length > 65536) { transport.destroy(); return; }
          if (buffer.length < length + 8) break;
          const data = buffer.subarray(8, length + 8); buffer = buffer.subarray(length + 8);
          let socket = streams.get(id);
          if (!length) { socket?.destroy(); streams.delete(id); continue; }
          if (!socket) {
            if (streams.size >= 1024) { transport.destroy(); return; }
            socket = createConnection({ host: "127.0.0.1", port: socksPort }); this.track(socket); socket.setTimeout(0);
            streams.set(id, socket);
            const stream = socket;
            stream.on("data", (payload: Buffer) => {
              if (!send(id, payload)) { stream.pause(); transport.once("drain", () => stream.resume()); }
            });
            stream.once("close", () => { if (streams.get(id) === stream) { streams.delete(id); if (!transport.destroyed) send(id); } });
          }
          if (!socket.write(data)) { transport.pause(); socket.once("drain", () => transport.resume()); }
        }
      });
      transport.once("close", () => { for (const socket of streams.values()) socket.destroy(); });
    });
    await new Promise<void>((resolve, reject) => { mux.once("error", reject); mux.listen(0, "127.0.0.1", resolve); });
    this.mux = mux;
  }
  private track(socket: Socket): void {
    this.sockets.add(socket); socket.on("error", () => undefined);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setTimeout(20000, () => socket.destroy());
  }
  private async handle(client: Socket): Promise<void> {
    let upstream: Socket | undefined;
    try {
      const reader = new Reader(client);
      const hello = await reader.read(2);
      if (hello[0] !== 5 || !(await reader.read(hello[1]!)).includes(0)) throw new Error("Unsupported SOCKS authentication.");
      client.write(Buffer.from([5, 0]));
      const request = await reader.read(4);
      if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) throw new Error("Only SOCKS CONNECT is supported.");
      let host: string;
      if (request[3] === 3) host = (await reader.read((await reader.read(1))[0]!)).toString("ascii");
      else if (request[3] === 1) host = [...await reader.read(4)].join(".");
      else if (request[3] === 4) {
        const bytes = await reader.read(16); host = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":");
      } else throw new Error("Invalid SOCKS address.");
      const portBytes = await reader.read(2);
      const port = portBytes.readUInt16BE();
      if (!host || /[^a-zA-Z0-9.\-_:]/.test(host) || !port) throw new Error("Invalid proxy target.");
      if (this.closed) throw new Error("Gateway closed.");
      const proxyHost = this.proxy.host.replace(/^\[|\]$/g, "");
      const direct = bypassesProxy(host, this.bypassRules);
      upstream = direct ? createConnection({ host: host === "localhost" ? "127.0.0.1" : host, port }) : this.proxy.protocol === "https"
        ? connectTls({ host: proxyHost, port: this.proxy.port, ...(isIP(proxyHost) ? {} : { servername: proxyHost }) })
        : createConnection({ host: proxyHost, port: this.proxy.port });
      this.track(upstream);
      const socket = upstream;
      await new Promise<void>((resolve, reject) => { socket.once(!direct && this.proxy.protocol === "https" ? "secureConnect" : "connect", resolve); socket.once("error", reject); socket.once("close", () => reject(new Error("Proxy disconnected."))); });
      const response = new Reader(socket);
      if (direct) {
        // Local diagnostic routes never receive upstream proxy credentials.
      } else if (this.proxy.protocol === "socks5") {
        socket.write(Buffer.from([5, 1, this.credentials ? 2 : 0]));
        const method = await response.read(2);
        if (method[0] !== 5 || method[1] !== (this.credentials ? 2 : 0)) throw new Error("SOCKS upstream rejected authentication.");
        if (this.credentials) {
          const username = Buffer.from(this.credentials.username), password = Buffer.from(this.credentials.password);
          if (!username.length || !password.length || username.length > 255 || password.length > 255) throw new Error("Invalid SOCKS credentials.");
          socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
          if (!(await response.read(2)).equals(Buffer.from([1, 0]))) throw new Error("SOCKS authentication failed.");
        }
        const domain = Buffer.from(host);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, portBytes]));
        const reply = await response.read(4);
        if (reply[0] !== 5 || reply[1] !== 0) throw new Error("SOCKS upstream refused connection.");
        const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await response.read(1))[0]! : -1;
        if (length < 0) throw new Error("Invalid upstream reply.");
        await response.read(length + 2);
      } else {
        const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
        const auth = this.credentials ? `Proxy-Authorization: Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString("base64")}\r\n` : "";
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
        if (!/^HTTP\/1\.[01] 200\b/.test(await response.headers())) throw new Error("Upstream proxy refused CONNECT or authentication.");
      }
      response.release(); reader.release();
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      client.setTimeout(0); socket.setTimeout(0);
      client.once("close", () => socket.destroy()); socket.once("close", () => client.destroy());
      client.pipe(socket); socket.pipe(client);
    } catch {
      upstream?.destroy();
      client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
    }
  }
  close(): void { this.closed = true; for (const socket of this.sockets) socket.destroy(); this.server.close(); this.mux?.close(); }
}
