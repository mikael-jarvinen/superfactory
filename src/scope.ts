// On Linux, every claude call the fleet makes runs in a scope of its own under agents.slice: the
// transport's (listings, start, stop, rm) and a watcher's `claude -p`. doctor's
// `claude auth status` stays bare. A call that finds no supervisor may start it, a listing or a
// one-shot run included, and a process stays in its parent's cgroup:
// unscoped, the supervisor, every session and every build under it would share the caller's unit
// (the scheduler's), which systemd-oomd kills whole. avoid is honoured only for the memory pressure
// rule on user@.service; oomd ignores it for swap and for /user.slice, whose cgroups root owns.
// There is no fallback to a bare exec: a call systemd-run cannot scope fails. The bus strings were
// seen with no user bus, in --scope mode: "Failed to connect to bus: …" from systemd 249,
// "Failed to connect to user scope bus via local transport: …" from 259. A claude that systemd-run
// cannot find ("Failed to find executable …", exit 1 on both) is no scope failure: it is that
// call's own. The factory daemon in the agents repo does the same for its calls. An Antigravity
// supervisor gets a scope too (detachedScoped), for the same reason.
import { claudeBin } from "./claude-bin.js";
import { procStat } from "./stacks/process.js";
import { die, type RunResult } from "./util.js";

// --quiet keeps "Running scope as unit …" off stderr, so a failure of systemd-run's own is stderr's
// first line, the only one scopeCheck reads. Dropping it makes every scope failure claude's.
export const SCOPE = ["--user", "--scope", "--collect", "--slice=agents.slice", "--quiet", "-p", "ManagedOOMPreference=avoid", "--"];
const SCOPE_FAILED = /^(Failed to (start transient scope unit|connect to .*bus|create bus connection)|Unknown assignment)/;

// A scheduler job run's calls leave its cgroup for their scopes, so the leftovers reaper finds
// them by name instead: the scheduler sets FACTORY_JOB to the job's label, and each call's scope is
// factory-job-<label>-<the run's process group>-<pid>-<n>.scope. The reaper reads the scopes of an
// ended run's group by this prefix. FACTORY_JOB never reaches claude (claudeEnv), so a session or a
// supervisor a run starts does not name its own calls after the run.
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

// The command and arguments that run a process that outlives its caller, an Antigravity
// supervisor, in a scope of its own where there is systemd. Its scope never takes a job run's name:
// the leftovers reaper would kill it when the run that started it ends. In --scope mode systemd-run
// execs the command in place, so the pid spawned is the process's own. It runs with claudeEnv's
// environment, so FACTORY_JOB does not reach it.
export function detachedScoped(bin: string, argv: string[], platform: NodeJS.Platform = process.platform): [string, string[]] {
  return platform === "linux" ? ["systemd-run", [...SCOPE, bin, ...argv]] : [bin, argv];
}

// The environment a claude call runs with: env, without FACTORY_JOB.
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { [JOB_ENV]: _job, ...rest } = env;
  return rest;
}

// Dies when systemd-run, not claude, is what failed. In --scope mode systemd-run fails before it
// execs claude, so its error is the first line of stderr; a bus error further down is claude's own
// (a hook's, say), and stays that call's failure. Stderr alone cannot tell the two apart when the
// first line is a bus error claude printed itself, or a warning of systemd-run's comes before its
// error: either is then logged under the other's message, and the call fails all the same.
export function scopeCheck(argv: string[], r: RunResult, platform: NodeJS.Platform = process.platform): RunResult {
  if (platform !== "linux") return r;
  const said = r.stderr.trim().split("\n")[0] ?? "";
  if (r.status === 127 && /systemd-run/.test(said)) die(`systemd-run did not start for claude ${argv[0]}: ${said}`);
  if (r.status !== 0 && SCOPE_FAILED.test(said)) die(`systemd-run made no scope for claude ${argv[0]}: ${said}`);
  return r;
}
