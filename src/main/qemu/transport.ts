import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

// QEMU connects to a main-process-owned, ephemeral loopback listener. Unlike
// stdio, this is independent of Windows display backend console handling.
export class QmpTransport {
  readonly connection: Promise<Socket>;
  private accept!: (socket: Socket) => void;
  private reject!: (error: Error) => void;
  private socket?: Socket;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly server: Server;

  private constructor(timeoutMs: number) {
    this.connection = new Promise((resolve, reject) => { this.accept = resolve; this.reject = reject; });
    void this.connection.catch(() => undefined);
    this.server = createServer((socket) => {
      if (this.closed || this.socket || socket.remoteAddress !== "127.0.0.1") { socket.destroy(); return; }
      this.socket = socket;
      socket.setNoDelay(true);
      // Keep stream errors handled before QmpClient attaches its listeners.
      socket.on("error", () => undefined);
      clearTimeout(this.timer);
      this.server.close();
      this.accept(socket);
    });
    this.server.on("error", (error) => this.close(error));
    this.timer = setTimeout(() => this.close(new Error("QEMU control connection timed out.")), timeoutMs);
  }

  static async listen(timeoutMs: number): Promise<QmpTransport> {
    const transport = new QmpTransport(timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        transport.server.once("error", reject);
        transport.server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          transport.server.removeListener("error", reject);
          resolve();
        });
      });
      return transport;
    } catch (error) { transport.close(); throw error; }
  }

  get address(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("QMP listener is unavailable.");
    return `tcp:127.0.0.1:${address.port}`;
  }

  close(error = new Error("QEMU control connection closed.")): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.server.close();
    this.socket?.destroy();
    this.reject(error);
  }
}
