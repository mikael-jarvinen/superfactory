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
// A builder with a host has its repos' checkouts there too, and its worktrees are made and checked
// there. These carry names only, never paths; the daemon finds the checkout, the base and the
// tool-written files in its own copy of the config (serveWorktree below does it for the daemon):
//
//   POST /agents/<name>/worktree          {repo, ticket} -> {wt, how}
//   POST /agents/<name>/worktree/left     {repo, ticket} -> {exists, dirty, pushed}
//   POST /agents/<name>/worktree/remove   {repo, ticket} -> {ok, said}
//   GET  /repos/<key>/checkout            {top, origin}, for the doctor
//
// On the worktree, worktree/left and worktree/remove routes, 422 {error} means the daemon was asked
// and refused the operation itself (a directory in the way of a worktree, say); that is an error
// here, not an unknown host. On every other route a 422 is an unknown host.
//
// Each request carries the token (Authorization: Bearer) and the sha256 of the host's hash_files,
// their bytes one after another in order (X-Factory-Hash): the daemon's config and the workspace
// config it renders launches from. A host that does not answer, or answers 401 or 409, is unknown:
// its agents are neither running nor stopped as far as this machine can tell.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Host } from "./config.js";
import { validKey } from "./state.js";
import type { Session } from "./fleet.js";
import { local, type Transport, type WorktreeRequest } from "./transport.js";
import type { Workspace } from "./workspace.js";
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
  return checked(h, exchange(h, method, path, body, timeoutMs), false);
}

const worktreeCall = (h: Host, op: string, q: WorktreeRequest, timeoutMs: number): Reply =>
  checked(h, exchange(h, "POST", agentPath(q.agent.name, op), names(q), timeoutMs), true);

function exchange(h: Host, method: string, path: string, body: unknown, timeoutMs: number): { reply: Reply; hash: string } {
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
  return { reply: { status: out.status as number, body: out.body ?? {} }, hash };
}

function checked(h: Host, { reply, hash }: { reply: Reply; hash: string }, refusable: boolean): Reply {
  if (refusable && reply.status === 422) throw new FactoryError(`on host ${h.name}: ${String(reply.body.error ?? "refused")}`);
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
const names = (q: WorktreeRequest) => ({ repo: q.repo.key, ticket: q.ticket });

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
    // A fetch of origin comes first, so this has a start's time.
    worktree(q) {
      const r = worktreeCall(h, "worktree", q, 120_000);
      if (typeof r.body.wt !== "string") throw new Unreachable(h.name, "its worktree reply has no wt");
      return { wt: r.body.wt, how: String(r.body.how ?? "") };
    },
    worktreeLeft(q) {
      const r = worktreeCall(h, "worktree/left", q, 30_000);
      if (typeof r.body.exists !== "boolean" || typeof r.body.pushed !== "boolean" || !Array.isArray(r.body.dirty))
        throw new Unreachable(h.name, "its worktree/left reply is not {exists, dirty, pushed}");
      return { exists: r.body.exists, dirty: r.body.dirty.map(String), pushed: r.body.pushed };
    },
    removeWorktree(q) {
      const r = worktreeCall(h, "worktree/remove", q, 30_000);
      return { ok: r.body.ok === true, said: String(r.body.said ?? "") };
    },
    checkout(repo) {
      const r = callSync(h, "GET", `/repos/${encodeURIComponent(repo.key)}/checkout`);
      return { top: typeof r.body.top === "string" ? r.body.top : null, origin: String(r.body.origin ?? "") };
    },
  };
}

// ---------------------------------------------------------------- the daemon's side

export type Served = { status: number; body: Record<string, unknown> };

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The worktree routes for a daemon whose host is `me`, after it has checked the token, the hash
// and its own roster: the agent must be a builder hosted here, the repo one of its repos, and the
// ticket a key this workspace takes. Paths come from this machine's config, never the request.
export function serveWorktree(ws: Workspace, me: string, name: string, op: string, body: Record<string, unknown>): Served {
  const agent = ws.config.agents.find((a) => a.name === name);
  if (!agent) return { status: 404, body: { error: `${name} is not in the workspace config` } };
  if (agent.host !== me) return { status: 404, body: { error: `${name} runs on ${agent.host ?? "the primary"}, not ${me}` } };
  if (agent.role !== "builder") return { status: 404, body: { error: `${name} is a ${agent.role}, and only a builder has worktrees` } };
  const { repo: key, ticket } = body;
  if (typeof key !== "string" || !agent.repos.includes(key))
    return { status: 400, body: { error: `repo must be one of ${name}'s repos: ${agent.repos.join(", ")}` } };
  if (typeof ticket !== "string" || !PLAIN.test(ticket) || ticket.includes("..") || !validKey(ws, ticket))
    return { status: 400, body: { error: "ticket must be a work item key" } };
  const repo = ws.config.repos[key]!;
  if (repo.host !== me) return { status: 404, body: { error: `repos.${key} is not on ${me}` } };
  const q: WorktreeRequest = { agent, repo, ticket, toolWritten: ws.config.worktree.toolWritten };
  try {
    if (op === "worktree") return { status: 200, body: { ...local.worktree(q) } };
    if (op === "worktree/left") return { status: 200, body: { ...local.worktreeLeft(q) } };
    if (op === "worktree/remove") return { status: 200, body: { ...local.removeWorktree(q) } };
  } catch (e) {
    if (e instanceof FactoryError) return { status: 422, body: { error: e.message } };
    throw e;
  }
  return { status: 404, body: { error: "no such route" } };
}

export function serveCheckout(ws: Workspace, me: string, key: string): Served {
  const repo = ws.config.repos[key];
  if (!repo || repo.host !== me) return { status: 404, body: { error: `no repo ${key} on ${me}` } };
  return { status: 200, body: { ...local.checkout(repo) } };
}

// For the doctor: why the host cannot be asked, or null when it answers.
export function probe(h: Host): string | null {
  const r = ask(() => listed(h, callSync(h, "GET", "/agents")));
  return r instanceof Unreachable ? r.why : null;
}
