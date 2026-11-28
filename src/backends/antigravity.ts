// Google Antigravity: each session is an `agy acp` process owned by a detached supervisor
// (agy-supervisor.ts); a row is live while its supervisor is.
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "../fleet.js";
import { claudeEnv, detachedScoped } from "../scope.js";
import { cgroupProcs, currentBoot, isStartStamp, killAll, killTree, living, logTail, processStart, sameStart, spawnDetached } from "../stacks/process.js";
import { die, sleep } from "../util.js";
import type { AgentBackend, LaunchSpec } from "./backend.js";
import { allStates, type AgyState, enqueue, inbox, newId, projectDir, readState, scopeUnit, sessionCgroup, sessionDir, transcriptsDir, validId, writeJson } from "./agy-store.js";
import { CAPABILITIES } from "./capabilities.js";
import { renderSettings } from "../settings.js";
import { ensureAgyHook } from "./agy-guard.js";

const SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), "agy-supervisor.js");

// How long a start waits for its supervisor to send the first prompt, or to fail.
export const START_WAIT_MS = 60_000;

// Remote control, autocompact and permission mode have no ACP counterpart: every call is put to
// the supervisor whatever the mode, and `agy acp` takes no remote-control flag.
function launchArgs(spec: LaunchSpec): string[] {
  const args = ["--name", spec.name];
  if (spec.settings) args.push("--settings", spec.settings);
  for (const d of spec.addDirs) args.push("--add-dir", d);
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.appendixPath) args.push("--appendix", spec.appendixPath);
  if (spec.mcpConfig) args.push("--mcp-config", spec.mcpConfig);
  args.push("--prompt", spec.prompt);
  return args;
}

// Whether the process a pid and stamp were recorded for is up: not a zombie (the `factory` command
// is a supervisor's parent until it exits), and with the same start stamp, as pids are reused.
function up(pid: unknown, stamp: unknown): pid is number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !living(pid)) return false;
  if (!isStartStamp(stamp)) return true;
  try {
    return sameStart(stamp, processStart(pid));
  } catch {
    return true;
  }
}

const supervisorUp = (s: { pid?: unknown; stamp?: unknown }): boolean => up(s.pid, s.stamp);

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
  const log = join(dir, "supervisor.log");
  // A scope of its own: unscoped it would stay in its caller's cgroup, a scheduler job's say, and
  // die with it; and the scope is what ends every process of the session, agy's tools included.
  const [bin, argv] = detachedScoped(process.execPath, [SUPERVISOR, "--id", id, ...args], process.platform, scopeUnit(id));
  const pid = spawnDetached([bin, ...argv], { log, cwd, env: claudeEnv(env), what: "the Antigravity supervisor" });
  const tail = () => {
    const t = logTail(log);
    return t ? `; its log ends:\n${t}` : "";
  };
  // Up once the first prompt has gone; a supervisor that dies silently fails the start at once.
  for (const end = Date.now() + waitMs; Date.now() < end; sleep(200)) {
    const st = readState(id);
    if (st?.state === "failed") die(`the Antigravity session did not start: ${st.error ?? "no reason given"} (log: ${log})`);
    if (st && st.state !== "starting") return id;
    if (st ? !supervisorUp(st) : !up(pid, null)) die(`the Antigravity supervisor exited before its session started (log: ${log})${tail()}`);
  }
  die(`the Antigravity session did not start within ${Math.round(waitMs / 1000)} s (log: ${log})${tail()}`);
}

// Why the supervisor's pid no longer names its process group, or null when it still does. A pid is
// not given out again while a group of that number has a member left, so with no process at that
// pid the group is still the session's, but only within the boot the supervisor started in.
function notOurGroup(st: AgyState): string | null {
  if (!isStartStamp(st.stamp)) return "has no start recorded";
  const boot = currentBoot();
  if (!boot) return "cannot be told from another boot's on this platform";
  if (st.stamp.boot !== boot) return "is from another boot";
  try {
    const now = processStart(st.pid);
    return now === null || sameStart(st.stamp, now) ? null : "is another process's now";
  } catch {
    return "has a start that cannot be read";
  }
}

