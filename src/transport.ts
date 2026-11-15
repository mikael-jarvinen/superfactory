// Where an agent's sessions live. Every session operation goes through the agent's
// transport; the local one runs claude on this machine, and an agent with a host goes through that
// host's daemon (remote.ts).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, Repo } from "./config.js";
import type { Session } from "./fleet.js";
import type { Phase } from "./launch.js";
import { remote, Unreachable } from "./remote.js";
import { claudeEnv, claudeScoped, scopeCheck } from "./scope.js";
import type { Workspace } from "./workspace.js";
import { die, MAX_OUTPUT, run } from "./util.js";
import { branchPushed, ensureWorktree, git, worktreeDirty, worktreePath } from "./worktree.js";

// What starting a session needs.
// The transport writes the appendix and settings files on the machine that runs claude,
// so args() is called there, with the appendix file's path.
export interface StartRequest {
  agent: Agent;
  cwd: string;
  prompt: string;
  appendix: string | null;
  // The workspace's logs/run/, where a local start writes the appendix file.
  runDir: string;
  phase: Phase;
  args: (appendixPath: string | null) => string[];
  env: NodeJS.ProcessEnv;
}

// A builder's worktree for one item, under one of its repos' checkouts.
export interface WorktreeRequest {
  agent: Agent;
  repo: Repo;
  ticket: string;
  toolWritten: string[];
}

// What `factory stop` and a dispatch need to know before a worktree's session goes: whether the
// worktree is there, what is uncommitted in it (minus tool-written files), and whether its branch
// is pushed.
export interface WorktreeLeft {
  exists: boolean;
  dirty: string[];
  // why git could not say what is uncommitted; `dirty` is then empty and `pushed` false
  unreadable?: string;
  pushed: boolean;
}

// `where` names the place the sessions live, and listings are keyed by it, so two transports with
// the same `where` are taken for one.
export interface Transport {
  readonly where: string;
  // Within LISTING_TIMEOUT_MS. Throws Unreachable (remote.ts) when a host cannot be asked, or a local
  // listing timed out.
  sessions(includeDone?: boolean): Session[];
  // For the board, which must not block on a listing. Resolves to Unreachable rather than throwing it.
  sessionsAsync(): Promise<Session[] | Unreachable>;
  alive(s: Session | null | undefined): s is Session;
  // The launch id claude printed, or "?".
  start(req: StartRequest): string;
  // said: claude's stdout. why: its stderr (else stdout), read when the session does not come back.
  // Within timeoutMs; one too short for a respawn is a failure, not a longer call.
  respawn(name: string, id: string, timeoutMs?: number): { ok: boolean; said: string; why: string };
  stop(name: string, id: string, remove: boolean): void;
  // The worktree for the item, made or reused (worktree.ts's ensureWorktree); throws when it cannot.
  worktree(q: WorktreeRequest): { wt: string; how: string };
  worktreeLeft(q: WorktreeRequest): WorktreeLeft;
  removeWorktree(q: WorktreeRequest): { ok: boolean; said: string };
  // For the doctor: the checkout's top level and its origin url, or null for a top that is none.
  checkout(repo: Repo): { top: string | null; origin: string };
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

// When a session last did anything: its transcript's mtime, under claude's projects/ by the cwd with
// every character but a letter or digit made "-". The listing gives a session only startedAt, and one
// started earlier may have talked since. Undefined when the transcript is not found.
export function transcriptAt(s: Session): number | undefined {
  if (typeof s.sessionId !== "string" || !/^[\w-]+$/.test(s.sessionId) || typeof s.cwd !== "string") return undefined;
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    return statSync(join(dir, "projects", s.cwd.replace(/[^A-Za-z0-9]/g, "-"), `${s.sessionId}.jsonl`)).mtimeMs;
  } catch {
    return undefined;
  }
}

const withActivity = (rows: Session[]): Session[] =>
  rows.map((s) => {
    const at = transcriptAt(s);
    return at === undefined ? s : { ...s, activeAt: at };
  });

