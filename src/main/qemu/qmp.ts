import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex, Readable, Writable } from "node:stream";

export class QmpClient {
  private buffer = "";
  private sequence = 0;
  private closed = false;
  private greeted = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly greeting: Promise<void>;
  private greet!: () => void;
  private failGreeting!: (error: Error) => void;
  private readonly greetingTimer: NodeJS.Timeout;
  private readonly input: Readable;
  private readonly output: Writable;

  constructor(child: ChildProcessWithoutNullStreams, private readonly timeoutMs: number, private readonly event: (name: string) => void,
    private readonly failure: (error: Error) => void = () => undefined, connection?: Duplex) {
    this.input = connection ?? child.stdout;
    this.output = connection ?? child.stdin;
    this.greeting = new Promise((resolve, reject) => { this.greet = resolve; this.failGreeting = reject; });
    // Attach immediately, including while callers are preparing to await readiness.
    void this.greeting.catch(() => undefined);
    this.greetingTimer = setTimeout(() => this.close(new Error("QMP greeting timed out.")), timeoutMs);
    this.input.on("data", this.data);
    this.input.once("end", this.end);
    this.output.on("error", this.error);
    child.on("error", this.error);
    child.once("close", this.end);
  }

  private data = (chunk: Buffer): void => {
    if (this.closed) return;
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > 1024 * 1024) { this.close(new Error("QMP message exceeded its size limit.")); return; }
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid QMP message.");
        if (message.QMP && !this.greeted) { this.greeted = true; clearTimeout(this.greetingTimer); this.greet(); }
        if (typeof message.event === "string") this.event(message.event);
        if (typeof message.id === "number") {
          const request = this.pending.get(message.id);
          if (request) {
            this.pending.delete(message.id); clearTimeout(request.timer);
            if (message.error) request.reject(new Error("QMP command was rejected."));
            else if ("return" in message) request.resolve(message.return);
            else request.reject(new Error("Malformed QMP response."));
          }
        }
      } catch { this.close(new Error("Invalid QMP protocol output.")); return; }
    }
  };
  private error = (error: Error): void => { this.close(error); };
  private end = (): void => { this.close(new Error("QEMU control channel closed.")); };

  async initialize(): Promise<void> { await this.greeting; await this.command("qmp_capabilities", this.timeoutMs); }

  command(execute: string, timeoutMs = 3000, parameters?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("QMP connection is closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`QMP ${execute} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(JSON.stringify({ execute, id, ...(parameters ? { arguments: parameters } : {}) }) + "\n", (error) => { if (error) this.close(error); });
    });
  }

  close(error = new Error("QMP connection closed.")): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.greetingTimer);
    this.failGreeting(error);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.input.removeListener("data", this.data);
    this.failure(error);
    // Keep stdin's error listener until process close: a late EPIPE must not crash Electron.
  }
}
