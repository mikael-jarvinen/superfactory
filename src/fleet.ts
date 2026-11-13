import type { Agent, RoleName } from "./config.js";
import { allRecs, BUSY, IN_REVIEW, type Rec } from "./state.js";
import type { Workspace } from "./workspace.js";
import { ask, Unreachable } from "./remote.js";
import { agentSessions, isAgentSession, pick, type Transport, transportFor, transports } from "./transport.js";
import { die, pyRepr, pyStr, sleep } from "./util.js";
import { branchPushed, worktreeDirty } from "./worktree.js";

export { claudeBin, executable } from "./claude-bin.js";

export interface Session {
  id?: string;
  name?: string;
  kind?: string;
  state?: string;
  status?: string;
  cwd?: string;
  updatedAt?: string;
  startedAt?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export const agents = (ws: Workspace) => ws.config.agents;

export const byRole = (ws: Workspace, role: RoleName) => ws.config.agents.filter((a) => a.role === role);

export function lead(ws: Workspace): Agent {
  return byRole(ws, "lead")[0] as Agent;
}

export function agentOrDie(ws: Workspace, name: string): Agent {
  const a = ws.config.agents.find((x) => x.name === name);
  if (!a) die(`no fleet entry for ${pyRepr(name)}; known: ${ws.config.agents.map((x) => x.name).join(", ")}`);
  return a;
}

export function findSession(t: Transport, name: string, includeDone = false): Session | null {
  return pick(t, t.sessions(includeDone).filter(isAgentSession(name)));
}

// A host that cannot be asked on one poll is asked again on the next.
export function waitForName(t: Transport, name: string, timeoutS = 90, pollMs = 3000): Session | null {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const s = ask(() => findSession(t, name));
    if (!(s instanceof Unreachable) && t.alive(s)) return s;
    sleep(pollMs);
  }
  return null;
}

export function stopSession(t: Transport, s: Session | null, remove = true): void {
  const id = s?.id;
  if (!id) return;
  t.stop(s.name ?? "", id, remove);
}

// What stopping a builder would lose from its worktree, as the refusal to give, or null if nothing.
export function leftWork(ws: Workspace, name: string, cwd: string): string | null {
  const left = worktreeDirty(cwd, ws.config.worktree.toolWritten);
  if (left.length) return `${name}'s worktree ${cwd} has uncommitted changes: ${left.slice(0, 4).join(", ")}. Ask them to commit and push, or --force to lose it.`;
  let base = "main";
  for (const r of Object.values(ws.config.repos)) if (cwd.startsWith(r.path + "/")) base = r.base;
  if (!branchPushed(cwd, base)) return `${name}'s branch in ${cwd} is not fully pushed. Ask them to push, or --force.`;
  return null;
}

// A builder owed nothing but items in review is free, with or without a session: the next dispatch
// stops that session. The items, or none when the builder is building or fixing something.
export function reviewOnly(recs: Rec[], name: string): Rec[] {
  const mine = recs.filter((r) => r.agent === name && r.state !== null);
  return mine.some((r) => BUSY.has(r.state as string)) ? [] : mine.filter((r) => IN_REVIEW.has(r.state as string));
}

// A record in a working state: its agent is owed a session, and is not free for other work.
export const owesSession = (r: Rec): r is Rec & { agent: string; state: string } => !!r.agent && !!r.state && BUSY.has(r.state);

// Where the agent a record owes a session stands: running, on a host that could not be asked, or
// dropped. Null when the record is not in a working state or names no agent.
export type Owed = { is: "live" } | { is: "unknown"; why: string } | { is: "dropped" };

export function owed(r: Rec, live: ReadonlySet<string> | ReadonlyMap<string, unknown>, unknown: ReadonlyMap<string, string>): Owed | null {
  if (!owesSession(r)) return null;
  if (live.has(r.agent)) return { is: "live" };
  const why = unknown.get(r.agent);
  return why !== undefined ? { is: "unknown", why } : { is: "dropped" };
}

// Where each output labels an owed session that is not live: `factory status` prints mark before
// the line and tail after it, and the round and the idle check print theirs before it.
interface OwedLabel {
  mark: string;
  tail: string;
  round: string;
  idle: string;
}

const OWED_LABEL: Record<Exclude<Owed["is"], "live">, OwedLabel> = {
  unknown: { mark: "??", tail: "", round: "UNKNOWN", idle: "unknown" },
  dropped: { mark: "!!", tail: " -- dropped delegation?", round: "NO SESSION", idle: "dropped" },
};

function owedSays(r: Rec, o: Exclude<Owed, { is: "live" }>): string {
  switch (o.is) {
    case "unknown":
      return `${r.agent}'s host could not be asked (${o.why}) while ${r.ticket} is ${r.state}`;
    case "dropped":
      return `${r.agent} has no live session while ${r.ticket} is ${r.state}`;
  }
}

// The label and text every output prints for a record's owed session; null when it owes none or is live.
export function owedNote(r: Rec, live: ReadonlySet<string> | ReadonlyMap<string, unknown>, unknown: ReadonlyMap<string, string>): { label: OwedLabel; says: string } | null {
  const o = owed(r, live, unknown);
  if (!o || o.is === "live") return null;
  return { label: OWED_LABEL[o.is], says: owedSays(r, o) };
}

const field = (s: Session, k: string) => (k in s ? pyStr(s[k]) : "?");

// A transport's listing, or why its host could not be asked.
export function listing(t: Transport, includeDone = false): Session[] | Unreachable {
  return ask(() => t.sessions(includeDone));
}

// One line per fleet member: live session, stale record, unknown, or nothing. Returns the live ones
// too, and the unknown ones with why.
export function fleetLines(ws: Workspace): { lines: string[]; live: Map<string, Session>; unknown: Map<string, string> } {
  const listed = new Map<string, Session>();
  const live = new Map<string, Session>();
  const unknown = new Map<string, string>();
  const rows = new Map(transports(ws).map((t) => [t.where, listing(t)]));
  for (const { agent: a, t, hits } of agentSessions(ws, (where) => rows.get(where))) {
    const s = pick(t, hits);
    if (s) listed.set(a.name, s);
    if (t.alive(s)) live.set(a.name, s);
  }
  const recs = allRecs(ws);
  const lines = ws.config.agents.map((a) => {
    const s = listed.get(a.name);
    const got = rows.get(transportFor(ws, a).where);
    if (got instanceof Unreachable) unknown.set(a.name, got.brief);
    const st = got instanceof Unreachable
      ? `unknown (${got.message})`
      : s && live.has(a.name)
      ? `${field(s, "status")}/${field(s, "state")} id=${pyStr(s.id)} cwd=${pyStr(s.cwd)}`
      : s
        ? `not running (stale record id=${pyStr(s.id)} says ${field(s, "state")}; the daemon is gone)`
        : "not running";
    const review = a.role === "builder" ? reviewOnly(recs, a.name) : [];
    const free = review.length ? `  -- free: ${review.map((r) => `${r.ticket} is ${r.state}`).join(", ")}` : "";
    return `  ${a.name.padEnd(10)} ${a.role.padEnd(9)} ${st}${free}`;
  });
  return { lines, live, unknown };
}
