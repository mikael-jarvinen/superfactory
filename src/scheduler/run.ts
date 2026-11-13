// factory schedule run: runs launchd's jobs (jobs() in launchd.ts) off macOS and serves the board.
// State is logs/run/scheduler.json; over the memory limit it exits 75 so systemd restarts it.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Receipts } from "../board/inbox.js";
import { type ServeOptions, pidFile, serve } from "../board/server.js";
import type { Workspace } from "../workspace.js";
import { startStamp } from "../stacks/process.js";
import { nextDue, runAlive } from "./daemon.js";
import { type Job, environment, jobs } from "./launchd.js";
import { cleanUp } from "./leftovers.js";
import { watchdog } from "./watchdog.js";
import { type JobRun, readState, stateFile } from "./state.js";

export interface RunOptions {
  checkSeconds?: number;
  memoryLimitMb?: number;
  unansweredMinutes?: number;
  board?: ServeOptions;
  log?: (line: string) => void;
}

// launchd sets HOME, USER and TMPDIR, and environment() relies on them; a spawned child gets only
// what it is given. gh reads its keyring over the session bus (DBUS_SESSION_BUS_ADDRESS,
// XDG_RUNTIME_DIR), and git over SSH needs SSH_AUTH_SOCK.
const INHERIT = ["HOME", "USER", "TMPDIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"];

