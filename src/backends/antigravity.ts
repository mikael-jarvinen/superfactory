// Google Antigravity: each session is an `agy acp` process, owned by a supervisor of its own
// (agy-supervisor.ts) that start() runs detached, so the session outlives the `factory` command.
// The listing is the supervisors' state files (agy-store.ts); a row is live while its supervisor
// is. A message reaches a session as its next prompt, through its inbox (deliver).
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "../fleet.js";
import { alive as pidAlive, killTree, startStamp } from "../stacks/process.js";
import { die, sleep } from "../util.js";
import type { AgentBackend, LaunchSpec } from "./backend.js";
import { agyHome, allStates, type AgyState, enqueue, newId, projectDir, readState, sessionDir, transcriptsDir, validId, writeJson } from "./agy-store.js";

const SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), "agy-supervisor.js");

// How long a start waits for its supervisor to send the first prompt, or to fail.
export const START_WAIT_MS = 60_000;

// The supervisor's arguments. Settings, remote control, autocompact and permission mode have no
// ACP counterpart: an agy session takes no Claude settings, its tools are put to the supervisor
// (read-only.ts) whatever the mode, and `agy acp` takes no remote-control flag.
function launchArgs(spec: LaunchSpec): string[] {
  const args = ["--name", spec.name];
  for (const d of spec.addDirs) args.push("--add-dir", d);
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.appendixPath) args.push("--appendix", spec.appendixPath);
  if (spec.mcpConfig) args.push("--mcp-config", spec.mcpConfig);
  args.push("--prompt", spec.prompt);
  return args;
}

// An exited process its parent has not reaped yet still answers kill(pid, 0); /proc says it is a
// zombie. The `factory` command that started a supervisor is its parent until it exits.
function zombie(pid: number): boolean {
  try {
    return /^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

// The supervisor is the process it recorded: alive, and with the stamp it had at its start, as
// pids are reused.
function supervisorUp(s: { pid?: unknown; stamp?: unknown }): boolean {
  if (typeof s.pid !== "number" || !Number.isInteger(s.pid) || s.pid <= 0 || !pidAlive(s.pid) || zombie(s.pid)) return false;
  if (typeof s.stamp !== "string") return true;
  try {
    return startStamp(s.pid) === s.stamp;
  } catch {
    return true;
  }
}

export function sessionAlive(s: Session | null | undefined): s is Session {
  if (!s || s.kind !== "background" || s.backend !== "antigravity") return false;
  if (s.state === "stopped" || s.state === "failed") return false;
  return supervisorUp(s);
}

export const midTurn = (s: Session): boolean => s.state === "working" || s.state === "starting";

const asRow = (st: AgyState): Session => {
  const at = transcriptAt(st as unknown as Session);
  return { ...st, ...(at === undefined ? {} : { activeAt: at }) } as unknown as Session;
};

export function transcriptAt(s: Session): number | undefined {
  if (typeof s.transcript !== "string") return undefined;
  try {
    return statSync(s.transcript).mtimeMs;
  } catch {
    return undefined;
  }
}

// Every session this machine has: without includeDone, those not ended; a session whose supervisor
// died without ending it is listed as it was, and alive() says it is not.
export function listSessions(includeDone = false): Session[] {
  return allStates()
    .filter((s) => includeDone || (s.state !== "stopped" && s.state !== "failed"))
    .map(asRow);
}

export function startSupervisor(cwd: string, args: string[], env: NodeJS.ProcessEnv, waitMs = START_WAIT_MS): string {
  if (!existsSync(cwd)) die(`cannot start an Antigravity session in ${cwd}: no such directory`);
  const id = newId();
  const dir = sessionDir(id);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, "supervisor.log"), "a");
  try {
    // detached makes it a session leader (setsid), so the caller's process group does not hold it
    const child = spawn(process.execPath, [SUPERVISOR, "--id", id, ...args], { cwd, detached: true, stdio: ["ignore", fd, fd], env });
    child.on("error", () => {});
    if (child.pid === undefined) die(`cannot start the Antigravity supervisor in ${cwd}`);
    child.unref();
  } finally {
    closeSync(fd);
  }
  // Up once the first prompt has gone; a failure says why.
  for (const end = Date.now() + waitMs; Date.now() < end; sleep(200)) {
    const st = readState(id);
    if (st?.state === "failed") die(`the Antigravity session did not start: ${st.error ?? "no reason given"} (log: ${join(dir, "supervisor.log")})`);
    if (st && st.state !== "starting") return id;
    if (st && !supervisorUp(st)) die(`the Antigravity supervisor exited before its session started (log: ${join(dir, "supervisor.log")})`);
  }
  die(`the Antigravity session did not start within ${Math.round(waitMs / 1000)} s (log: ${join(dir, "supervisor.log")})`);
}

// SIGTERM to the supervisor, which ends the session; whatever is left after the wait is killed.
export function stopSession(id: string, remove: boolean): void {
  if (!validId(id)) die(`not an Antigravity session id: ${id}`);
  const st = readState(id);
  if (st && supervisorUp(st)) {
    try {
      process.kill(st.pid, "SIGTERM");
    } catch {
      // gone already
    }
    for (const end = Date.now() + 15_000; Date.now() < end && supervisorUp(st); sleep(200));
    if (supervisorUp(st)) killTree(st.pid, 2000);
    if (typeof st.agentPid === "number" && pidAlive(st.agentPid) && !zombie(st.agentPid)) killTree(st.agentPid, 2000);
    const after = readState(id);
    if (after && after.state !== "stopped" && after.state !== "failed")
      writeJson(join(sessionDir(id), "state.json"), { ...after, state: "stopped", status: "off", updatedAt: new Date().toISOString() });
  }
  // the transcript is under projects/ and stays
  if (remove) rmSync(sessionDir(id), { recursive: true, force: true });
}

// A message for a live session, sent as its next prompt once the one in flight has ended.
export function deliver(s: Session, text: string): void {
  if (!validId(s.id) || !sessionAlive(s)) die(`${s.name ?? s.id ?? "the session"} is not running, so the message cannot reach it`);
  enqueue(s.id, text);
}

export const antigravityBackend: AgentBackend = {
  name: "antigravity",
  launchArgs,
  start: (req, appendixPath) => startSupervisor(req.cwd, req.args(appendixPath), req.env, req.timeoutMs ? Math.min(req.timeoutMs, START_WAIT_MS) : START_WAIT_MS),
  stop: stopSession,
  sessions: listSessions,
  sessionsAsync: () => Promise.resolve().then(() => listSessions()).catch(() => []),
  alive: sessionAlive,
  midTurn,
  messageTool: null,
  deliver,
  logsHint: (id) => `the supervisor's log, ${join(sessionDir(id), "supervisor.log")}`,
  // An agy session takes no Claude settings; the file records what the session was rendered with.
  installSettings(ws, s) {
    const path = join(ws.runDir, `agy-settings-${s.name}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeJson(path, { name: s.name, role: s.role, cwd: s.cwd ?? null, home: agyHome() });
    return path;
  },
  transcriptsDir,
  projectDir,
  transcriptAt,
  planUsage: () => () => Promise.reject(new Error("Antigravity's plan usage is not read")),
};
