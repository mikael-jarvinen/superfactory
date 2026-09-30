// The scheduler on macOS: launchd agents rendered from [watchers] and installed for this user.
//
// Three jobs. The queue watcher, only when there is a tracker to read. The round, once an hour.
// And `factory up`, at login and twice an hour: the daemon retires a session that sat idle for a
// day and then exits, and `up` respawns the lead from its last thread when nothing is running and
// prints one line when something is.
//
// Rendered into logs/run/launchd/, like the session settings: they carry this machine's absolute
// paths, which never belong in a tracked file, and they are rebuilt from config on every install.
// The installed copy goes to ~/Library/LaunchAgents, because that is the only place launchd loads
// an agent from at login.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lead } from "../fleet.js";
import { trackerOf } from "../tracker/read.js";
import type { Workspace } from "../workspace.js";
import { promptPath } from "../watchers/job.js";
import { die, run } from "../util.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

export const JOB_NAMES = ["queue", "round", "up"] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface Calendar {
  Hour?: number;
  Minute: number;
}

export interface Job {
  name: JobName;
  label: string;
  args: string[];
  calendar: Calendar[];
  runAtLoad: boolean;
}

// Named for the workspace's lead, so two workspaces on one machine keep apart and no label names
// a company.
export const label = (ws: Workspace, name: JobName) => `superfactory.${lead(ws).name}.${name}`;

// Calendar intervals, not StartInterval: a plain interval timer is not serviced while the laptop
// sleeps, so a closed lid stops it for the night, while a missed calendar fire runs at the next wake.
// A calendar repeats within the hour or the day, so the cadence has to divide one of them evenly.
export function every(minutes: number): Calendar[] {
  const steps = (end: number, step: number) => Array.from({ length: end / step }, (_, i) => i * step);
  if (minutes > 0 && 60 % minutes === 0) return steps(60, minutes).map((m) => ({ Minute: m }));
  if (minutes % 60 === 0 && 1440 % minutes === 0) return steps(24, minutes / 60).map((h) => ({ Hour: h, Minute: 0 }));
  return die(`watchers.queue_every_minutes = ${minutes}: a calendar job needs a number of minutes that divides 60, or a number of hours that divides 24`);
}

const UP_AT: Calendar[] = [{ Minute: 3 }, { Minute: 33 }];

