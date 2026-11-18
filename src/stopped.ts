// The session the factory stopped last, per agent. A wake or restart-lead resumes that one by id:
// the newest row left in the listing can be an older conversation, whose command line is older too
// (Travis on 2026-11-18: stop removed the row it stopped, and wake respawned his two-day-old thread
// without --append-system-prompt-file). A launch forgets it, as the conversation is then new.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "./fleet.js";
import type { Workspace } from "./workspace.js";

export interface Stopped {
  id: string;
  at: string;
}

const file = (ws: Workspace, name: string) => join(ws.runDir, `stopped-${name}.json`);

export function noteStopped(ws: Workspace, name: string, s: Session | null): void {
  if (!s?.id) return;
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
    return typeof d.id === "string" && d.id ? { id: d.id, at: String(d.at ?? "") } : null;
  } catch {
    return null;
  }
}

export const forgetStopped = (ws: Workspace, name: string) => rmSync(file(ws, name), { force: true });

// The row a resume is for: the one stopped last when the factory stopped it, else the newest.
// A recorded row that is gone is said, never replaced by an older one.
export function resumable(ws: Workspace, name: string, rows: Session[], newest: (r: Session[]) => Session | null):
  { s: Session | null } | { gone: string } {
  const st = lastStopped(ws, name);
  if (!st) return { s: newest(rows) };
  const s = rows.find((r) => r.id === st.id);
  return s ? { s } : { gone: st.id };
}
