// Where an agent's sessions live. Every session operation goes through the agent's
// transport; the local one runs claude on this machine, and an agent with a host goes through that
// host's daemon (remote.ts).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBin } from "./claude-bin.js";
import type { Agent, Repo } from "./config.js";
import type { Session } from "./fleet.js";
import type { Phase } from "./launch.js";
import { remote, type Unreachable } from "./remote.js";
import type { Workspace } from "./workspace.js";
import { die, run } from "./util.js";
import { branchPushed, ensureWorktree, git, worktreeDirty, worktreePath } from "./worktree.js";

// What starting a session needs.
// The transport writes the appendix and settings files on the machine that runs claude,
// so args() is called there, with the appendix file's path.
export interface StartRequest {
  agent: Agent;
  cwd: string;
  prompt: string;
  appendix: string | null;
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
  pushed: boolean;
}

// `where` names the place the sessions live, and listings are keyed by it, so two transports with
// the same `where` are taken for one.
export interface Transport {
  readonly where: string;
  // Throws Unreachable (remote.ts) when a host cannot be asked.
  sessions(includeDone?: boolean): Session[];
  // For the board, which must not block on a listing. Resolves to Unreachable rather than throwing it.
  sessionsAsync(): Promise<Session[] | Unreachable>;
  alive(s: Session | null | undefined): s is Session;
  // The launch id claude printed, or "?".
  start(req: StartRequest): string;
  // said: claude's stdout. why: its stderr (else stdout), read when the session does not come back.
  respawn(name: string, id: string): { ok: boolean; said: string; why: string };
  stop(name: string, id: string, remove: boolean): void;
  // The worktree for the item, made or reused (worktree.ts's ensureWorktree); throws when it cannot.
  worktree(q: WorktreeRequest): { wt: string; how: string };
  worktreeLeft(q: WorktreeRequest): WorktreeLeft;
  removeWorktree(q: WorktreeRequest): { ok: boolean; said: string };
  // For the doctor: the checkout's top level and its origin url, or null for a top that is none.
  checkout(repo: Repo): { top: string | null; origin: string };
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

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

export const local: Transport = {
  where: "local",
  sessions(includeDone = false) {
    const r = run(claudeBin(), ["agents", "--json", ...(includeDone ? ["--all"] : [])]);
    if (r.status !== 0) die(`\`claude agents --json\` failed: ${r.stderr.trim()}`);
    try {
      return parse(r.stdout);
    } catch {
      return die("`claude agents --json` returned something that is not JSON");
    }
  },
  sessionsAsync() {
    return new Promise((res) => {
      execFile(claudeBin(), ["agents", "--json"], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        try {
          res(err ? [] : parse(stdout));
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
      path = join(tmpdir(), `sf-${req.agent.name}-${randomBytes(4).toString("hex")}.md`);
      writeFileSync(path, req.appendix, { flag: "wx" });
    }
    const r = run(claudeBin(), req.args(path), { cwd: req.cwd, env: req.env });
    if (r.status !== 0) die(`claude --bg failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return /backgrounded · (\w+) · /.exec(r.stdout)?.[1] ?? "?";
  },
  respawn(_name, id) {
    const r = run(claudeBin(), ["respawn", id]);
    return { ok: r.status === 0, said: r.stdout.trim(), why: r.stderr.trim() || r.stdout.trim() };
  },
  stop(_name, id, remove) {
    run(claudeBin(), ["stop", id]);
    if (remove) run(claudeBin(), ["rm", id]);
  },
  worktree(q) {
    return ensureWorktree(q.repo.path, q.ticket, q.repo.base, q.repo.gitOver);
  },
  worktreeLeft(q) {
    const wt = worktreePath(q.repo.path, q.ticket);
    if (!isDir(wt)) return { exists: false, dirty: [], pushed: true };
    return { exists: true, dirty: worktreeDirty(wt, q.toolWritten), pushed: branchPushed(wt, q.repo.base) };
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

const stamp = (s: Session) =>
  [s.updatedAt, s.startedAt, s.createdAt].map((x) => Date.parse(x ?? "")).find(Number.isFinite) ?? -Infinity;

// An agent's session among several by its name: the newest live one, else the newest.
// The listing's order is not documented, so "newest" is the latest timestamp it carries.
export function pick(t: Transport, hits: Session[]): Session | null {
  const newest = [...hits].sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));
  return newest.find((s) => t.alive(s)) ?? newest[0] ?? null;
}

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
