// Where an agent's sessions live. Every session operation goes through the agent's transport; a
// local one runs the agent's backend (backends/) on this machine, and an agent with a host goes
// through that host's daemon (remote.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, BackendName, Repo } from "./config.js";
import type { Session } from "./fleet.js";
import type { Phase } from "./launch.js";
import { instant } from "./backends/claude.js";
import { backend } from "./backends/index.js";
import { remote, Unreachable } from "./remote.js";
import type { Workspace } from "./workspace.js";
import { die } from "./util.js";
import { branchPushed, ensureWorktree, git, worktreeDirty, worktreePath } from "./worktree.js";

// What starting a session needs.
// The transport writes the appendix and settings files on the machine that runs the session,
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
  // How long the start may take, for a caller with a deadline (the hook's wake).
  timeoutMs?: number;
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
  // The launch id the backend's CLI printed, or "?".
  start(req: StartRequest): string;
  stop(name: string, id: string, remove: boolean): void;
  // Puts a message into a live session of a backend that has deliver (AgentBackend.deliver), on
  // the machine the session runs on.
  deliver(name: string, s: Session, text: string, from: string): void;
  // The worktree for the item, made or reused (worktree.ts's ensureWorktree); throws when it cannot.
  worktree(q: WorktreeRequest): { wt: string; how: string };
  worktreeLeft(q: WorktreeRequest): WorktreeLeft;
  removeWorktree(q: WorktreeRequest): { ok: boolean; said: string };
  // For the doctor: the checkout's top level and its origin url, or null for a top that is none.
  checkout(repo: Repo): { top: string | null; origin: string };
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

// This machine's sessions of one backend. Each call resolves the backend when it runs, not when
// this module loads, so an import cycle through the backend never finds it undefined. Claude's
// keeps `where` "local"; any other backend's listing is its own, under "local:<name>".
const locals = new Map<BackendName, Transport>();
export function localFor(name: BackendName): Transport {
  let t = locals.get(name);
  if (!t) locals.set(name, (t = localTransport(name)));
  return t;
}

const localTransport = (name: BackendName): Transport => ({
  where: name === "claude" ? "local" : `local:${name}`,
  sessions: (includeDone = false) => backend(name).sessions(includeDone),
  sessionsAsync: () => backend(name).sessionsAsync(),
  alive: (s): s is Session => backend(name).alive(s),
  start(req) {
    return backend(name).start(req, req.appendix ? appendixFile(req.runDir, req.agent.name, req.appendix) : null);
  },
  stop: (_name, id, remove) => backend(name).stop(id, remove),
  deliver(_name, s, text, from) {
    const b = backend(name);
    if (!b.deliver) throw new Error(`${b.name} sessions take no delivered message`);
    b.deliver(s, text, from);
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
});

// Claude's sessions on this machine, and the transport for this machine's worktrees and checkouts,
// which no backend changes.
export const local: Transport = localFor("claude");

// The file a start passes as --append-system-prompt-file, in the workspace's logs/run/, which a
// reboot keeps as it does not keep /tmp. It is named by its content, so a brief launched again
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
  return agent.host ? hostTransport(ws, agent.host, `agent ${agent.name}`) : localFor(agent.backend);
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

const stamp = (s: Session) => [s.activeAt, s.updatedAt, s.startedAt, s.createdAt].map(instant).find(Number.isFinite) ?? -Infinity;

// Newest first: the latest activity, else the latest timestamp the listing carries, as its order is
// not documented.
const byNewest = (hits: Session[]) => [...hits].sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));

// An agent's session among several by its name: the newest live one, else the newest.
export function pick(t: Transport, hits: Session[]): Session | null {
  const newest = byNewest(hits);
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
