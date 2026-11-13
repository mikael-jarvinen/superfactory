// The off-macOS scheduler's state file (logs/run/scheduler.json, written by run.ts) and who it names.
// A leaf: the board reads it, and must not pull in the scheduler's jobs to do so.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startStamp } from "../stacks/process.js";
import type { Workspace } from "../workspace.js";

export const stateFile = (ws: Workspace) => join(ws.runDir, "scheduler.json");

export interface JobRun {
  due: string;
  lastStart?: string;
  lastEnd?: string;
  // exit code, or the signal that ended it
  lastExit?: number | string | null;
  // set while a run is going
  pid?: number | null;
  stamp?: string | null;
}

export interface SchedulerState {
  pid: number;
  stamp?: string | null;
  at: string;
  checkSeconds: number;
  jobs: Record<string, JobRun>;
}

export function readState(ws: Workspace): SchedulerState | null {
  try {
    return JSON.parse(readFileSync(stateFile(ws), "utf8")) as SchedulerState;
  } catch {
    return null;
  }
}

// The start stamp must match too: a recycled pid, another workspace's scheduler included, is not this one.
export function isScheduler(ws: Workspace, pid: number): boolean {
  const s = readState(ws);
  if (s?.pid !== pid || !s.stamp) return false;
  try {
    return startStamp(pid) === s.stamp;
  } catch {
    return false;
  }
}
