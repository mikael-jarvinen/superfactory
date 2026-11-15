// The scheduler this machine has: launchd on macOS, `factory schedule run` (run.ts) elsewhere. The
// one place that chooses.
import type { Check } from "../check.js";
import type { Workspace } from "../workspace.js";
import * as daemon from "./daemon.js";
import * as launchd from "./launchd.js";

export const usesLaunchd = () => process.platform === "darwin";

// For the round: one line per job.
export const loaded = (ws: Workspace): string[] => (usesLaunchd() ? launchd.loaded(ws) : daemon.loaded(ws));

// For the doctor: the scheduler has every job config asks for, and none it does not.
export const checks = (ws: Workspace): Check[] => (usesLaunchd() ? launchd.checks(ws) : daemon.checks(ws));

export function schedule(ws: Workspace, verb: "install" | "uninstall" | "status"): number {
  if (!usesLaunchd()) return daemon.schedule(ws, verb);
  return verb === "install" ? launchd.install(ws) : verb === "uninstall" ? launchd.uninstall(ws) : launchd.status(ws);
}
