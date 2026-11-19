// The session the factory stopped last, per agent. A wake or restart-lead resumes that one by id:
// the newest row left in the listing can be an older conversation, whose command line is older too
// (Travis on 2026-11-18: stop removed the row it stopped, and wake respawned his two-day-old thread
// without --append-system-prompt-file). A launch forgets it, as the conversation is then new.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./config.js";
import type { Session } from "./fleet.js";
import { newest, type Transport } from "./transport.js";
import type { Workspace } from "./workspace.js";

export interface Stopped {
  id: string;
  at: string;
  // launches since the stop that never came up: their rows supersede nothing (CodeRabbit on #130)
  failed?: string[];
}

const file = (ws: Workspace, name: string) => join(ws.runDir, `stopped-${name}.json`);

function save(ws: Workspace, name: string, st: Stopped): void {
  mkdirSync(ws.runDir, { recursive: true });
  const f = file(ws, name);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st) + "\n");
  renameSync(tmp, f);
}

export function noteStopped(ws: Workspace, name: string, s: Session | null): void {
  // a row with no name is no agent's (Marie on #130: down wrote stopped-.json)
  if (!s?.id || !name) return;
  save(ws, name, { id: s.id, at: new Date().toISOString() });
}

export function lastStopped(ws: Workspace, name: string): Stopped | null {
  const f = file(ws, name);
  if (!existsSync(f)) return null;
  try {
    const d = JSON.parse(readFileSync(f, "utf8")) as Partial<Stopped>;
    if (typeof d.id !== "string" || !d.id) return null;
    const failed = Array.isArray(d.failed) ? d.failed.filter((x): x is string => typeof x === "string") : [];
    return { id: d.id, at: String(d.at ?? ""), ...(failed.length ? { failed } : {}) };
  } catch {
    return null;
  }
}

// The agent's rows a launch is about to add to, by id, read before it starts: what a failed launch
// added is what was not there, with no clock compared (Marie on #130: a remote listing's startedAt
// is another host's clock). null when the listing cannot be had.
export function rowsBefore(t: Pick<Transport, "sessions">, name: string): Session[] | null {
  try {
    return t.sessions(true).filter((r) => r.name === name && r.kind === "background");
  } catch {
    return null;
  }
}

// A launch that never came up, so a wake still resumes the session stopped last rather than its row
// (CodeRabbit on #130: the listing keeps that row, started after the stop, and resumable took it for
// a newer conversation). The row is kept for \`claude logs\`; its id is noted here, with any other
// row of the agent that was not listed before the launch. With no record, the newest row from
// before is written as the one to resume, so the dead launch is not it either (Marie on #130).
export function noteFailedLaunch(ws: Workspace, name: string, t: Pick<Transport, "sessions">, launchId: string, before: Session[] | null): void {
  const was = new Set((before ?? []).map((r) => r.id));
  const ids = new Set<string>();
  if (/^\w+$/.test(launchId) && !was.has(launchId)) ids.add(launchId);
  if (before) {
    try {
      for (const r of t.sessions(true)) if (r.name === name && r.kind === "background" && r.id && !was.has(r.id)) ids.add(r.id);
    } catch {
      // the listing failed: the launch id alone
    }
  }
  // With no record, one is written here, so it is also what the next launch that comes up replaces:
  // replaceStopped then removes that older row from the listing, as it removes any stopped row a
  // new conversation supersedes. That is intended; the older row was the way back only until then.
  const st = lastStopped(ws, name) ?? (() => {
    const old = newest((before ?? []).filter((r) => r.id && !ids.has(r.id)));
    return old?.id ? ({ id: old.id, at: new Date().toISOString() } as Stopped) : null;
  })();
  if (!st || !ids.size) return;
  for (const x of st.failed ?? []) ids.add(x);
  ids.delete(st.id);
  save(ws, name, { ...st, failed: [...ids] });
}

// A row noted as a failed launch that is seen live came up after all: it is a new conversation,
// and replaces the one stopped last as a launch that came up does (Marie on #130).
export function cameUp(ws: Workspace, name: string, t: Pick<Transport, "sessions" | "alive" | "stop">, s: Session): void {
  const failed = lastStopped(ws, name)?.failed ?? [];
  if (s.id && failed.includes(s.id)) supersede(ws, name, t, s.id, failed);
}

