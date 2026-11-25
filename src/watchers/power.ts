// What the Mac's power state says about a watcher run.
//
// launchd starts a run it missed while the Mac slept in the next wake, and on a closed lid that is
// a dark wake: a maintenance wake of about 45 seconds, no display, the network up. The Mac sleeps
// again mid-run, and every call in flight then waits for the next wake, an hour or two later: a
// round reports its check-run reads as CANNOT read, and a queue run takes 20 to 90 minutes and ends
// "slept".
//
// So a run in a dark wake does nothing and says so, and the round counts a run that found the Mac
// asleep as the schedule working. `pmset -g systemstate` answers in about 20 ms: a dark wake's
// capabilities have no Graphics ("CPU Network"); a full wake's have it ("CPU Graphics Audio
// Network"). PMSET_BIN and SYSCTL_BIN name other binaries, for the tests.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../util.js";
import type { Workspace } from "../workspace.js";

const mac = () => process.platform === "darwin";

// True only when the Mac says it is in a dark wake; anything it cannot tell is a full wake.
export function darkWake(): boolean {
  if (!mac() && !process.env.PMSET_BIN) return false;
  const r = run(process.env.PMSET_BIN || "pmset", ["-g", "systemstate"], { timeout: 5000 });
  const caps = /Current System Capabilities are:([^\n]*)/.exec(r.stdout)?.[1];
  return r.status === 0 && caps !== undefined && !/\bGraphics\b/.test(caps);
}

// When the Mac last went to sleep, in seconds since the epoch, or null off a Mac. A later value
// than one read before is a sleep in between.
export function lastSleep(): number | null {
  if (!mac() && !process.env.SYSCTL_BIN) return null;
  const r = run(process.env.SYSCTL_BIN || "sysctl", ["-n", "kern.sleeptime"], { timeout: 5000 });
  const sec = /sec = (\d+)/.exec(r.stdout)?.[1];
  return r.status === 0 && sec ? Number(sec) : null;
}

// The last time a watcher run found the Mac asleep: started in a dark wake, or slept mid-run.
export const asleepPath = (ws: Workspace, name: string) => join(ws.logsDir, `${name}.asleep`);

export function markAsleep(ws: Workspace, name: string): void {
  mkdirSync(ws.logsDir, { recursive: true });
  writeFileSync(asleepPath(ws, name), new Date().toISOString() + "\n");
}

export function asleepAge(ws: Workspace, name: string): number | null {
  const p = asleepPath(ws, name);
  return existsSync(p) ? Math.floor((Date.now() - statSync(p).mtimeMs) / 1000) : null;
}

export const DARK_WAKE = "dark-wake: the Mac is in a dark wake, so nothing ran; a run in a full wake reads";
