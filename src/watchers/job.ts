// What every watcher run shares: its prompt from the workspace, its log, a disposable `claude -p`,
// the failures log and the heartbeats. A watcher run costs money, so a run is one model call that
// does only what needs a model; fixed commands, set differences and file writes stay in the code.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeBin, lead } from "../fleet.js";
import { renderSettings } from "../settings.js";
import type { Workspace } from "../workspace.js";
import { die, run } from "../util.js";

export type Job = "queue" | "round" | "relay";

export const iso = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z");

// prompts/<job>.md in the workspace. {lead} and {human} are filled in, and {text} for the relay;
// in one pass, so a message that happens to contain a placeholder reaches the session as written.
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

const LOG_MAX = { queue: 5_000_000, round: 5_000_000, relay: 2_000_000 };

// logs/<job>.log, rolled to .1 past its size, with a header for this run.
export function openLog(ws: Workspace, job: Job): string {
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

// One line per failed or off-contract run. The round shows what arrived since the last round.
export const failuresLog = (ws: Workspace) => join(ws.logsDir, "watcher-failures.log");

export function failure(ws: Workspace, line: string): void {
  mkdirSync(ws.logsDir, { recursive: true });
  appendFileSync(failuresLog(ws), `${iso()} ${line}\n`);
}

// A heartbeat means "ran and read the tracker", and only the caller that has that evidence writes
// one. The board shows every *.heartbeat in logs/.
export const heartbeatPath = (ws: Workspace, name: "queue" | "round") => join(ws.logsDir, `${name}.heartbeat`);

export function beat(ws: Workspace, name: "queue" | "round"): void {
  mkdirSync(ws.logsDir, { recursive: true });
  writeFileSync(heartbeatPath(ws, name), iso() + "\n");
}

export function heartbeatAge(ws: Workspace, name: "queue" | "round"): number | null {
  const p = heartbeatPath(ws, name);
  return existsSync(p) ? Math.floor((Date.now() - statSync(p).mtimeMs) / 1000) : null;
}

const TIMEOUT_S = { queue: 600, round: 900, relay: 120 };

// A disposable session: no memory, low effort, the watcher settings, and only the tools the job
// names pre-approved. The prompt goes on stdin.
export function claudeArgs(ws: Workspace, job: Job, tools: string[]): string[] {
  const w = ws.config.watchers;
  const model = job === "relay" ? (w.relayModel ?? "haiku") : (w.model ?? "sonnet");
  const settings = renderSettings(ws, { name: `watcher.${job}`, role: "watcher", template: "watcher", permissionMode: "auto" });
  return ["-p", "--model", model, "--effort", "low", "--permission-mode", "auto", "--settings", settings, "--allowedTools", tools.join(",")];
}

export const claudeOptions = (job: Job) => ({
  env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  timeout: TIMEOUT_S[job] * 1000,
  killSignal: "SIGTERM" as const,
});

// The run's reply and exit. A run killed at its timeout has no exit status, and counts as failed.
export function runClaude(ws: Workspace, job: Job, prompt: string, tools: string[], log: string): { status: number; stdout: string } {
  const r = run(claudeBin(), claudeArgs(ws, job, tools), { ...claudeOptions(job), input: prompt });
  logTo(log, r.stdout);
  if (r.stderr.trim()) logTo(log, r.stderr);
  logTo(log, `exit=${r.status}`);
  return { status: r.status, stdout: r.stdout };
}
