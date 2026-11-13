import type { Agent, RoleName } from "./config.js";
import { allRecs, BUSY, IN_REVIEW, type Rec } from "./state.js";
import type { Workspace } from "./workspace.js";
import { agentSessions, isAgentSession, pick, type Transport, transports } from "./transport.js";
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

export function waitForName(t: Transport, name: string, timeoutS = 90): Session | null {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const s = findSession(t, name);
    if (t.alive(s)) return s;
    sleep(3000);
  }
  return null;
}

export function stopSession(t: Transport, s: Session | null, remove = true): void {
  const id = s?.id;
  if (!id) return;
  t.stop(id, remove);
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

const field = (s: Session, k: string) => (k in s ? pyStr(s[k]) : "?");

// One line per fleet member: live session, stale record, or nothing. Returns the live ones too.
export function fleetLines(ws: Workspace): { lines: string[]; live: Map<string, Session> } {
  const listed = new Map<string, Session>();
  const live = new Map<string, Session>();
  const rows = new Map(transports(ws).map((t) => [t.where, t.sessions()]));
  for (const { agent: a, t, hits } of agentSessions(ws, (where) => rows.get(where))) {
    const s = pick(t, hits);
    if (s) listed.set(a.name, s);
    if (t.alive(s)) live.set(a.name, s);
  }
  const recs = allRecs(ws);
  const lines = ws.config.agents.map((a) => {
    const s = listed.get(a.name);
    const st = s && live.has(a.name)
      ? `${field(s, "status")}/${field(s, "state")} id=${pyStr(s.id)} cwd=${pyStr(s.cwd)}`
      : s
        ? `not running (stale record id=${pyStr(s.id)} says ${field(s, "state")}; the daemon is gone)`
        : "not running";
    const review = a.role === "builder" ? reviewOnly(recs, a.name) : [];
    const free = review.length ? `  -- free: ${review.map((r) => `${r.ticket} is ${r.state}`).join(", ")}` : "";
    return `  ${a.name.padEnd(10)} ${a.role.padEnd(9)} ${st}${free}`;
  });
  return { lines, live };
}
