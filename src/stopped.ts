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
  // of those, the ones `factory down` stopped while they had shown nothing: their "stopped" is the
  // factory's doing, no evidence they ran (Marie on #130 at f62a6b10)
  unrun?: string[];
}

const file = (ws: Workspace, name: string) => join(ws.runDir, `stopped-${name}.json`);

function save(ws: Workspace, name: string, given: Stopped): void {
  const { unrun, ...rest } = given;
  const st: Stopped = rest;
  const keep = (unrun ?? []).filter((id) => st.failed?.includes(id));
  if (keep.length) st.unrun = keep;
  mkdirSync(ws.runDir, { recursive: true });
  const f = file(ws, name);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st) + "\n");
  renameSync(tmp, f);
}

// rows: the listing at the stop, when it could be had. A launch still marked as never come up keeps
// its mark across the stop, while its row is listed and has shown nothing; the mark is all that
// keeps a row whose host clock is ahead from passing as newer than the stop (CodeRabbit on #130 at
// 2e89a7a4). Without a listing every mark is carried.
export function noteStopped(ws: Workspace, name: string, s: Session | null, rows?: Session[]): void {
  // a row with no name is no agent's (Marie on #130: down wrote stopped-.json)
  if (!s?.id || !name) return;
  const st = seen(ws, name, lastStopped(ws, name), rows);
  const failed = held(st, rows, s.id);
  save(ws, name, { id: s.id, at: new Date().toISOString(), ...(failed.length ? { failed, unrun: st?.unrun } : {}) });
}

// The marks that still stand: a launch whose row is listed and has not shown it ran, except the
// row now taking the record. Every writer of a record carries these, so no path drops one. A listing
// that failed or came back empty shows nothing either way, so every mark is kept (CodeRabbit on
// #130 at f62a6b10): a mark kept too long costs a skipped row, one dropped can wake a dead launch.
function held(st: Stopped | null | undefined, rows: Session[] | undefined, except: string): string[] {
  const listed = rows?.length ? rows : null;
  return (st?.failed ?? []).filter((id) => id !== except && (!listed || listed.some((r) => r.id === id && !ran(r, st))));
}

// A launch down stopped unrun that any listing shows with a pid, or live, came up after all: it
// leaves unrun, so a later stop by any hand (a raw `claude stop`) reads as having run, and its
// conversation is resumed (Marie on #130 at b9d55a37). The record is saved without it.
function seen(ws: Workspace, name: string, st: Stopped | null, rows: Session[] | undefined): Stopped | null {
  if (!st?.unrun?.length || !rows) return st;
  const up = (id: string) => rows.some((r) => r.id === id && (typeof r.pid === "number" || r.alive === true));
  if (!st.unrun.some(up)) return st;
  const next: Stopped = { ...st, unrun: st.unrun.filter((id) => !up(id)) };
  save(ws, name, next);
  return lastStopped(ws, name);
}

// `factory down` stops a marked launch that has shown nothing, so one that comes up late does not
// outlive the down; the mark stays, and its stopped state is not read as having run.
export function noteUnrun(ws: Workspace, name: string, id: string): void {
  const st = lastStopped(ws, name);
  if (st?.failed?.includes(id)) save(ws, name, { ...st, unrun: [...new Set([...(st.unrun ?? []), id])] });
}

export function lastStopped(ws: Workspace, name: string): Stopped | null {
  const f = file(ws, name);
  if (!existsSync(f)) return null;
  try {
    const d = JSON.parse(readFileSync(f, "utf8")) as Partial<Stopped>;
    if (typeof d.id !== "string" || !d.id) return null;
    const failed = Array.isArray(d.failed) ? d.failed.filter((x): x is string => typeof x === "string") : [];
    const unrun = Array.isArray(d.unrun) ? d.unrun.filter((x): x is string => typeof x === "string" && failed.includes(x)) : [];
    return { id: d.id, at: String(d.at ?? ""), ...(failed.length ? { failed } : {}), ...(unrun.length ? { unrun } : {}) };
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
  if (s.id && lastStopped(ws, name)?.failed?.includes(s.id)) replaceStopped(ws, name, t, s.id);
}

// The record moves to id, the session now up, with the launches still marked; with none, it goes
// (CodeRabbit on #130 at 7a20b268: a lead resumed under a new id dropped the marks with the record).
export function moveRecord(ws: Workspace, name: string, id: string, failed: Iterable<string>): void {
  const keep = [...failed].filter((x) => x !== id);
  if (keep.length) save(ws, name, { id, at: new Date().toISOString(), failed: keep, unrun: lastStopped(ws, name)?.unrun });
  else forgetStopped(ws, name);
}

export const forgetStopped = (ws: Workspace, name: string) => rmSync(file(ws, name), { force: true });

// Rows a new conversation replaced that a caller with a deadline could not stop and remove (a hook's
// wake: CodeRabbit on #130 at b77aae5c). They live in a file of their own, beside the record, so no
// writer of the record drops them, and the next caller with no deadline (up, a CLI wake, stop,
// down, restart-lead, a launch) stops and removes them (Niilo on #130 at c2ef44e3: rows pile up
// otherwise). A stale id is never a wake candidate.
const staleFile = (ws: Workspace, name: string) => join(ws.runDir, `stale-${name}.json`);

export function staleIds(ws: Workspace, name: string): string[] {
  try {
    const d = JSON.parse(readFileSync(staleFile(ws, name), "utf8")) as unknown;
    return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string" && !!x) : [];
  } catch {
    return [];
  }
}

function saveStale(ws: Workspace, name: string, ids: string[]): void {
  const f = staleFile(ws, name);
  if (!ids.length) return rmSync(f, { force: true });
  mkdirSync(ws.runDir, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ids) + "\n");
  renameSync(tmp, f);
}