const parse = (stdout: string): Session[] => JSON.parse(stdout || "[]") as Session[];

// `claude agents --json` is a registry, not a probe: after the daemon retires an idle worker and
// exits, the listing keeps the session at its last state. The roster names the supervisor pid; a
// dead pid or a missing control socket means no background session is alive, whatever the listing
// says. These are undocumented Claude Code internals, so they stay behind this one function.
// Probed on every call, never cached.
export function daemonAlive(): boolean {
  try {
    const roster = JSON.parse(readFileSync(join(homedir(), ".claude", "daemon", "roster.json"), "utf8")) as { supervisorPid?: unknown };
    const pid = Number.parseInt(String(roster.supervisorPid), 10);
    if (!Number.isInteger(pid)) return false;
    process.kill(pid, 0);
    const base = join("/tmp", `cc-daemon-${process.getuid?.() ?? ""}`);
    return readdirSync(base).some((d) => !d.startsWith(".") && existsSync(join(base, d, "control.sock")));
  } catch {
    return false;
  }
}

// A background session that has not stopped or failed, behind a daemon that is running. "done"
// means it finished a turn and is idle; it still wakes on SendMessage, so it counts as alive.
export function sessionAlive(s: Session | null | undefined): s is Session {
  return !!s && s.kind === "background" && s.state !== "stopped" && s.state !== "failed" && daemonAlive();
}

// A listing that hangs is cut off here, so a caller with a deadline can count on it.
export const LISTING_TIMEOUT_MS = 20_000;

