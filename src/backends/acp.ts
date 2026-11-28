// The client end of the Agent Client Protocol (https://agentclientprotocol.com), version 1:
// JSON-RPC 2.0, one message per line, over the agent's stdin and stdout.
import type { Readable, Writable } from "node:stream";

export const PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(`${method}: ${message} (${code})`);
  }
}

type Handler = (params: any) => unknown | Promise<unknown>;

export class AcpPeer {
  private next = 1;
  private pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Handler>();
  private notes = new Map<string, (params: any) => void>();
  private buf = "";
  private closed: Error | null = null;

  // seen: every line either way, for the supervisor's log
  constructor(private out: Writable, input: Readable, private seen: (dir: "in" | "out", line: string) => void = () => {}) {
    input.setEncoding("utf8");
    input.on("data", (d: string) => this.feed(d));
    input.on("end", () => this.close(new Error("the agent closed its stdout")));
    input.on("error", (e) => this.close(e));
  }

  // Agent-to-client requests.
  handle(method: string, h: Handler): void {
    this.handlers.set(method, h);
  }

  // Agent-to-client notifications.
  on(method: string, h: (params: any) => void): void {
    this.notes.set(method, h);
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  close(why: Error): void {
    if (this.closed) return;
    this.closed = why;
    for (const p of this.pending.values()) p.reject(why);
    this.pending.clear();
  }

  private send(m: unknown): void {
    const line = JSON.stringify(m);
    this.seen("out", line);
    this.out.write(line + "\n");
  }

  private feed(d: string): void {
    this.buf += d;
    for (let i; (i = this.buf.indexOf("\n")) >= 0;) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.message(line);
    }
  }

  private message(line: string): void {
    this.seen("in", line);
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (typeof m.method === "string") {
      if (m.id === undefined || m.id === null) {
        this.notes.get(m.method)?.(m.params);
        return;
      }
      const h = this.handlers.get(m.method);
      if (!h) {
        this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => h(m.params))
        .then(
          (result) => this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null }),
          (e: unknown) => this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }),
        );
      return;
    }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new AcpError(p.method, Number(m.error.code), String(m.error.message ?? "error"), m.error.data));
    else p.resolve(m.result);
  }
}
