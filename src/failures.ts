// The watchers' failures log: one line per failed or off-contract run, which the round shows.
// Kept out of the watchers so the board can write to it without importing them.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";

export const iso = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z");

export const failuresLog = (ws: Workspace) => join(ws.logsDir, "watcher-failures.log");

export function failure(ws: Workspace, line: string): void {
  mkdirSync(ws.logsDir, { recursive: true });
  appendFileSync(failuresLog(ws), `${iso()} ${line}\n`);
}

// failure() for callers in the scheduler, where a throw takes it down.
export function tryFailure(ws: Workspace, line: string): void {
  try {
    failure(ws, line);
  } catch (e) {
    console.error(`factory: ${line} (the failures log could not be written: ${(e as Error).message})`);
  }
}
