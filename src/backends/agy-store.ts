// Where Antigravity sessions live on disk. Each session has a supervisor (agy-supervisor.ts) that
// owns its `agy acp` process, and a directory of its own under sessions/:
//
//   spec.json        what it was started with
//   state.json       its row as `factory` lists it, rewritten by the supervisor on every change
//   inbox/           messages waiting to reach it, one file each, oldest name first
//   supervisor.log   the supervisor's own output; agy.log is agy's (--log-file)
//   acp.jsonl        every ACP message either way, for when something goes wrong
//
// Transcripts are under projects/, by cwd as Claude's are, one file per ACP session, in the
// lines the board's readers take (board/analytics.ts): an agent-name line, then user and assistant
// lines with a timestamp and a message. The home is SF_AGY_HOME, else
// $XDG_STATE_HOME/superfactory/antigravity, else ~/.local/state/superfactory/antigravity.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const agyHome = () =>
  process.env.SF_AGY_HOME || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "superfactory", "antigravity");

// The agy binary: SF_AGY_BIN, else the installer's ~/.local/bin/agy, else agy on PATH.
export function agyBin(): string {
  if (process.env.SF_AGY_BIN) return process.env.SF_AGY_BIN;
  const installed = join(homedir(), ".local", "bin", "agy");
  return existsSync(installed) ? installed : "agy";
}

// agy's own settings, which the supervisor reads before it starts a session (unsafeSettings).
export const agySettingsFile = () => process.env.SF_AGY_SETTINGS || join(homedir(), ".gemini", "antigravity-cli", "settings.json");

export const sessionsDir = () => join(agyHome(), "sessions");
export const sessionDir = (id: string) => join(sessionsDir(), id);
export const inboxDir = (id: string) => join(sessionDir(id), "inbox");
export const transcriptsDir = () => join(agyHome(), "projects");
// A cwd's transcripts: the cwd with every character but a letter or digit made "-", as Claude's.
export const projectDir = (cwd: string) => join(transcriptsDir(), cwd.replace(/[^A-Za-z0-9]/g, "-"));
export const transcriptFile = (cwd: string, sessionId: string) => join(projectDir(cwd), `${sessionId}.jsonl`);

export const validId = (id: unknown): id is string => typeof id === "string" && /^agy-[0-9a-f]{12}$/.test(id);
export const newId = () => `agy-${randomBytes(6).toString("hex")}`;

// A session's row. state is "starting" until its first prompt goes, then "working" while a prompt
// is in flight and "done" between prompts, as Claude's rows are; "stopped" or "failed" once the
// supervisor has ended, with why for a failure.
export interface AgyState {
  id: string;
  name: string;
  kind: "background";
  backend: "antigravity";
  state: "starting" | "working" | "done" | "stopped" | "failed";
  status: "busy" | "idle" | "off";
  cwd: string;
  // the supervisor's pid and its start stamp (stacks/process.ts), which tell it from a later process given the pid
  pid: number;
  stamp: string | null;
  // agy's pid and its start stamp
  agentPid: number | null;
  agentStamp?: string | null;
  // the ACP session id, once session/new or session/load has answered
  sessionId: string | null;
  model: string | null;
  transcript: string | null;
  startedAt: number;
  updatedAt: string;
  error?: string;
  // the inbox files a session ended with, which never went to agy and are still in its inbox
  undelivered?: string[];
}

// Written beside and renamed, so a reader never sees half of one.
export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n");
  renameSync(tmp, path);
}

export function readState(id: string): AgyState | null {
  try {
    const s = JSON.parse(readFileSync(join(sessionDir(id), "state.json"), "utf8")) as AgyState;
    return s && typeof s === "object" && s.id === id ? s : null;
  } catch {
    return null;
  }
}

export function allStates(): AgyState[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(sessionsDir()).filter(validId);
  } catch {
    return [];
  }
  return ids.map(readState).filter((s): s is AgyState => s !== null);
}

// A message for a session, put in its inbox for its supervisor to send as the next prompt. Names
// sort by time, then by order within this process, so one sender's messages go in the order sent.
let sent = 0;
export function enqueue(id: string, text: string): string {
  const dir = inboxDir(id);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString().padStart(15, "0")}-${(sent++).toString().padStart(6, "0")}-${randomBytes(4).toString("hex")}.json`;
  writeJson(join(dir, name), { text, at: new Date().toISOString() });
  return name;
}
