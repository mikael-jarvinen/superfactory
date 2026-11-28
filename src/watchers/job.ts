// What every watcher run shares: its prompt from the workspace, its log, a disposable `claude -p`
// and the heartbeats. A watcher run costs money, so a run is one model call that
// does only what needs a model; fixed commands, set differences and file writes stay in the code.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lead } from "../fleet.js";
import { claudeEnv, claudeScoped, scopeCheck } from "../scope.js";
import { ghBin } from "../gate/github.js";
import { claudeBackend } from "../backends/claude.js";
import { parseRead } from "../tracker/read.js";
import { iso } from "../failures.js";
import type { Workspace } from "../workspace.js";
import { die, run, type RunResult } from "../util.js";

export type Job = "queue" | "round";
// The scheduled watchers, the two with a model and the review watcher without one.
export type Watcher = Job | "reviews";

// prompts/<job>.md in the workspace. {lead} and {human} are filled in, in one pass.
export const promptPath = (ws: Workspace, job: Job) => join(ws.dir, "prompts", `${job}.md`);

export function loadPrompt(ws: Workspace, job: Job, vars: Record<string, string> = {}): string {
  const p = promptPath(ws, job);
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return die(`no ${job} prompt: ${p} is missing. examples/prompts/ has one to start from.`);
  }
  const all: Record<string, string> = { lead: lead(ws).name, human: ws.config.human.name, ...vars };
  return text.replace(/\{(\w+)\}/g, (m, k: string) => all[k] ?? m).trimEnd();
}

const LOG_MAX = { queue: 5_000_000, round: 5_000_000, reviews: 2_000_000 };

// logs/<job>.log, rolled to .1 past its size, with a header for this run.
export function openLog(ws: Workspace, job: Watcher): string {
  mkdirSync(ws.logsDir, { recursive: true });
  const p = join(ws.logsDir, `${job}.log`);
  try {
    if (statSync(p).size > LOG_MAX[job]) renameSync(p, p + ".1");
  } catch {
    // no log yet
  }
  appendFileSync(p, `===== ${iso()} =====\n`);
  return p;
}

export const logTo = (path: string, text: string) => appendFileSync(path, text.endsWith("\n") || !text ? text : text + "\n");

// A heartbeat means "ran and read the tracker", and only the caller that has that evidence writes
// one. The board shows every *.heartbeat in logs/.
export const heartbeatPath = (ws: Workspace, name: Watcher) => join(ws.logsDir, `${name}.heartbeat`);

export function beat(ws: Workspace, name: Watcher): void {
  mkdirSync(ws.logsDir, { recursive: true });
  writeFileSync(heartbeatPath(ws, name), iso() + "\n");
}

export function heartbeatAge(ws: Workspace, name: Watcher): number | null {
  const p = heartbeatPath(ws, name);
  return existsSync(p) ? Math.floor((Date.now() - statSync(p).mtimeMs) / 1000) : null;
}

const TIMEOUT_S = { queue: 600, round: 900 };

// A disposable session: no memory, low effort, the watcher settings, and only the tools the job
// names pre-approved. The prompt goes on stdin.
export function claudeArgs(ws: Workspace, job: Job, tools: string[]): string[] {
  const w = ws.config.watchers;
  const model = w.model ?? "sonnet";
  const mode = watcherMode(ws);
  const settings = claudeBackend.installSettings(ws, { name: `watcher.${job}`, role: "watcher", template: "watcher", permissionMode: mode });
  return ["-p", "--model", model, "--effort", "low", "--permission-mode", mode, "--settings", settings, "--allowedTools", tools.join(",")];
}

// The lead's own mode. Every watcher run messages the lead, and a session holds a cross-session
// message from a sender in another mode for its human's approval: a prompt in the Claude app for
// every round. Auto when the lead names no mode.
export function watcherMode(ws: Workspace): string {
  const ld = lead(ws);
  return ld.permissionMode ?? ws.config.roles[ld.role]?.permissionMode ?? "auto";
}

