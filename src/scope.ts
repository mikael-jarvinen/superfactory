// On Linux, every claude call runs in a scope of its own under agents.slice. One that finds no
// supervisor may start it, a listing included, and a process stays in its parent's cgroup:
// unscoped, the supervisor, every session and every build under it would share the caller's unit
// (the scheduler's), which systemd-oomd kills whole. avoid is honoured only for the memory pressure
// rule on user@.service; oomd ignores it for swap and for /user.slice, whose cgroups root owns.
// There is no fallback to a bare exec: a call systemd-run cannot scope fails. The bus strings were
// seen with no user bus, in --scope mode: "Failed to connect to bus: …" from systemd 249,
// "Failed to connect to user scope bus via local transport: …" from 259. A claude that systemd-run
// cannot find ("Failed to find executable …", exit 1 on both) is no scope failure: it is that
// call's own. The factory daemon in the agents repo does the same for its calls.
import { claudeBin } from "./claude-bin.js";
import { die, type RunResult } from "./util.js";

export const SCOPE = ["--user", "--scope", "--collect", "--slice=agents.slice", "--quiet", "-p", "ManagedOOMPreference=avoid", "--"];
const SCOPE_FAILED = /^(Failed to (start transient scope unit|connect to .*bus|create bus connection)|Unknown assignment)/m;

// The command and arguments that run `claude argv`, in a scope where there is systemd.
export function claudeScoped(argv: string[], platform: NodeJS.Platform = process.platform): [string, string[]] {
  return platform === "linux" ? ["systemd-run", [...SCOPE, claudeBin(), ...argv]] : [claudeBin(), argv];
}

// Dies when systemd-run, not claude, is what failed.
export function scopeCheck(argv: string[], r: RunResult, platform: NodeJS.Platform = process.platform): RunResult {
  if (platform !== "linux") return r;
  const said = r.stderr.trim().split("\n")[0];
  if (r.status === 127 && /systemd-run/.test(r.stderr)) die(`systemd-run did not start for claude ${argv[0]}: ${said}`);
  if (r.status !== 0 && SCOPE_FAILED.test(r.stderr)) die(`systemd-run made no scope for claude ${argv[0]}: ${said}`);
  return r;
}