// SIGTERM to the supervisor, which ends the session; then whatever is left in its scope (or without
// one, its process group while notOurGroup allows) is killed anyway, as a tool agy left or an agy
// whose supervisor crashed would otherwise run on with nothing recording it.
export function stopSession(id: string, remove: boolean): void {
  if (!validId(id)) die(`not an Antigravity session id: ${id}`);
  const st = readState(id);
  if (st) {
    if (supervisorUp(st)) {
      try {
        process.kill(st.pid, "SIGTERM");
      } catch {
        // gone already
      }
      for (const end = Date.now() + 15_000; Date.now() < end && supervisorUp(st); sleep(200));
    }
    const who = st.name ?? id;
    let left: number[] = [];
    if (sessionCgroup(id, st.cgroup)) left = killAll(() => cgroupProcs(st.cgroup!), 2000);
    else if (typeof st.pid === "number" && st.pid > 1) {
      const why = notOurGroup(st);
      if (why === null) left = killTree(st.pid, 2000) ? [] : [st.pid];
      else process.stderr.write(`${who}: no scope recorded, and the supervisor's pid ${st.pid} ${why}, so its process group is not killed\n`);
    }
    if (up(st.agentPid, st.agentStamp) && !killTree(st.agentPid, 2000)) left.push(st.agentPid);
    if (left.length) process.stderr.write(`${who}: still running after SIGKILL: ${left.join(", ")}\n`);
    const after = readState(id);
    if (after && after.state !== "stopped" && after.state !== "failed")
      writeJson(join(sessionDir(id), "state.json"), { ...after, state: "stopped", status: "off", updatedAt: new Date().toISOString() });
  }
  // the transcript is under projects/ and stays
  if (remove) {
    dropUndelivered(id);
    rmSync(sessionDir(id), { recursive: true, force: true });
  }
}

// Tells each message that never reached the session, and keeps it in the transcript. stderr, as a
// stop can run inside the wake hook, whose stdout is its answer.
function dropUndelivered(id: string): void {
  const left = inbox(id);
  if (!left.length) return;
  const st = readState(id);
  const who = st?.name ?? id;
  for (const m of left) {
    process.stderr.write(`${who}: a message from ${m.from ?? "an unknown sender"}${m.at ? ` (${m.at})` : ""} never reached the session, and the stop drops it from the inbox:\n${m.text.replace(/^/gm, "  ")}\n`);
    if (st?.transcript)
      try {
        appendFileSync(st.transcript, JSON.stringify({ type: "undelivered", from: m.from, queuedAt: m.at, text: m.text, timestamp: new Date().toISOString(), sessionId: st.sessionId, cwd: st.cwd }) + "\n");
      } catch (e) {
        process.stderr.write(`${who}: and it could not be kept in the transcript ${st.transcript}: ${(e as Error).message}\n`);
      }
  }
}

// A message for a live session, sent as its next prompt once the one in flight has ended.
export function deliver(s: Session, text: string, from?: string): void {
  if (!validId(s.id) || !sessionAlive(s)) die(`${s.name ?? s.id ?? "the session"} is not running, so the message cannot reach it`);
  enqueue(s.id, text, from);
}

export const antigravityBackend: AgentBackend = {
  name: "antigravity",
  ...CAPABILITIES.antigravity,
  launchArgs,
  start: (req, appendixPath) => startSupervisor(req.cwd, req.args(appendixPath), req.env, req.timeoutMs ? Math.min(req.timeoutMs, START_WAIT_MS) : START_WAIT_MS),
  stop: stopSession,
  sessions: listSessions,
  sessionsAsync: () => Promise.resolve().then(() => listSessions()).catch(() => []),
  alive: sessionAlive,
  midTurn,
  messageTool: null,
  // the hook is written here, at every launch, so it names the factory that starts the session
  installSettings: (ws, s) => {
    ensureAgyHook();
    return renderSettings(ws, s, null);
  },
  deliver,
  logsHint: (id) => `the supervisor's log, ${join(sessionDir(id), "supervisor.log")}`,
  transcriptsDir,
  projectDir,
  transcriptAt,
  planUsage: () => () => Promise.reject(new Error("Antigravity's plan usage is not read")),
};