// A marked launch that came up replaces the session stopped last. Any other launch still marked
// keeps its mark: the one that came up is then the record, the session a wake resumes, rather than
// no record and the newest row, which can be a launch that never came up (CodeRabbit and Marie on
// #130 at 85389fcf).
export function supersede(ws: Workspace, name: string, t: Pick<Transport, "sessions" | "alive" | "stop">, id: string, failed: Iterable<string>): void {
  replaceStopped(ws, name, t, id);
  const keep = [...failed].filter((x) => x !== id);
  if (keep.length) save(ws, name, { id, at: new Date().toISOString(), failed: keep });
}

export const forgetStopped = (ws: Workspace, name: string) => rmSync(file(ws, name), { force: true });

// The command that starts an agent fresh, for when its conversation cannot come back (Marie on #130:
// a refusal that says only "factory wake" sends people back into the command that just failed).
export const freshCommand = (a: Pick<Agent, "name" | "role">): string =>
  a.role === "lead" ? "factory up --fresh"
    : a.role === "reviewer" ? `factory review --name ${a.name} --force`
    : a.role === "assistant" ? `factory assistant ${a.name} --force`
    : `factory dispatch ${a.name} <KEY> --force`;

// Whether a row shows its session came up at some point.
const ran = (r: Session): boolean => ["done", "blocked", "stopped"].includes(String(r.state)) || typeof r.pid === "number";

// When a row started, in epoch ms, or NaN.
const startMs = (r: Session): number =>
  typeof r.startedAt === "number" ? r.startedAt : Date.parse(String(r.startedAt ?? r.createdAt ?? ""));

// The row a resume is for: the one stopped last when the factory stopped it, else the newest.
// A recorded row that is gone is said, never replaced by an older one. The record lives on the box
// that stopped it, so a launch from another box does not forget it; a row started after the stop
// (another conversation, launched since) makes it stale, and the newest is the one (Marie on #130).
// A row chosen because a marked launch ran comes with the marks still held: once it is up, the
// caller passes them to supersede. Nothing is replaced before then, so a wake that resumes nothing
// leaves the record and the stopped row as they were (Marie on #130 at 85389fcf).
export function resumable(ws: Workspace, name: string, rows: Session[], newest: (r: Session[]) => Session | null):
  { s: Session | null; failed?: string[] } | { gone: string } {
  const st = lastStopped(ws, name);
  if (!st) return { s: newest(rows) };
  const at = Date.parse(st.at);
  // a noted launch holds its mark until its row shows it ran: a state only a session that came up
  // reaches (done, blocked, stopped), or a worker's pid. A row still "working" with no pid after the
  // launch gave up, or one with no state, has shown nothing and stays marked (Marie on #130).
  const marked = new Set(st.failed ?? []);
  const failed = new Set([...marked].filter((id) => !rows.some((r) => r.id === id && ran(r))));
  // A marked launch that has run since came up after the stop, whatever its host's clock says of
  // its start. It replaces the record once up, as cameUp does for one seen live, so a later wake
  // does not read the mark again once the row is back to "working" (CodeRabbit on #130 at 43510c94).
  // The stopped row is no candidate then: its start and the marked row's are not compared, as a
  // remote clock can put the launch before it; the rows are those started since (CodeRabbit on #130
  // at 85389fcf).
  const after = (r: Session) => r.id !== st.id && !marked.has(r.id ?? "") && startMs(r) > at;
  const since = rows.filter((r) => !!r.id && marked.has(r.id) && !failed.has(r.id));
  if (since.length) {
    return { s: newest(rows.filter((r) => since.includes(r) || after(r))), failed: [...failed] };
  }
  if (rows.some(after)) return { s: newest(rows.filter((r) => !failed.has(r.id ?? ""))) };
  const s = rows.find((r) => r.id === st.id);
  return s ? { s } : { gone: st.id };
}

// A new conversation replaces the one stopped last: forget it, and remove its row, which no wake
// will resume now, so stopped rows do not build up in the listing (Marie on #130). A row that is
// live again is left alone.
export function replaceStopped(ws: Workspace, name: string, t: Pick<Transport, "sessions" | "alive" | "stop">, newId?: string): void {
  const st = lastStopped(ws, name);
  forgetStopped(ws, name);
  if (!st || st.id === newId) return;
  try {
    const row = t.sessions(true).find((r) => r.id === st.id);
    if (row && !t.alive(row)) t.stop(name, st.id, true);
  } catch {
    // the listing or the rm failed: the row stays, as it did before
  }
}
