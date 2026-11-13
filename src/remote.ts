// The remote transport: an agent with a `host` has its sessions on that machine, and every session
// operation is a request to the factory daemon there.
//
//   GET  /agents[?all=1]          {sessions}: that machine's `claude agents --json`, each session
//                                 with `alive`, which only that machine can tell
//   POST /agents/<name>/start     {cwd, prompt, appendix, phase} -> {id}; the daemon renders the
//                                 claude command line from its own copy of the config
//   POST /agents/<name>/respawn   {id} -> {ok, said, why}
//   POST /agents/<name>/stop      {id, remove}
//
// Each request carries the token (Authorization: Bearer) and the sha256 of the host's hash_files,
// their bytes one after another in order (X-Factory-Hash): the daemon's config and the workspace
// config it renders launches from. A host that does not answer, or answers 401 or 409, is unknown:
// its agents are neither running nor stopped as far as this machine can tell.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Host } from "./config.js";
import type { Session } from "./fleet.js";
import type { Transport } from "./transport.js";
import { FactoryError } from "./util.js";

export class Unreachable extends FactoryError {
  constructor(readonly host: string, readonly why: string) {
    super(`host ${host} is unknown: ${why}`);
  }

  // Which host and why, for a line that already says the agent is unknown.
  get brief(): string {
    return `host ${this.host}: ${this.why}`;
  }
}

// An Unreachable is the answer; anything else is thrown on.
export function unreachable(e: unknown): Unreachable {
  if (e instanceof Unreachable) return e;
  throw e;
}

export function ask<T>(f: () => T): T | Unreachable {
  try {
    return f();
  } catch (e) {
    return unreachable(e);
  }
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

// The token and the hash, read on each request so a rotated token or a pulled config needs no
// restart. A missing file makes the host unknown, saying which file.
function headers(h: Host): { headers: Record<string, string>; hash: string } {
  const read = (what: string, p: string) => {
    try {
      return readFileSync(p);
    } catch (e) {
      throw new Unreachable(h.name, `cannot read its ${what} ${p} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
  };
  const hash = createHash("sha256");
  for (const f of h.hashFiles) hash.update(read("hash_files entry", f));
  const ours = hash.digest("hex");
  return {
    headers: {
      authorization: `Bearer ${read("token_file", h.tokenFile).toString("utf8").trim()}`,
      "x-factory-hash": ours,
      "content-type": "application/json",
    },
    hash: ours,
  };
}

const refusal = (h: Host, r: Reply, ours: string): Unreachable | null =>
  r.status === 401 ? new Unreachable(h.name, "it refused the token")
  : r.status === 409 ? new Unreachable(h.name, `hash mismatch: the daemon's config hashes to ${String(r.body.hash ?? "?").slice(0, 12)}, ${h.hashFiles.join(" + ")} hash to ${ours.slice(0, 12)}`)
  : r.status >= 200 && r.status < 300 ? null
  : new Unreachable(h.name, `HTTP ${r.status}${r.body.error ? ` ${String(r.body.error)}` : ""}`);

// The CLI's calls are synchronous, as the local transport's are, so a request runs in a child node.
// The request goes on stdin, keeping the token out of the process list.
const CHILD = `
let input = "";
for await (const b of process.stdin) input += b;
const q = JSON.parse(input);
try {
  const res = await fetch(q.url, { method: q.method, headers: q.headers, body: q.body, signal: AbortSignal.timeout(q.timeoutMs) });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  console.log(JSON.stringify({ status: res.status, body }));
} catch (e) {
  console.log(JSON.stringify({ error: e.cause?.code ?? e.name ?? String(e) }));
}`;

function callSync(h: Host, method: string, path: string, body?: unknown, timeoutMs = 10_000): Reply {
  const { headers: hd, hash } = headers(h);
  const q = { url: h.url + path, method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], { input: JSON.stringify(q), encoding: "utf8", timeout: timeoutMs + 5000 });
  let out: Partial<Reply> & { error?: string };
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Unreachable(h.name, `the request did not finish (${r.error?.message ?? (r.stderr.trim() || `exit ${r.status ?? r.signal}`)})`);
  }
  if (out.error) throw new Unreachable(h.name, out.error);
  const reply = { status: out.status as number, body: out.body ?? {} };
  const no = refusal(h, reply, hash);
  if (no) throw no;
  return reply;
}

async function call(h: Host, method: string, path: string, timeoutMs = 10_000): Promise<Reply> {
  const { headers: hd, hash } = headers(h);
  let res: Response;
  try {
    res = await fetch(h.url + path, { method, headers: hd, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    throw new Unreachable(h.name, err.cause?.code ?? err.name);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const reply = { status: res.status, body };
  const no = refusal(h, reply, hash);
  if (no) throw no;
  return reply;
}

const listed = (h: Host, r: Reply): Session[] => {
  if (!Array.isArray(r.body.sessions)) throw new Unreachable(h.name, "its /agents reply has no sessions list");
  return r.body.sessions as Session[];
};

const agentPath = (name: string, op: string) => `/agents/${encodeURIComponent(name)}/${op}`;

export function remote(h: Host): Transport {
  return {
    where: h.name,
    sessions(includeDone = false) {
      return listed(h, callSync(h, "GET", `/agents${includeDone ? "?all=1" : ""}`, undefined, 20_000));
    },
    sessionsAsync() {
      return call(h, "GET", "/agents", 20_000).then((r) => listed(h, r)).catch(unreachable);
    },
    alive(s): s is Session {
      return !!s && s.kind === "background" && s.alive === true;
    },
    // The appendix goes as text, and the daemon writes it and renders the command line there.
    start(req) {
      const r = callSync(h, "POST", agentPath(req.agent.name, "start"), { cwd: req.cwd, prompt: req.prompt, appendix: req.appendix, phase: req.phase ?? null }, 60_000);
      return typeof r.body.id === "string" ? r.body.id : "?";
    },
    respawn(name, id) {
      const r = ask(() => callSync(h, "POST", agentPath(name, "respawn"), { id }, 60_000));
      if (r instanceof Unreachable) return { ok: false, said: "", why: r.message };
      return { ok: r.body.ok === true, said: String(r.body.said ?? ""), why: String(r.body.why ?? r.body.said ?? "") };
    },
    stop(name, id, remove) {
      callSync(h, "POST", agentPath(name, "stop"), { id, remove }, 30_000);
    },
  };
}

// For the doctor: why the host cannot be asked, or null when it answers.
export function probe(h: Host): string | null {
  const r = ask(() => listed(h, callSync(h, "GET", "/agents")));
  return r instanceof Unreachable ? r.why : null;
}
