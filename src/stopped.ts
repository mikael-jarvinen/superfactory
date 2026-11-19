// The session the factory stopped last, per agent. A wake or restart-lead resumes that one by id:
// the newest row left in the listing can be an older conversation, whose command line is older too
// (Travis on 2026-11-18: stop removed the row it stopped, and wake respawned his two-day-old thread
// without --append-system-prompt-file). A launch forgets it, as the conversation is then new.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./config.js";
import type { Session } from "./fleet.js";
import type { Transport } from "./transport.js";
import type { Workspace } from "./workspace.js";

export interface Stopped {
  id: string;
  at: string;
  // launches since the stop that never came up: their rows supersede nothing (CodeRabbit on #130)
  failed?: string[];
}

const file = (ws: Workspace, name: string) => join(ws.runDir, `stopped-${name}.json`);

export function noteStopped(ws: Workspace, name: string, s: Session | null): void {
  // a row with no name is no agent's (Marie on #130: down wrote stopped-.json)
  if (!s?.id || !name) return;
  mkdirSync(ws.runDir, { recursive: true });
  const f = file(ws, name);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ id: s.id, at: new Date().toISOString() } satisfies Stopped) + "\n");
  renameSync(tmp, f);
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

// A launch that never came up, so a wake still resumes the session stopped last rather than its row
// (CodeRabbit on #130: the listing keeps that row, started after the stop, and resumable took it for
// a newer conversation). The row is kept for \`claude logs\`; its id is noted here, with any other
// row of the agent listed as started since the launch began. With no record there is nothing to keep.
export function noteFailedLaunch(ws: Workspace, name: string, t: Pick<Transport, "sessions">, launchId: string, since: number): void {
  const st = lastStopped(ws, name);
  if (!st) return;
  const ids = new Set(st.failed ?? []);
  if (/^\w+$/.test(launchId) && launchId !== st.id) ids.add(launchId);
  try {
    for (const r of t.sessions(true)) if (r.name === name && r.id && r.id !== st.id && startMs(r) >= since) ids.add(r.id);
  } catch {
    // the listing failed: the launch id alone
  }
  const f = file(ws, name);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...st, failed: [...ids] } satisfies Stopped) + "\n");
  renameSync(tmp, f);
}

export const forgetStopped = (ws: Workspace, name: string) => rmSync(file(ws, name), { force: true });

// The command that starts an agent fresh, for when its conversation cannot come back (Marie on #130:
// a refusal that says only "factory wake" sends people back into the command that just failed).
export const freshCommand = (a: Pick<Agent, "name" | "role">): string =>
  a.role === "lead" ? "factory up --fresh"
    : a.role === "reviewer" ? `factory review --name ${a.name} --force`
    : a.role === "assistant" ? `factory assistant ${a.name} --force`
    : `factory dispatch ${a.name} <KEY> --force`;

// When a row started, in epoch ms, or NaN.
const startMs = (r: Session): number =>
  typeof r.startedAt === "number" ? r.startedAt : Date.parse(String(r.startedAt ?? r.createdAt ?? ""));

// The row a resume is for: the one stopped last when the factory stopped it, else the newest.
// A recorded row that is gone is said, never replaced by an older one. The record lives on the box
// that stopped it, so a launch from another box does not forget it; a row started after the stop
// (another conversation, launched since) makes it stale, and the newest is the one (Marie on #130).
export function resumable(ws: Workspace, name: string, rows: Session[], newest: (r: Session[]) => Session | null):
  { s: Session | null } | { gone: string } {
  const st = lastStopped(ws, name);
  if (!st) return { s: newest(rows) };
  const at = Date.parse(st.at);
  const failed = new Set(st.failed ?? []);
  if (rows.some((r) => r.id !== st.id && !failed.has(r.id ?? "") && startMs(r) > at)) return { s: newest(rows.filter((r) => !failed.has(r.id ?? ""))) };
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
