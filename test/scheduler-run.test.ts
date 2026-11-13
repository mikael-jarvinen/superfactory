// `factory schedule run` against a throwaway workspace and a fake claude.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { boardPid } from "../src/board/server.js";
import { openWorkspace } from "../src/workspace.js";
import { CLI, tempDir } from "./helpers.js";

const linux = process.platform === "linux" ? false : "the scheduler runs off macOS; these tests use /proc";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => res(port));
  });
});
async function until(what: string, fn: () => unknown, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (fn()) return;
  assert.fail(`timed out waiting for ${what}`);
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Run = ChildProcess & { out: string };
const UP = "superfactory.ada.up";

// A workspace whose `up` never finishes: the fake claude lists no sessions, so up waits for a lead
// that never appears. That makes it the long-running job these tests need.
async function setup() {
  const dir = tempDir("sf-schedule-run-");
  const ws = join(dir, "ws");
  const home = join(dir, "home");
  for (const d of [join(ws, "lead"), join(ws, "prompts"), join(dir, "bin"), home]) mkdirSync(d, { recursive: true });
  const seen = join(dir, "claude-calls");
  writeFileSync(join(dir, "bin", "claude"), `#!/bin/sh
echo "HOME=$HOME USER=$USER TMPDIR=$TMPDIR DBUS=$DBUS_SESSION_BUS_ADDRESS XDG=$XDG_RUNTIME_DIR SSH=$SSH_AUTH_SOCK NOT_INHERITED=$NOT_INHERITED args=$* parent=$(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> ${seen}
case "$1" in agents) echo '[]' ;; auth) echo '{"loggedIn": true}' ;; *) exit 0 ;; esac
`);
  chmodSync(join(dir, "bin", "claude"), 0o755);
  writeFileSync(join(ws, "lead", "CLAUDE.md"), "You lead.\n");
  writeFileSync(join(ws, "prompts", "round.md"), "Judge the facts.\n");
  writeFileSync(join(ws, "factory.toml"), `[human]\nname = "Alex"\n\n[paths]\nrepos = "repos"\n\n[roles.lead]\ncwd = "lead"\nsettings = "lead"\n\n[[agents]]\nname = "ada"\nrole = "lead"\n\n[board]\nhost = "127.0.0.1"\nport = ${await freePort()}\n`);
  const env = { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: home, USER: "factory-test", TMPDIR: dir, CLAUDE_BIN: join(dir, "bin", "claude"), GH_BIN: "", DOCKER_BIN: "", SF_NOTIFY: "0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", XDG_RUNTIME_DIR: "/run/user/1", SSH_AUTH_SOCK: join(dir, "agent.sock"), NOT_INHERITED: "x" };
  const stateFile = join(ws, "logs", "run", "scheduler.json");
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const runs: Run[] = [];
  const start = (...extra: string[]) => {
    const every = extra.includes("--check-seconds") ? [] : ["--check-seconds", "1"];
    const p = spawn(process.execPath, [CLI, "--workspace", ws, "schedule", "run", ...every, ...extra], { env, stdio: ["ignore", "pipe", "pipe"] }) as Run;
    p.out = "";
    p.stdout?.on("data", (b) => (p.out += b));
    p.stderr?.on("data", (b) => (p.out += b));
    runs.push(p);
    return p;
  };
  const upPids = new Set<number>();
  const upRunning = () => existsSync(stateFile) && state().jobs[UP]?.pid;
  after(() => {
    for (const p of runs) p.kill("SIGKILL");
    for (const pid of upPids) {
      try {
        process.kill(-pid, "SIGKILL"); // detached: its own process group
      } catch {}
    }
    // a board `up` started while no scheduler held board.pid outlives the test otherwise
    const board = boardPid(openWorkspace(ws));
    try {
      if (board) process.kill(board, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, ws, home, seen, state, start, upPids, upRunning };
}

test("a job gets HOME, USER and TMPDIR as launchd would give it, and the session bus and SSH agent", { skip: linux }, async () => {
  const t = await setup();
  const d = t.start();
  // the board in the scheduler's own process calls claude too, with the scheduler's environment
  const fromUp = () => (existsSync(t.seen) ? readFileSync(t.seen, "utf8").split("\n").find((l) => / up $/.test(l)) : undefined);
  await until("up to call claude", () => fromUp() && t.upRunning());
  t.upPids.add(t.state().jobs[UP].pid);
  const line = fromUp() as string;
  assert.match(line, new RegExp(`^HOME=${t.home} USER=factory-test TMPDIR=${t.dir} DBUS=unix:path=/run/user/1/bus XDG=/run/user/1 SSH=${t.dir}/agent.sock NOT_INHERITED= args=`), "an unlisted variable is refused: " + line);
  d.kill();
});

test("the board is served in the scheduler's process, and its pid file names it", { skip: linux }, async () => {
  const t = await setup();
  const d = t.start();
  const pidFile = join(t.ws, "logs", "board.pid");
  await until("the board", () => d.out.includes("board on http://127.0.0.1:"));
  assert.equal(readFileSync(pidFile, "utf8").trim(), String(d.pid));
  await until("up to run", () => t.upRunning());
  t.upPids.add(t.state().jobs[UP].pid);
  d.kill("SIGTERM");
  await until("the scheduler to stop", () => d.exitCode !== null);
  assert.equal(d.exitCode, 0, d.out);
  assert.ok(!existsSync(pidFile), "its pid file goes with it");
});

test("a restarted scheduler waits for its predecessor's run, and marks it ended when it goes", { skip: linux }, async () => {
  const t = await setup();
  let d = t.start();
  await until("up to run", () => t.upRunning());
  const pid = t.state().jobs[UP].pid;
  t.upPids.add(pid);
  d.kill("SIGKILL");
  await until("the first scheduler to die", () => d.exitCode !== null || d.signalCode !== null);
  assert.ok(alive(pid), "KillMode=process: the run outlives its scheduler");

  d = t.start();
  await until("the fire to be skipped", () => d.out.includes(`still running (pid ${pid}), this fire skipped`));
  assert.equal(t.state().jobs[UP].pid, pid, "adopted, not doubled");

  process.kill(-pid, "SIGKILL");
  await until("the run to be marked ended", () => t.state().jobs[UP].pid === null);
  assert.equal(t.state().jobs[UP].lastExit, "unknown (started by an earlier scheduler)");
  d.kill();
});

test("a pid reused since the run was recorded does not hold the job off", { skip: linux }, async () => {
  const t = await setup();
  // as after a reboot: the state file names a pid that now belongs to something started later
  const stranger = spawn("sleep", ["60"], { detached: true });
  t.upPids.add(stranger.pid as number);
  mkdirSync(join(t.ws, "logs", "run"), { recursive: true });
  const lastStart = new Date(Date.now() - 3600_000).toISOString();
  writeFileSync(join(t.ws, "logs", "run", "scheduler.json"), JSON.stringify({
    pid: 1, at: lastStart, checkSeconds: 1, jobs: { [UP]: { due: lastStart, lastStart, pid: stranger.pid, stamp: "an-earlier-boot:12345" } },
  }));
  const d = t.start();
  await until("up to start afresh", () => {
    const p = t.state().jobs[UP].pid;
    return p && p !== stranger.pid;
  });
  t.upPids.add(t.state().jobs[UP].pid);
  assert.ok(!d.out.includes("still running"), d.out);
  assert.ok(alive(stranger.pid as number), "the stranger is left alone");
  d.kill();
});

test("a missed fire runs once, and the job is then due at its next calendar time", { skip: linux }, async () => {
  const t = await setup();
  const ROUND = "superfactory.ada.round";
  // as after a night asleep: the round was due three hours ago, so three fires were missed
  mkdirSync(join(t.ws, "logs", "run"), { recursive: true });
  const due = new Date(Date.now() - 3 * 3600_000).toISOString();
  writeFileSync(join(t.ws, "logs", "run", "scheduler.json"), JSON.stringify({ pid: 1, at: due, checkSeconds: 1, jobs: { [ROUND]: { due } } }));
  const d = t.start();
  await until("the round to run", () => t.state().jobs[ROUND]?.lastStart);
  const first = t.state().jobs[ROUND].lastStart;
  await sleep(2500); // two more checks
  const r = t.state().jobs[ROUND];
  assert.equal(r.lastStart, first, "run once, not once per missed fire");
  const next = new Date(r.due);
  assert.ok(next.getTime() > Date.parse(first) && next.getTime() - Date.parse(first) <= 3600_000, r.due);
  assert.equal(next.getMinutes(), 7, "the round's calendar minute");
  if (t.upRunning()) t.upPids.add(t.state().jobs[UP].pid);
  d.kill();
});

test("over its memory limit, the scheduler exits 75 for a restart, on its first check", { skip: linux }, async () => {
  const t = await setup();
  // a second check would be a minute away
  const d = t.start("--memory-limit-mb", "1", "--check-seconds", "60");
  await until("the scheduler to exit", () => d.exitCode !== null, 10_000);
  assert.equal(d.exitCode, 75, d.out);
  assert.match(d.out, /rss \d+ MB over limit 1 MB, exiting for a restart/);
  const s = t.state();
  assert.ok(Number.isInteger(s.rssMb) && Number.isInteger(s.loopLagMs), "self-health is in the state file");
  if (s.jobs[UP]?.pid) t.upPids.add(s.jobs[UP].pid);
});