function noteStale(ws: Workspace, name: string, ids: string[]): void {
  if (ids.length) saveStale(ws, name, [...new Set([...staleIds(ws, name), ...ids])]);
}

// For a caller with no deadline: the stale rows are stopped and removed. One live again is no longer
// stale, and is left; one no longer listed is gone already. A listing that failed or came back empty
// shows nothing, and every id is kept, as are those whose removal failed.
export function sweepStale(ws: Workspace, name: string, t: Pick<Transport, "sessions" | "alive" | "stop">, rows?: Session[]): void {
  const ids = staleIds(ws, name);
  if (!ids.length || !name) return;
  if (!rows)
    try {
      rows = t.sessions(true);
    } catch {
      return;
    }
  if (!rows.length) return;
  const keep: string[] = [];
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row || t.alive(row)) continue;
    try {
      t.stop(name, id, true);
    } catch {
      keep.push(id);
    }
  }
  saveStale(ws, name, keep);
}

// The command that starts an agent fresh, for when its conversation cannot come back (Marie on #130:
// a refusal that says only "factory wake" sends people back into the command that just failed).
export const freshCommand = (a: Pick<Agent, "name" | "role">): string =>
  a.role === "lead" ? "factory up --fresh"
    : a.role === "reviewer" ? `factory review --name ${a.name} --force`
    : a.role === "assistant" ? `factory assistant ${a.name} --force`
    : `factory dispatch ${a.name} <KEY> --force`;

// Whether a row shows its session came up at some point. A row down stopped before it showed
// anything is "stopped" by the factory, which says nothing of whether it ran.
export const ran = (r: Session, st?: Stopped | null): boolean =>
  ["done", "blocked"].includes(String(r.state)) || typeof r.pid === "number" ||
  (r.state === "stopped" && !st?.unrun?.includes(r.id ?? ""));

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
  // the record's own id is never stale: a writer that names it again has taken it back
  const gone = staleIds(ws, name).filter((id) => id !== lastStopped(ws, name)?.id);
  if (gone.length) rows = rows.filter((r) => !gone.includes(r.id ?? ""));
  const st = seen(ws, name, lastStopped(ws, name), rows);
  if (!st) return { s: newest(rows) };
  const at = Date.parse(st.at);
  // a noted launch holds its mark until its row shows it ran: a state only a session that came up
  // reaches (done, blocked, stopped), or a worker's pid. A row still "working" with no pid after the
  // launch gave up, or one with no state, has shown nothing and stays marked (Marie on #130).
  const marked = new Set(st.failed ?? []);
  const failed = new Set([...marked].filter((id) => !rows.some((r) => r.id === id && ran(r, st))));
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

// A new conversation replaces the one stopped last, and remove its row, which no wake will resume
// now, so stopped rows do not build up in the listing (Marie on #130). A row that is live again is
// left alone. Any launch still marked keeps its mark: the new conversation is then the record, the
// session a wake resumes, rather than no record and the newest row, which can be a launch that never
// came up (CodeRabbit and Marie on #130 at 85389fcf; a fresh launch, CodeRabbit at 2e89a7a4).
// stale: the row a respawn came back from under another id, which goes too (Marie on #130 at
// f62a6b10: rows pile up otherwise); it came up, so it keeps no mark. listed: a listing already
// had, for a caller with no time for another; none is made then, and no row is removed (CodeRabbit
// on #130 at d1c64cc6: wake's deadline), so the stale rows wait for a later step.
export function replaceStopped(ws: Workspace, name: string, t: Pick<Transport, "sessions" | "alive" | "stop">, newId?: string, stale?: string, listed?: Session[]): void {
  let rows: Session[] | undefined = listed;
  if (!listed)
    try {
      rows = t.sessions(true);
    } catch {
      // the listing failed: every mark is carried (held), and the rows stay
    }
  const st = seen(ws, name, lastStopped(ws, name), rows);
  if (newId && st) moveRecord(ws, name, newId, held(st, rows, newId).filter((id) => id !== stale));
  else forgetStopped(ws, name);
  const old = [...new Set([st?.id, stale])].filter((id): id is string => !!id && id !== newId);
  // with no time to remove them, they are noted for the next caller that has it
  if (listed) return noteStale(ws, name, old.filter((id) => rows?.some((r) => r.id === id && !t.alive(r))));
  sweepStale(ws, name, t, rows);
  for (const id of old)
    if (id)
      try {
        const row = rows?.find((r) => r.id === id);
        if (row && !t.alive(row)) t.stop(name, id, true);
      } catch {
        // the rm failed: the row stays, as it did before
      }
}