export async function runScheduler(ws: Workspace, opts: RunOptions = {}): Promise<void> {
  const checkSeconds = opts.checkSeconds ?? 30;
  const memoryLimitMb = opts.memoryLimitMb ?? 512;
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));

  let loopLagMs = 0;
  let lagExpected = Date.now() + 1000;
  setInterval(() => {
    const now = Date.now();
    loopLagMs = Math.max(0, now - lagExpected);
    lagExpected = now + 1000;
  }, 1000).unref();
  const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

  const jobEnv = () => ({
    ...Object.fromEntries(INHERIT.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string])),
    ...environment(ws, process.env),
  });

  // A run is a detached child: KillMode=process leaves it running when the scheduler restarts, so a
  // round in flight is not cut off. Its pid is kept in runs, and a scheduler that comes back finds it
  // by pid and start time rather than starting a second one.
  const before = readState(ws)?.jobs ?? {};
  const want = jobs(ws);
  const runs: Record<string, JobRun> = {};
  const children = new Set<number>(); // pids this process started, whose exit it hears
  const live = () => new Set(Object.values(runs).map((r) => r.pid).filter((p): p is number => !!p));
  const alive = (label: string) =>
    runAlive(runs[label] as JobRun, (e) => log(`job ${label}: cannot tell whether pid ${runs[label]?.pid} is still the run (${(e as Error).message}); counting it as running`));

  // its own start stamp, so a reader can tell this process from a later one given its pid
  const stamp = startStamp(process.pid);
  const writeState = () => {
    const p = stateFile(ws);
    mkdirSync(dirname(p), { recursive: true });
    const body = { pid: process.pid, stamp, at: new Date().toISOString(), checkSeconds, loopLagMs, rssMb: rssMb(), jobs: runs };
    writeFileSync(`${p}.tmp`, JSON.stringify(body, null, 2) + "\n");
    renameSync(`${p}.tmp`, p);
  };

  function start(j: Job) {
    const r = runs[j.label] as JobRun;
    mkdirSync(ws.logsDir, { recursive: true });
    const fd = openSync(join(ws.logsDir, `scheduler-${j.name}.log`), "a");
    let child;
    try {
      child = spawn(j.args[0] as string, j.args.slice(1), { cwd: ws.dir, env: jobEnv(), stdio: ["ignore", fd, fd], detached: true });
    } finally {
      closeSync(fd);
    }
    r.lastStart = new Date().toISOString();
    r.pid = child.pid ?? null;
    r.stamp = null;
    if (child.pid) {
      try {
        r.stamp = startStamp(child.pid);
      } catch (e) {
        log(`job ${j.label}: no start stamp for pid ${child.pid} (${(e as Error).message}); a restarted scheduler will go by the pid alone`);
      }
      children.add(child.pid);
    }
    child.unref();
    const pid = child.pid;
    const done = (exit: number | string | null) => {
      if (pid) children.delete(pid);
      r.lastEnd = new Date().toISOString();
      r.lastExit = exit;
      r.pid = null;
      if (exit !== 0) log(`job ${j.label} exited ${exit}`);
      if (pid) clear(j.label, pid);
      writeState();
    };
    child.once("error", (e: NodeJS.ErrnoException) => done(e.code ?? String(e)));
    child.once("exit", (code, sig) => done(code ?? sig));
  }

  const clearingInProcess = new Set<string>(); // label:pgid, a cleanUp under way in this process
  function clear(label: string, pgid: number) {
    const r = runs[label] as JobRun;
    if (!r.clearing?.includes(pgid)) r.clearing = [...(r.clearing ?? []), pgid];
    const key = `${label}:${pgid}`;
    if (clearingInProcess.has(key)) return;
    clearingInProcess.add(key);
    cleanUp(label, pgid, live(), log, (deferred) => {
      clearingInProcess.delete(key);
      if (deferred) return; // still in clearing, so the next check tries again
      r.clearing = r.clearing?.filter((g) => g !== pgid);
      if (!r.clearing?.length) delete r.clearing;
      writeState();
    });
  }

  // A missed fire (sleep, restart) runs once on wake, not once per fire missed. Like launchd, the
  // first fire of a job never seen before is its next calendar time, except RunAtLoad, which also
  // runs once when the scheduler starts.
  for (const j of want) {
    const prev = before[j.label];
    runs[j.label] = { ...prev, due: j.runAtLoad ? new Date(0).toISOString() : (prev?.due ?? nextDue(j.calendar, new Date()).toISOString()) };
  }

  // Shared with the board, so the lead's transcripts are read from the start once, not twice.
  const receipts = opts.board?.receipts ?? new Receipts();
  const board: ServeOptions = { ...opts.board, receipts };
  const unanswered = watchdog(ws, { staleMinutes: opts.unansweredMinutes ?? 12, checkSeconds, receipts }, log);

  let checking = false;
  async function check() {
    if (checking) return;
    checking = true;
    try {
      const now = Date.now();
      for (const j of want) {
        const r = runs[j.label] as JobRun;
        // A run an earlier scheduler started is not this one's child, so its exit is never heard:
        // when its pid is gone it is over, with an exit nobody saw.
        if (r.pid && !children.has(r.pid) && !alive(j.label)) {
          const pgid = r.pid;
          Object.assign(r, { pid: null, lastEnd: new Date().toISOString(), lastExit: "unknown (started by an earlier scheduler)" });
          clear(j.label, pgid);
        }
        for (const pgid of [...(r.clearing ?? [])]) clear(j.label, pgid);
        const due = Date.parse(r.due);
        if (due > now + 1000) continue; // 1s slack, so a job due just after this check is not pushed a whole period
        try {
          if (alive(j.label)) log(`job ${j.label} still running (pid ${r.pid}), this fire skipped`);
          else start(j);
        } catch (e) {
          log(`job ${j.label} failed to start: ${(e as Error).stack ?? e}`);
        }
        r.due = nextDue(j.calendar, new Date(Math.max(Date.now(), due))).toISOString();
      }
      writeState();
      try {
        unanswered();
      } catch (e) {
        log(`watchdog failed: ${(e as Error).stack ?? e}`);
      }
      if (rssMb() > memoryLimitMb) {
        log(`rss ${rssMb()} MB over limit ${memoryLimitMb} MB, exiting for a restart`);
        stop(75);
      }
    } catch (e) {
      // check runs from a timer, so a throw here would be an unhandled rejection and end the process
      log(`check failed: ${(e as Error).stack ?? e}`);
    } finally {
      checking = false;
    }
  }

  let loop: NodeJS.Timeout | undefined;
  let closeBoard: (() => Promise<void>) | null = null;
  let stopping = false;
  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    clearInterval(loop);
    try {
      if (readFileSync(pidFile(ws), "utf8").trim() === String(process.pid)) unlinkSync(pidFile(ws));
    } catch {
      // never written, or already gone
    }
    const exit = () => process.exit(code);
    (closeBoard ? closeBoard() : Promise.resolve()).finally(exit);
    setTimeout(exit, 3000).unref();
  }
  process.once("SIGTERM", () => { log("SIGTERM, stopping"); stop(0); });
  process.once("SIGINT", () => { log("SIGINT, stopping"); stop(0); });

  // The board, in this process. `up` finds it by board.pid and leaves it be, so the pid file is
  // written before the first check can start `up`. A board that cannot listen is logged and the
  // jobs run without it.
  try {
    const b = await serve(ws, board);
    closeBoard = b.close;
    mkdirSync(ws.logsDir, { recursive: true });
    writeFileSync(pidFile(ws), String(process.pid));
    log(`board on ${b.url}`);
  } catch (e) {
    log(`board cannot listen on ${opts.board?.host ?? ws.config.board.host}:${opts.board?.port ?? ws.config.board.port}: ${(e as Error).message}`);
  }

  log(`scheduler for ${ws.dir} pid ${process.pid}, every ${checkSeconds}s, jobs [${want.map((j) => j.name).join(", ")}]`);
  loop = setInterval(check, checkSeconds * 1000);
  void check();
}