const scoped = (argv: string[], timeout?: number) => scopeCheck(argv, run(...claudeScoped(argv), { env: claudeEnv(), ...(timeout ? { timeout } : {}) }, `claude ${argv[0]}`));
export const local: Transport = {
  where: "local",
  sessions(includeDone = false) {
    const r = scoped(["agents", "--json", ...(includeDone ? ["--all"] : [])], LISTING_TIMEOUT_MS);
    // A listing that timed out is no answer, as for a host that cannot be asked.
    if (r.status === 124) throw new Unreachable("local", `\`claude agents --json\` did not answer in ${LISTING_TIMEOUT_MS / 1000} s`);
    if (r.status !== 0) die(`\`claude agents --json\` failed: ${r.stderr.trim()}`);
    let rows: Session[];
    try {
      rows = parse(r.stdout);
    } catch {
      return die("`claude agents --json` returned something that is not JSON");
    }
    return withActivity(rows);
  },
  // As before, any failure here, a scope's included, is an empty listing.
  sessionsAsync() {
    return new Promise((res) => {
      execFile(...claudeScoped(["agents", "--json"]), { timeout: LISTING_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: claudeEnv() }, (err, stdout) => {
        try {
          res(err ? [] : withActivity(parse(stdout)));
        } catch {
          res([]);
        }
      });
    });
  },
  alive: sessionAlive,
  start(req) {
    let path: string | null = null;
    if (req.appendix) {
      path = appendixFile(req.runDir, req.agent.name, req.appendix);
    }
    const argv = req.args(path);
    const r = scopeCheck(argv, run(...claudeScoped(argv), { cwd: req.cwd, env: claudeEnv(req.env) }, `claude ${argv[0]}`));
    if (r.status !== 0) die(`claude --bg failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return /backgrounded · (\w+) · /.exec(r.stdout)?.[1] ?? "?";
  },
  respawn(_name, id, timeoutMs) {
    const r = scoped(["respawn", id], timeoutMs);
    return { ok: r.status === 0, said: r.stdout.trim(), why: r.stderr.trim() || r.stdout.trim() };
  },
  stop(_name, id, remove) {
    scoped(["stop", id]);
    if (remove) scoped(["rm", id]);
  },
  worktree(q) {
    return ensureWorktree(q.repo.path, q.ticket, q.repo.base, q.repo.gitOver);
  },
  worktreeLeft(q) {
    const wt = worktreePath(q.repo.path, q.ticket);
    if (!isDir(wt)) return { exists: false, dirty: [], pushed: true };
    const d = worktreeDirty(wt, q.toolWritten);
    // pushed false too, so a primary that predates `unreadable` still refuses to stop it.
    if (d.unreadable) return { exists: true, dirty: [], unreadable: d.unreadable, pushed: false };
    return { exists: true, dirty: d.paths, pushed: branchPushed(wt, q.repo.base) };
  },
  removeWorktree(q) {
    const r = git(q.repo.path, "worktree", "remove", worktreePath(q.repo.path, q.ticket));
    return { ok: r.status === 0, said: r.stderr.trim() };
  },
  checkout(repo) {
    if (!isDir(repo.path)) return { top: null, origin: "" };
    const top = git(repo.path, "rev-parse", "--show-toplevel");
    if (top.status !== 0) return { top: null, origin: "" };
    return { top: top.stdout.trim(), origin: git(repo.path, "remote", "get-url", "origin").stdout.trim() };
  },
};

// A session's appendix file. `claude respawn` reruns the session's old command line, and claude
// refuses a --append-system-prompt-file that is gone, so the file lives in the workspace's
// logs/run/, which a reboot keeps as it does not keep /tmp. It is named by its content: a respawn
// reads the brief its session started with even after the brief changed, and a brief launched again
// unchanged reuses its file. Written beside it and renamed, so a reader never sees half of one.
export function appendixFile(runDir: string, name: string, text: string): string {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, `appendix-${name}-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.md`);
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  }
  return path;
}

// One remote transport per host and workspace, so the agents on a host share it.
const remotes = new WeakMap<Workspace, Map<string, Transport>>();

export function transportFor(ws: Workspace, agent: Agent): Transport {
  return agent.host ? hostTransport(ws, agent.host, `agent ${agent.name}`) : local;
}

// The transport to the machine a repo's checkout is on.
export const repoTransport = (ws: Workspace, repo: Repo): Transport => (repo.host ? hostTransport(ws, repo.host, `repos.${repo.key}`) : local);

function hostTransport(ws: Workspace, name: string, whose: string): Transport {
  const host = ws.config.hosts[name];
  if (!host) die(`${whose}: no host ${name}`);
  let m = remotes.get(ws);
  if (!m) remotes.set(ws, (m = new Map()));
  let t = m.get(host.name);
  if (!t) m.set(host.name, (t = remote(host)));
  return t;
}

export function transports(ws: Workspace): Transport[] {
  const m = new Map<string, Transport>();
  for (const a of ws.config.agents) {
    const t = transportFor(ws, a);
    if (!m.has(t.where)) m.set(t.where, t);
  }
  return [...m.values()];
}

// A number is epoch milliseconds; Date.parse would read it as text and give NaN.
const instant = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : NaN);
const stamp = (s: Session) => [s.activeAt, s.updatedAt, s.startedAt, s.createdAt].map(instant).find(Number.isFinite) ?? -Infinity;

// Newest first: the latest activity, else the latest timestamp the listing carries, as its order is
// not documented.
const byNewest = (hits: Session[]) => [...hits].sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));

// An agent's session among several by its name: the newest live one, else the newest.
export function pick(t: Transport, hits: Session[]): Session | null {
  const newest = byNewest(hits);
  return newest.find((s) => t.alive(s)) ?? newest[0] ?? null;
}

// The newest of them, live or not: the one a wake respawns, the one last active where that is known.
export const newest = (hits: Session[]): Session | null => byNewest(hits)[0] ?? null;

export const isAgentSession = (name: string) => (s: Session) => s.kind === "background" && s.name === name;

// Each agent with its transport and its background sessions, from the listings by `where` (none
// for a transport not listed yet, or whose host could not be asked).
export function agentSessions(ws: Workspace, listing: (where: string) => Session[] | Unreachable | undefined): { agent: Agent; t: Transport; hits: Session[] }[] {
  return ws.config.agents.map((agent) => {
    const t = transportFor(ws, agent);
    const rows = listing(t.where);
    return { agent, t, hits: Array.isArray(rows) ? rows.filter(isAgentSession(agent.name)) : [] };
  });
}
