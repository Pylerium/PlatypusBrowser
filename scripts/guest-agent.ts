/** Test/provisioning-only QGA connection. No agent endpoint is exposed by production launch. */
import { createConnection } from "node:net";
import type { Socket } from "node:net";

export class GuestAgent {
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 255) { this.buffer = ""; continue; }
        this.buffer += String.fromCharCode(byte);
      }
      if (this.buffer.length > 1024 * 1024) { this.close(); return; }
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
            else pending.resolve(message.return);
          }
        } catch { /* Synchronization discards stale serial fragments. */ }
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Guest agent disconnected.")));
  }
  static async connect(port: number): Promise<GuestAgent> {
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return new GuestAgent(socket);
  }
  command(execute: string, parameters: Record<string, unknown> = {}, timeoutMs = 5000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Guest agent ${execute} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ execute, arguments: parameters, id }) + "\n");
    });
  }
  async synchronize(): Promise<void> {
    this.socket.write(Buffer.from([255]));
    const token = Math.floor(Math.random() * 2147483647);
    if (await this.command("guest-sync-delimited", { id: token }, 2000) !== token) throw new Error("Guest agent synchronization failed.");
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  close(): void { this.socket.destroy(); this.fail(new Error("Guest agent closed.")); }
}