export const claudeOptions = (job: Job) => ({
  env: { ...claudeEnv(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  timeout: TIMEOUT_S[job] * 1000,
  killSignal: "SIGTERM" as const,
});

export const TIMED_OUT = 124;

export interface ClaudeRun {
  status: number;
  stdout: string;
  seconds: number;
  // Cut short by the laptop sleeping, not by the run itself.
  slept: boolean;
}

// launchd starts a missed run in a dark wake that lasts seconds, the Mac sleeps again mid-run, and
// on waking the timeout has long passed. A run that outlived its timeout by more than this was
// frozen, not stuck, so it is not logged as a failure (runFailure).
const SLEPT_MARGIN_S = 120;

// The run's reply and exit. A run killed at its timeout counts as failed. A `claude -p` can start
// the supervisor as a listing can, so it runs in a scope under agents.slice like every claude call;
// one systemd-run cannot scope is logged, then dies.
export function runClaude(ws: Workspace, job: Job, prompt: string, tools: string[], log: string): ClaudeRun {
  const t0 = Date.now();
  const argv = claudeArgs(ws, job, tools);
  const r = run(...claudeScoped(argv), { ...claudeOptions(job), input: prompt }, `claude ${argv[0]}`);
  const seconds = Math.round((Date.now() - t0) / 1000);
  const slept = r.status === TIMED_OUT && seconds > TIMEOUT_S[job] + SLEPT_MARGIN_S;
  logTo(log, r.stdout);
  if (r.stderr.trim()) logTo(log, r.stderr);
  const why = r.status === TIMED_OUT ? ` (timed out after ${seconds}s${slept ? "; the laptop slept during the run" : ""})` : "";
  logTo(log, `exit=${r.status}${why}`);
  scopeCheck(argv, r);
  return { status: r.status, stdout: r.stdout, seconds, slept };
}

// In a `claude -p` the claude.ai connectors arrive a few seconds after the session starts, later on
// a network still waking from sleep, and a run that searched for the tool before they arrived ended
// unavailable while the next one read Jira. So a run that cannot reach the tracker gets one more
// run, half a minute later; a second one that cannot is an outage. TRACKER_RETRY_S overrides the
// wait, for the tests.
const RETRY_WAIT_S = 30;

export function runReader(ws: Workspace, job: "queue" | "round", prompt: string, tools: string[], log: string): ClaudeRun {
  const r = runClaude(ws, job, prompt, tools, log);
  if (r.status !== 0 || parseRead(ws, r.stdout).outcome !== "unavailable") return r;
  const wait = Number(process.env.TRACKER_RETRY_S ?? RETRY_WAIT_S);
  logTo(log, `tracker unavailable; running once more in ${wait}s, in case the connector was still loading`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait * 1000);
  return runClaude(ws, job, prompt, tools, log);
}

// The failures-log line for a run that did not exit 0, or null for one the laptop's sleep cut
// short: that is nobody's fault, and logging it would only make the round's plumbing check cry wolf.
export function runFailure(job: Job, r: ClaudeRun): string | null {
  if (r.slept) return null;
  return r.status === TIMED_OUT ? `${job} TIMED OUT after ${r.seconds}s` : `${job} FAILED exit=${r.status}`;
}

// A run started in a 45-second dark wake can hang a `gh` call on the network when the laptop sleeps
// again, for hours, and launchd starts no run while one is alive, so every run after it is skipped.
// A watcher's `gh` call has a bound.
const GH_TIMEOUT_S = 60;

export interface GhRun extends RunResult {
  slept: boolean;
}

// A watcher's `gh` call, killed at its bound. A timeout puts its reason in stderr, where a failed
// read already looks, and names the laptop's sleep as runClaude does.
export function watcherGh(args: string[], timeoutS = GH_TIMEOUT_S): GhRun {
  const t0 = Date.now();
  const r = run(ghBin(), args, { timeout: timeoutS * 1000, killSignal: "SIGTERM" });
  if (r.status !== TIMED_OUT) return { ...r, slept: false };
  const seconds = Math.round((Date.now() - t0) / 1000);
  const slept = seconds > timeoutS + SLEPT_MARGIN_S;
  return { ...r, stderr: `gh ${args.slice(0, 2).join(" ")} timed out after ${seconds}s${slept ? "; the laptop slept during the call" : ""}`, slept };
}