export function jobs(ws: Workspace): Job[] {
  const w = ws.config.watchers;
  const base = [process.execPath, CLI, "--workspace", ws.dir];
  const out: Job[] = [];
  if (trackerOf(ws).reads)
    out.push({ name: "queue", label: label(ws, "queue"), args: [...base, "watch", "queue"], calendar: every(w.queueEveryMinutes ?? 15), runAtLoad: false });
  out.push({ name: "round", label: label(ws, "round"), args: [...base, "watch", "round"], calendar: [{ Minute: w.roundMinute ?? 7 }], runAtLoad: false });
  out.push({ name: "up", label: label(ws, "up"), args: [...base, "up"], calendar: UP_AT, runAtLoad: true });
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The job's environment: the PATH of whoever installs it, since launchd's own finds neither claude
// nor gh, and the variables that pin a run to this workspace with memory off.
function environment(ws: Workspace, env: NodeJS.ProcessEnv): Record<string, string> {
  const e: Record<string, string> = {
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    FACTORY_WORKSPACE: ws.dir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  for (const k of ["CLAUDE_BIN", "GH_BIN"]) if (env[k]) e[k] = env[k] as string;
  return e;
}

export function plist(ws: Workspace, job: Job, env: NodeJS.ProcessEnv = process.env): string {
  const log = join(ws.logsDir, `launchd-${job.name}.log`);
  const cal = job.calendar
    .map((c) => `    <dict>${c.Hour === undefined ? "" : `<key>Hour</key><integer>${c.Hour}</integer>`}<key>Minute</key><integer>${c.Minute}</integer></dict>`)
    .join("\n");
  const vars = Object.entries(environment(ws, env)).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(job.label)}</string>
  <key>ProgramArguments</key>
  <array>
${job.args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(ws.dir)}</string>
  <key>StartCalendarInterval</key>
  <array>
${cal}
  </array>
  <key>RunAtLoad</key><${job.runAtLoad}/>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export const renderDir = (ws: Workspace) => join(ws.runDir, "launchd");

export function render(ws: Workspace, env: NodeJS.ProcessEnv = process.env): { job: Job; path: string }[] {
  mkdirSync(renderDir(ws), { recursive: true });
  mkdirSync(ws.logsDir, { recursive: true });
  return jobs(ws).map((job) => {
    const path = join(renderDir(ws), `${job.label}.plist`);
    writeFileSync(path, plist(ws, job, env));
    return { job, path };
  });
}

// ---------------------------------------------------------------- launchctl
//
// Everything below touches the user's launchd. Tests render and read plists and never get here.

const launchctl = (...args: string[]) => run(process.env.LAUNCHCTL_BIN || "launchctl", args);
const agentsDir = () => join(homedir(), "Library", "LaunchAgents");
const installed = (l: string) => join(agentsDir(), `${l}.plist`);
const domain = () => `gui/${process.getuid?.() ?? ""}`;

function requireMac(): void {
  if (process.platform !== "darwin") die("the scheduler uses launchd; other platforms are not built yet");
}

// label -> pid and last exit, from `launchctl list`; null when it cannot be read.
function listed(): Map<string, { pid: string; status: string }> | null {
  const r = launchctl("list");
  if (r.status !== 0) return null;
  const m = new Map<string, { pid: string; status: string }>();
  for (const line of r.stdout.split("\n")) {
    const [pid, status, l] = line.split("\t");
    if (l) m.set(l.trim(), { pid: pid as string, status: status as string });
  }
  return m;
}

// A job whose prompt is missing would run on schedule and fail every time, so it is not installed.
function missingPrompts(ws: Workspace, js: Job[]): string[] {
  const need = new Set<"queue" | "round" | "relay">();
  for (const j of js) {
    if (j.name === "queue") need.add("queue").add("relay");
    if (j.name === "round") need.add("round");
  }
  return [...need].map((p) => promptPath(ws, p)).filter((p) => !existsSync(p));
}

export function install(ws: Workspace, out: (line: string) => void = console.log): number {
  requireMac();
  const rendered = render(ws);
  const missing = missingPrompts(ws, rendered.map((r) => r.job));
  if (missing.length) die(`not installed: ${missing.join(", ")} missing. examples/prompts/ has one of each to start from.`);
  mkdirSync(agentsDir(), { recursive: true });
  let rc = 0;
  for (const { job, path } of rendered) {
    launchctl("bootout", `${domain()}/${job.label}`);
    copyFileSync(path, installed(job.label));
    const r = launchctl("bootstrap", domain(), installed(job.label));
    if (r.status === 0) out(`loaded ${job.label}`);
    else {
      out(`FAILED to load ${job.label}: ${r.stderr.trim()}`);
      rc = 1;
    }
  }
  // A job config no longer asks for, such as the queue watcher after the tracker went to none.
  const names = new Set(rendered.map((r) => r.job.name));
  for (const name of JOB_NAMES.filter((n) => !names.has(n))) remove(label(ws, name), out);
  return rc;
}

function remove(l: string, out: (line: string) => void): void {
  if (!existsSync(installed(l))) return;
  launchctl("bootout", `${domain()}/${l}`);
  rmSync(installed(l), { force: true });
  out(`removed ${l}`);
}

export function uninstall(ws: Workspace, out: (line: string) => void = console.log): number {
  requireMac();
  for (const name of JOB_NAMES) remove(label(ws, name), out);
  return 0;
}

export interface JobState {
  job: Job;
  // "stale" is installed but not what config renders now.
  installed: "no" | "stale" | "current";
  loaded?: { pid: string; status: string };
}

// What launchd has of each job config wants, and the labels installed that config no longer wants.
// Reads only; `status` and the doctor both print from it.
export function jobStates(ws: Workspace): { jobs: JobState[]; unwanted: string[]; listFailed: boolean } {
  requireMac();
  const list = listed();
  const want = jobs(ws);
  return {
    jobs: want.map((job) => {
      const dest = installed(job.label);
      const how = !existsSync(dest) ? "no" : readFileSync(dest, "utf8") === plist(ws, job) ? "current" : "stale";
      return { job, installed: how, loaded: list?.get(job.label) };
    }),
    unwanted: JOB_NAMES.filter((n) => !want.some((j) => j.name === n)).map((n) => label(ws, n)).filter((l) => existsSync(installed(l))),
    listFailed: list === null,
  };
}

export function status(ws: Workspace, out: (line: string) => void = console.log): number {
  const s = jobStates(ws);
  let rc = 0;
  for (const { job, installed: how, loaded: row } of s.jobs) {
    const said = how === "no" ? "NOT INSTALLED" : how === "stale" ? "installed, but not what config renders now (install again)" : "installed";
    const state = s.listFailed ? "launchctl list failed" : row ? `loaded pid=${row.pid} last_exit=${row.status}` : "NOT LOADED";
    if (how !== "current" || !row) rc = 1;
    out(`  ${job.label.padEnd(36)} ${said}, ${state}`);
  }
  for (const l of s.unwanted) {
    out(`  ${l.padEnd(36)} installed but not wanted by config (install again removes it)`);
    rc = 1;
  }
  return rc;
}

// For the round: what launchd says about each job config wants.
export function loaded(ws: Workspace): string[] {
  if (process.platform !== "darwin") return ["  launchd: not macOS, no scheduler to check"];
  const list = listed();
  if (list === null) return ["  launchd CANNOT list jobs"];
  return jobs(ws).map((j) => {
    const row = list.get(j.label);
    return row ? `  launchd ${j.label} pid=${row.pid} last_exit=${row.status}` : `  launchd ${j.label} NOT LOADED -- factory schedule install`;
  });
}
