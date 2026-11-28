// On Linux, every claude call the fleet makes (but doctor's `claude auth status`) runs in a scope
// of its own under agents.slice. Any call may start the supervisor, which stays in its parent's
// cgroup: unscoped, it and every session and build under it would share the caller's unit (the
// scheduler's), which systemd-oomd kills whole. avoid is honoured only for the memory pressure
// rule on user@.service, not for swap or /user.slice. There is no fallback to a bare exec.
import { claudeBin } from "./claude-bin.js";
import { procStat } from "./stacks/process.js";
import { die, type RunResult } from "./util.js";

// --quiet keeps "Running scope as unit …" off stderr, so a failure of systemd-run's own is stderr's
// first line, the only one scopeCheck reads. Dropping it makes every scope failure claude's.
export const SCOPE = ["--user", "--scope", "--collect", "--slice=agents.slice", "--quiet", "-p", "ManagedOOMPreference=avoid", "--"];
const SCOPE_FAILED = /^(Failed to (start transient scope unit|connect to .*bus|create bus connection)|Unknown assignment)/;

// A job run's calls leave its cgroup for their scopes, so the leftovers reaper finds them by name:
// factory-job-<label>-<the run's process group>-<pid>-<n>.scope. FACTORY_JOB never reaches claude
// (claudeEnv), so a session or supervisor a run starts does not name its own calls after the run.
export const JOB_ENV = "FACTORY_JOB";
export const jobUnitPrefix = (label: string, pgid: number) => `factory-job-${label.replace(/[^A-Za-z0-9_.:-]/g, "_")}-${pgid}-`;
let jobCalls = 0;
function jobUnit(env: NodeJS.ProcessEnv): string[] {
  const label = env[JOB_ENV];
  if (!label) return [];
  const pgid = procStat(process.pid)?.pgid ?? process.pid;
  return [`--unit=${jobUnitPrefix(label, pgid)}${process.pid}-${++jobCalls}`];
}

// The command and arguments that run `claude argv`, in a scope where there is systemd.
export function claudeScoped(argv: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  return platform === "linux" ? ["systemd-run", [...jobUnit(env), ...SCOPE, claudeBin(), ...argv]] : [claudeBin(), argv];
}

// Runs a process that outlives its caller (an Antigravity supervisor) in a scope of its own. It
// never takes a job run's name, or the reaper would kill it when that run ends. In --scope mode
// systemd-run execs in place, so the pid spawned is the process's own.
export function detachedScoped(bin: string, argv: string[], platform: NodeJS.Platform = process.platform, unit?: string): [string, string[]] {
  return platform === "linux" ? ["systemd-run", [...(unit ? [`--unit=${unit}`] : []), ...SCOPE, bin, ...argv]] : [bin, argv];
}

// The environment a claude call runs with: env, without FACTORY_JOB.
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { [JOB_ENV]: _job, ...rest } = env;
  return rest;
}

// Dies when systemd-run, not claude, is what failed. In --scope mode systemd-run fails before it
// execs claude, so its error is stderr's first line; a bus error further down is claude's own.
export function scopeCheck(argv: string[], r: RunResult, platform: NodeJS.Platform = process.platform): RunResult {
  if (platform !== "linux") return r;
  const said = r.stderr.trim().split("\n")[0] ?? "";
  if (r.status === 127 && /systemd-run/.test(said)) die(`systemd-run did not start for claude ${argv[0]}: ${said}`);
  if (r.status !== 0 && SCOPE_FAILED.test(said)) die(`systemd-run made no scope for claude ${argv[0]}: ${said}`);
  return r;
}
