// Where Antigravity sessions live on disk. sessions/<id>/ holds spec.json, state.json (its row,
// rewritten by the supervisor on every change), inbox/ (one file per message, oldest name first),
// supervisor.log, agy.log and acp.jsonl. Transcripts are under projects/, by cwd as Claude's are,
// in the lines board/analytics.ts reads.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const agyHome = () =>
  process.env.SF_AGY_HOME || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "superfactory", "antigravity");

export function agyBin(): string {
  if (process.env.SF_AGY_BIN) return process.env.SF_AGY_BIN;
  const installed = join(homedir(), ".local", "bin", "agy");
  return existsSync(installed) ? installed : "agy";
}

export const agySettingsFile = () => process.env.SF_AGY_SETTINGS || join(homedir(), ".gemini", "antigravity-cli", "settings.json");

export const sessionsDir = () => join(agyHome(), "sessions");
export const sessionDir = (id: string) => join(sessionsDir(), id);
export const inboxDir = (id: string) => join(sessionDir(id), "inbox");
export const transcriptsDir = () => join(agyHome(), "projects");
// A cwd's transcripts: the cwd with every character but a letter or digit made "-", as Claude's.
export const projectDir = (cwd: string) => join(transcriptsDir(), cwd.replace(/[^A-Za-z0-9]/g, "-"));
export const transcriptFile = (cwd: string, sessionId: string) => join(projectDir(cwd), `${sessionId}.jsonl`);

export const validId = (id: unknown): id is string => typeof id === "string" && /^agy-[0-9a-f]{12}$/.test(id);
// The supervisor's systemd scope, without ".scope": unique to the session, so the name never comes
// to mean another process, after a reboot included.
export const scopeUnit = (id: string) => `sf-${id}`;
// Whether a cgroup path is that scope's, so a state file names no other cgroup to kill.
export const sessionCgroup = (id: string, path: unknown): path is string =>
  typeof path === "string" && validId(id) && /^(\/[A-Za-z0-9_.@:-]+)+$/.test(path) && !path.split("/").includes("..") && path.endsWith(`/${scopeUnit(id)}.scope`);
export const newId = () => `agy-${randomBytes(6).toString("hex")}`;

// A session's row, its states as Claude's rows are, with "starting" until its first prompt goes.
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
  boot?: string | null;
  // the scope's cgroup (scopeUnit), which holds agy and every process it starts; null for no scope
  cgroup?: string | null;
  agentPid: number | null;
  agentStamp?: string | null;
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

// Puts a message in a session's inbox. Names sort by time, then by order within this process, so
// one sender's messages go in the order sent.
let sent = 0;
export function enqueue(id: string, text: string, from?: string): string {
  const dir = inboxDir(id);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString().padStart(15, "0")}-${(sent++).toString().padStart(6, "0")}-${randomBytes(4).toString("hex")}.json`;
  writeJson(join(dir, name), { text, at: new Date().toISOString(), ...(from === undefined ? {} : { from }) });
  return name;
}

// The sender a session's first prompt is put back in its inbox under, when it never went to agy.
export const FIRST_PROMPT = "the start (its first prompt)";

export interface InboxMessage {
  file: string;
  text: string;
  at: string | null;
  from: string | null;
}

export function inbox(id: string): InboxMessage[] {
  let names: string[];
  try {
    names = readdirSync(inboxDir(id)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      const m = JSON.parse(readFileSync(join(inboxDir(id), n), "utf8")) as { text?: unknown; at?: unknown; from?: unknown };
      if (typeof m.text !== "string" || !m.text) return [];
      return [{ file: n, text: m.text, at: typeof m.at === "string" ? m.at : null, from: typeof m.from === "string" ? m.from : null }];
    } catch {
      return [];
    }
  });
}
