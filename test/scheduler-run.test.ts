// `factory schedule run` against a throwaway workspace and a fake claude.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
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

// Every process a test started, wherever it has been reparented or regrouped since: each carries
// the test's TMPDIR, and a board names the workspace under it. A zombie has neither, so it is not
// counted.
function startedBy(dir: string): number[] {
  const env = Buffer.from(`\0TMPDIR=${dir}\0`);
  const arg = Buffer.from(`\0${dir}/`);
  return readdirSync("/proc").filter((e) => /^\d+$/.test(e)).map(Number).filter((pid) => {
    try {
      const nul = Buffer.from([0]);
      return Buffer.concat([nul, readFileSync(`/proc/${pid}/environ`)]).includes(env) || Buffer.concat([nul, readFileSync(`/proc/${pid}/cmdline`)]).includes(arg);
    } catch {
      return false; // gone, or not ours
    }
  });
}
const cmdline = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return "";
  }
};

type Run = ChildProcess & { out: string };
const UP = "superfactory.ada.up";

// A workspace whose `up` never finishes: the fake claude lists no sessions, so up waits for a lead
// that never appears. That makes it the long-running job these tests need.
async function setup(extraEnv: Record<string, string> = {}) {
  const dir = tempDir("sf-schedule-run-");
  const ws = join(dir, "ws");
  const home = join(dir, "home");
  for (const d of [join(ws, "lead"), join(ws, "prompts"), join(dir, "bin"), home]) mkdirSync(d, { recursive: true });
  const seen = join(dir, "claude-calls");
  const boardPort = await freePort();
  writeFileSync(join(dir, "bin", "claude"), `#!/bin/sh
echo "HOME=$HOME USER=$USER TMPDIR=$TMPDIR DBUS=$DBUS_SESSION_BUS_ADDRESS XDG=$XDG_RUNTIME_DIR SSH=$SSH_AUTH_SOCK NOT_INHERITED=$NOT_INHERITED args=$* parent=$(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> ${seen}
# a print-mode run (the courier) is given its prompt on stdin
[ "$1" = -p ] && cat >> ${join(dir, "courier-stdin")}
[ "$1" = -p ] && [ -n "$FAKE_COURIER_EXIT" ] && exit "$FAKE_COURIER_EXIT"
# replace relay.log with a directory while the courier runs, so its exit line cannot be written
[ "$1" = -p ] && [ -n "$FAKE_RELAY_LOG_GOES" ] && rm -f ${join(ws, "logs", "relay.log")} && mkdir ${join(ws, "logs", "relay.log")}
case "$1" in agents) echo '[]' ;; auth) echo '{"loggedIn": true}' ;; *) exit 0 ;; esac
`);
  chmodSync(join(dir, "bin", "claude"), 0o755);
  writeFileSync(join(ws, "lead", "CLAUDE.md"), "You lead.\n");
  writeFileSync(join(ws, "prompts", "round.md"), "Judge the facts.\n");
  writeFileSync(join(ws, "prompts", "relay.md"), "Carry {text}.\n");
  writeFileSync(join(ws, "factory.toml"), `[human]\nname = "Alex"\n\n[paths]\nrepos = "repos"\n\n[roles.lead]\ncwd = "lead"\nsettings = "lead"\n\n[[agents]]\nname = "ada"\nrole = "lead"\n\n[board]\nhost = "127.0.0.1"\nport = ${boardPort}\n`);
  const env = { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: home, USER: "factory-test", TMPDIR: dir, CLAUDE_BIN: join(dir, "bin", "claude"), GH_BIN: "", DOCKER_BIN: "", SF_NOTIFY: "0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", XDG_RUNTIME_DIR: "/run/user/1", SSH_AUTH_SOCK: join(dir, "agent.sock"), NOT_INHERITED: "x", ...extraEnv };
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
  after(async () => {
    for (const p of runs) p.kill("SIGKILL");
    // a test that failed early never recorded the last up's pid
    try {
      upPids.add(state().jobs[UP].pid);
    } catch {}
    for (const pid of upPids) {
      if (!pid) continue; // null, or NaN from an empty pid file
      try {
        process.kill(-pid, "SIGKILL"); // detached: its own process group
      } catch {}
    }
    // then anything else left. A process mid-exec can match neither check, so stop after three empty passes.
    let left: number[] = [];
    let empty = 0;
    for (let i = 0; empty < 3 && i < 50; i++, await sleep(100)) {
      left = startedBy(dir);
      empty = left.length ? 0 : empty + 1;
      for (const pid of left) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    if (empty < 3) left = startedBy(dir);
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(left.map(cmdline), [], "processes the test started, still running");
  });
  const post = (text: string) => fetch(`http://127.0.0.1:${boardPort}/api/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
  });
  const page = async () => (await fetch(`http://127.0.0.1:${boardPort}/`)).status;
  return { dir, ws, home, seen, state, start, upPids, upRunning, post, page };
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
  const up = t.state().jobs[UP].pid;
  t.upPids.add(up);
  // up looks for the board before it asks claude for the lead's session
  await until("up past its board check", () => existsSync(t.seen) && / up $/m.test(readFileSync(t.seen, "utf8")));
  assert.deepEqual(startedBy(t.dir).map(cmdline).filter((c) => c.includes("board --serve")), [], "up found the scheduler's board and started none");
  // a board started by up would already have exited on the taken port, but up removes
  // board.pid and opens board.log before it starts one
  assert.equal(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim(), String(d.pid), "board.pid still names the scheduler");
  assert.ok(!existsSync(join(t.ws, "logs", "board.log")), "up opened no board log, so started no board");
  // up gone first: with the scheduler stopped and board.pid removed, an up still booting would start a board
  process.kill(-up, "SIGKILL");
  await until("up to go", () => !alive(up)); // the scheduler reaps it
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

// The scheduler's board relays: a page line that lands while no monitor holds the inbox is carried
// to the lead by a courier, which is claude run from the scheduler with the workspace's relay prompt.
test("a message from the page reaches the courier", { skip: linux }, async () => {
  const t = await setup();
  const d = t.start();
  await until("the board", () => d.out.includes("board on "));
  await until("up to run", () => t.upRunning());
  t.upPids.add(t.state().jobs[UP].pid);
  const res = await t.post("hello from the page");
  assert.equal(res.status, 200, await res.text());
  const stdin = join(t.dir, "courier-stdin");
  await until("the courier to be given the line", () => existsSync(stdin) && readFileSync(stdin, "utf8").includes("hello from the page"));
  assert.match(readFileSync(stdin, "utf8"), /^Carry \[from the message page\] \[m:[^\]]+\] hello from the page/);
  const call = readFileSync(t.seen, "utf8").split("\n").find((l) => / args=-p /.test(l)) as string;
  assert.match(call, / --settings \S*settings-watcher\.relay\.json /, call);
  assert.match(call, / --allowedTools SendMessage,ListAgents parent=/, call);
  d.kill();
});

test("a board that cannot take the inbox lock says so in the scheduler's output and the failures log", { skip: linux }, async () => {
  const t = await setup({ FLOCK_BIN: "/nonexistent" });
  const d = t.start();
  await until("the sweep failure in the scheduler's output", () => d.out.includes("the courier sweep failed: the inbox lock: flock(1) failed"));
  await until("up to run", () => t.upRunning());
  t.upPids.add(t.state().jobs[UP].pid);
  await sleep(1500);
  assert.equal(d.out.split("the courier sweep failed").length - 1, 1, "said once, not every pass");
  const logged = readFileSync(join(t.ws, "logs", "watcher-failures.log"), "utf8").split("\n").filter((l) => l.includes("board sweep FAILED"));
  assert.equal(logged.length, 1, "once in the failures log too");
  assert.match(logged[0] as string, /board sweep FAILED: the inbox lock: flock\(1\) failed/);
  d.kill();
});

test("a sweep failure the failures log cannot take does not bring the scheduler down", { skip: linux }, async () => {
  const t = await setup({ FLOCK_BIN: "/nonexistent" });
  mkdirSync(join(t.ws, "logs", "watcher-failures.log"), { recursive: true }); // a directory: every append fails
  const d = t.start();
  await until("both failures in the scheduler's output", () => d.out.includes("the courier sweep failed: the inbox lock") && d.out.includes("the failures log could not be written: EISDIR"));
  await until("up to run", () => t.upRunning());
  t.upPids.add(t.state().jobs[UP].pid);
  await sleep(1500);
  assert.equal(d.exitCode, null, d.out);
  assert.equal(await t.page(), 200, "the board still serves");
  assert.ok(!d.out.includes("board cannot listen"), d.out);
  d.kill();
});

test("a courier that fails while the failures log cannot be written does not bring the scheduler down", { skip: linux }, async () => {
  const t = await setup({ FAKE_COURIER_EXIT: "3" });
  mkdirSync(join(t.ws, "logs", "watcher-failures.log"), { recursive: true }); // a directory: every append fails
  const d = t.start();
  await until("the board", () => d.out.includes("board on "));
  await until("up to run", () => t.upRunning());
  t.upPids.add(t.state().jobs[UP].pid);
  const res = await t.post("hello from the page");
  assert.equal(res.status, 200, await res.text());
  const said = "relay FAILED exit=3 (the failures log could not be written: EISDIR";
  await until("the courier's failure on stderr, or the scheduler's end", () => d.out.includes(said) || d.exitCode !== null);
  await sleep(1000);
  assert.equal(d.exitCode, null, d.out);
  assert.ok(d.out.includes(said), d.out);
  assert.equal(await t.page(), 200, "the board still serves");
  d.kill();
});

test("a courier whose log cannot take its exit line does not bring the scheduler down", { skip: linux }, async () => {
  const t = await setup({ FAKE_RELAY_LOG_GOES: "1" });
  const d = t.start();
  await until("the board", () => d.out.includes("board on "));
  await until("up to run", () => t.upRunning());
  t.upPids.add(t.state().jobs[UP].pid);
  const res = await t.post("hello from the page");
  assert.equal(res.status, 200, await res.text());
  const stdin = join(t.dir, "courier-stdin");
  await until("the courier to be given the line, or the scheduler's end", () => (existsSync(stdin) && readFileSync(stdin, "utf8").includes("hello from the page")) || d.exitCode !== null);
  await sleep(1500);
  assert.ok(statSync(join(t.ws, "logs", "relay.log")).isDirectory(), "the courier's log really went");
  assert.equal(d.exitCode, null, d.out);
  assert.equal(await t.page(), 200, "the board still serves");
  d.kill();
});
