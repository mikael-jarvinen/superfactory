import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { agentOrDie, findSession, type Session } from "../src/fleet.js";
import { claudeEnv, claudeScoped, JOB_ENV, SCOPE } from "../src/scope.js";
import { procStat } from "../src/stacks/process.js";
import { agentSessions, daemonAlive, local, pick, sessionAlive, type Transport } from "../src/transport.js";
import { runClaude } from "../src/watchers/job.js";
import { run } from "../src/util.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, fakeDaemon, tempDir, tempWorkspace, TOML } from "./helpers.js";

// What a real systemd-run --user --scope said with no user bus: systemd 259 (niilo), 249 (turing).
const NO_BUS_259 = "Failed to connect to user scope bus via local transport: No such file or directory";
const NO_BUS_249 = "Failed to connect to bus: No such file or directory";
// A systemd-run first on PATH: it logs its arguments, one call per line, tab-separated, then runs
// what follows "--" as a real one does in a scope, and says so and exits 1 when that is no
// executable. While <dir>/scope-fail exists it makes no scope and says what that file holds.
function fakeSystemdRun(dir: string): string {
  const log = join(dir, "scope-calls");
  writeFileSync(join(dir, "systemd-run"), `#!/bin/sh
{ printf 'systemd-run'; for a in "$@"; do printf '\\t%s' "$a"; done; echo; } >> ${log}
[ -f ${dir}/scope-fail ] && { cat ${dir}/scope-fail >&2; echo >&2; exit 1; }
while [ "$1" != "--" ]; do [ $# -gt 0 ] || exit 2; shift; done
shift
command -v "$1" >/dev/null || { echo "Failed to find executable $1: No such file or directory" >&2; exit 1; }
exec "$@"
`);
  chmodSync(join(dir, "systemd-run"), 0o755);
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  after(() => (process.env.PATH = was));
  return log;
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")) : []);

test("the local start writes the appendix it is given and names it on the command line", () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  writeFileSync(claude, `#!/bin/sh
prev=
for a in "$@"; do [ "$prev" = --append-system-prompt-file ] && cat "$a" > "${dir}/appendix"; prev=$a; done
echo "$@" > "${dir}/args"
echo "backgrounded · abc123 · rae"
`);
  chmodSync(claude, 0o755);
  fakeSystemdRun(dir);
  const was = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = claude;
  after(() => (was === undefined ? delete process.env.CLAUDE_BIN : (process.env.CLAUDE_BIN = was)));
  const ws = openWorkspace(tempWorkspace(), {});
  after(() => rmSync(ws.dir, { recursive: true, force: true }));
  const req = { agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, runDir: ws.runDir, env: process.env };
  const args = (p: string | null) => ["--bg", ...(p ? ["--append-system-prompt-file", p] : []), "P"];
  const named = () => readFileSync(join(dir, "args"), "utf8").split(" ")[2] as string;

  assert.equal(local.start({ ...req, appendix: "the brief\n", args }), "abc123");
  assert.equal(readFileSync(join(dir, "appendix"), "utf8"), "the brief\n");
  // in logs/run/, which a reboot keeps, and left there for a later respawn of that session
  const first = named();
  assert.equal(dirname(first), ws.runDir);
  assert.match(basename(first), /^appendix-bea-[0-9a-f]{16}\.md$/);
  // the same brief again is the same file; a changed brief is another, and the first is kept as it was
  local.start({ ...req, appendix: "the brief\n", args });
  assert.equal(named(), first);
  local.start({ ...req, appendix: "a new brief\n", args });
  assert.notEqual(named(), first);
  assert.equal(readFileSync(first, "utf8"), "the brief\n");
  assert.equal(readFileSync(named(), "utf8"), "a new brief\n");
  assert.deepEqual(readdirSync(ws.runDir).filter((n) => n.endsWith(".tmp")), []);
  rmSync(join(dir, "appendix"));
  local.start({ ...req, appendix: null, args });
  assert.equal(readFileSync(join(dir, "args"), "utf8"), "--bg P\n");
});

// A reviewer here: `factory review` writes its brief to the file named on the command line.
test("a reviewer started on demand here gets its appendix as the file it starts with", () => {
  const dir = tempWorkspace(TOML.replace('name = "rae"\nrole = "reviewer"', 'name = "rae"\nrole = "reviewer"\nappendix = ["briefs/rae.md"]'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "reviewers"));
  mkdirSync(join(dir, "briefs"));
  writeFileSync(join(dir, "briefs", "rae.md"), "rae's brief\n");
  writeFileSync(join(dir, "bin", "claude"), `#!/bin/sh
if [ "$1" = agents ]; then
  if [ -f "${dir}/started" ]; then echo '[{"id":"abc123","name":"rae","kind":"background","state":"idle","pid":${process.pid}}]'; else echo '[]'; fi
  exit 0
fi
prev=
for a in "$@"; do [ "$prev" = --append-system-prompt-file ] && cat "$a" > "${dir}/appendix" && rm "$a"; prev=$a; done
touch "${dir}/started"
echo "backgrounded · abc123 · rae"
`);
  const r = factory(dir, ["review"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "appendix"), "utf8"), "<!-- briefs/rae.md -->\nrae's brief\n");
});

test("on Linux every local claude call, each listing included, runs through systemd-run in a scope under agents.slice", { skip: process.platform !== "linux" }, async () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  const calls = join(dir, "claude-calls");
  writeFileSync(claude, `#!/bin/sh
echo "$*" >> ${calls}
case "$1" in agents) echo '[]' ;; --bg) echo "backgrounded · abc123 · bea" ;; respawn) echo "respawned $2" ;; esac
`);
  chmodSync(claude, 0o755);
  const scopes = fakeSystemdRun(dir);
  const was = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = claude;
  after(() => (was === undefined ? delete process.env.CLAUDE_BIN : (process.env.CLAUDE_BIN = was)));
  const ws = openWorkspace(tempWorkspace(), {});
  after(() => rmSync(ws.dir, { recursive: true, force: true }));

  assert.deepEqual(local.sessions(true), []);
  assert.deepEqual(await local.sessionsAsync(), []);
  assert.equal(local.start({ agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, appendix: null, runDir: ws.runDir, env: process.env, args: () => ["--bg", "P"] }), "abc123");
  assert.deepEqual(local.respawn("bea", "r0"), { ok: true, said: "respawned r0", why: "respawned r0" });
  local.stop("bea", "r1", true);
  assert.deepEqual(readFileSync(calls, "utf8").split("\n").filter(Boolean), ["agents --json --all", "agents --json", "--bg P", "respawn r0", "stop r1", "rm r1"]);
  const scoped = (...a: string[]) => ["systemd-run", ...SCOPE, claude, ...a];
  assert.deepEqual(lines(scopes), [scoped("agents", "--json", "--all"), scoped("agents", "--json"), scoped("--bg", "P"), scoped("respawn", "r0"), scoped("stop", "r1"), scoped("rm", "r1")], "every call is scoped");

  rmSync(calls);
  for (const said of [NO_BUS_259, NO_BUS_249]) {
    writeFileSync(join(dir, "scope-fail"), said);
    assert.throws(() => local.sessions(), { message: `systemd-run made no scope for claude agents: ${said}` });
    assert.throws(() => local.respawn("bea", "r0"), { message: `systemd-run made no scope for claude respawn: ${said}` });
    assert.throws(() => local.start({ agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, appendix: null, runDir: ws.runDir, env: process.env, args: () => ["--bg", "P"] }), /systemd-run made no scope for claude --bg/);
  }
  assert.equal(existsSync(calls), false, "a call that could not be scoped never runs claude bare");

  rmSync(join(dir, "scope-fail"));
  const gone = join(dir, "no-claude");
  process.env.CLAUDE_BIN = gone;
  const missing = `Failed to find executable ${gone}: No such file or directory`;
  assert.deepEqual(local.respawn("bea", "r0"), { ok: false, said: "", why: missing }, "a claude systemd-run cannot find is that call's failure, not a scope's");
  assert.throws(() => local.sessions(), { message: `\`claude agents --json\` failed: ${missing}` });

  // systemd-run fails before it execs claude, so only its first line of stderr can be a scope's:
  // a bus error further down is claude's own, from a hook say.
  const hooked = join(dir, "hooked");
  writeFileSync(hooked, `#!/bin/sh\necho "hook failed" >&2\necho "${NO_BUS_249}" >&2\nexit 1\n`);
  chmodSync(hooked, 0o755);
  process.env.CLAUDE_BIN = hooked;
  assert.deepEqual(local.respawn("bea", "r0"), { ok: false, said: "", why: `hook failed\n${NO_BUS_249}` }, "claude's own failure, not a scope's");
});

// A scheduler job's label names its calls' scopes (scope.ts), so the reaper can find them, but is
// stripped before claude runs: a session or supervisor a job starts must not name its calls after it.
test("in a scheduler job, every claude call's scope is named after the run, and no claude sees the job", { skip: process.platform !== "linux" }, async () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  const calls = join(dir, "claude-calls");
  writeFileSync(claude, `#!/bin/sh
echo "$1 job=$FACTORY_JOB" >> ${calls}
case "$1" in agents) echo '[]' ;; --bg) echo "backgrounded · abc123 · bea" ;; -p) cat > /dev/null; echo done ;; esac
`);
  chmodSync(claude, 0o755);
  const scopes = fakeSystemdRun(dir);
  const was = { bin: process.env.CLAUDE_BIN, job: process.env[JOB_ENV] };
  process.env.CLAUDE_BIN = claude;
  process.env[JOB_ENV] = "superfactory.bea.round";
  after(() => {
    for (const [k, v] of [["CLAUDE_BIN", was.bin], [JOB_ENV, was.job]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  const ws = openWorkspace(tempWorkspace(), {});
  after(() => rmSync(ws.dir, { recursive: true, force: true }));

  local.sessions();
  await local.sessionsAsync();
  local.start({ agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, appendix: null, runDir: ws.runDir, env: process.env, args: () => ["--bg", "P"] });
  local.respawn("bea", "r0");
  local.stop("bea", "r1", false);
  assert.equal(runClaude(ws, "round", "P", ["Read"], join(dir, "round.log")).status, 0);
  assert.deepEqual(readFileSync(calls, "utf8").split("\n").filter(Boolean), ["agents job=", "agents job=", "--bg job=", "respawn job=", "stop job=", "-p job="], "claude never sees the job");
  const unit = new RegExp(`^--unit=factory-job-superfactory\\.bea\\.round-${procStat(process.pid)?.pgid}-${process.pid}-\\d+$`);
  const got = lines(scopes);
  assert.equal(got.length, 6);
  for (const c of got) assert.match(c[1] as string, unit, c.join(" "));
});

test("on Linux a box with no systemd-run says so, and runs no claude bare", { skip: process.platform !== "linux" }, () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const was = process.env.PATH;
  process.env.PATH = dir; // nothing here, systemd-run included
  try {
    assert.throws(() => local.sessions(), { message: "systemd-run did not start for claude agents: spawnSync systemd-run ENOENT" });
  } finally {
    process.env.PATH = was;
  }
});

test("a command whose output passes what run reads failed, and is no command that did not start", () => {
  const sh = run("sh", ["-c", "head -c 2000 /dev/zero"], { maxBuffer: 1000 });
  assert.deepEqual([sh.status, sh.stderr], [1, "sh wrote more than the 1000 bytes of output that are read"]);
  // One stream floods per run, so neither tail depends on which pipe is read first. spawnSync
  // counts both streams together and keeps the chunk that passes the limit, so more than 16384
  // characters of the flooding stream are read, and their last 4096 are past its head.
  const err = run("sh", ["-c", "echo FIRST >&2; head -c 20000 /dev/zero | tr '\\0' b >&2"], { maxBuffer: 16384 }, "claude -p");
  assert.deepEqual([err.stdout, err.stderr], ["", `claude -p wrote more than the 16384 bytes of output that are read\n${"b".repeat(4096)}`], "named for who wrote it, with the tail of its stderr");
  const out = run("sh", ["-c", "echo HEAD; head -c 5000 /dev/zero | tr '\\0' a; yes x | head -c 20000"], { maxBuffer: 16384 });
  assert.equal(out.stdout.length, 4096);
  assert.match(out.stdout, /^[x\n]+$/, "the tail of stdout, not its head");
  // Each stream fits on its own, and only their sum passes the limit.
  const both = (n: number) => run("sh", ["-c", `head -c ${n} /dev/zero >&2; head -c ${n} /dev/zero`], { maxBuffer: 16384 });
  assert.equal(both(9000).stderr.split("\n")[0], "sh wrote more than the 16384 bytes of output that are read");
  assert.equal(both(7000).status, 0);
  assert.equal(run("no-such-command-xyz", []).status, 127);
});

test("on Linux a listing past 64 MB is claude's, not systemd-run's, and one under it parses on both paths", { skip: process.platform !== "linux" }, async () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec head -c ${64 * 1024 * 1024 + 1} /dev/zero\n`);
  chmodSync(claude, 0o755);
  fakeSystemdRun(dir);
  const was = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = claude;
  try {
    assert.throws(() => local.sessions(), { message: `\`claude agents --json\` failed: claude agents wrote more than the ${64 * 1024 * 1024} bytes of output that are read` });
    // 20 MB, past the 16 MB the async listing used to read.
    writeFileSync(claude, `#!/bin/sh\nprintf '[{"id":"s1","name":"bea","kind":"background","state":"idle"}'\nhead -c ${20 * 1024 * 1024} /dev/zero | tr '\\0' ' '\necho ']'\n`);
    assert.equal(local.sessions().length, 1);
    assert.deepEqual(await local.sessionsAsync(), local.sessions());
  } finally {
    was === undefined ? delete process.env.CLAUDE_BIN : (process.env.CLAUDE_BIN = was);
  }
});

test("on Linux a watcher's claude -p runs in a scope too, and one that gets none is logged, then dies", { skip: process.platform !== "linux" }, () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\necho done\n`);
  chmodSync(claude, 0o755);
  const scopes = fakeSystemdRun(dir);
  const was = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = claude;
  after(() => (was === undefined ? delete process.env.CLAUDE_BIN : (process.env.CLAUDE_BIN = was)));
  const ws = openWorkspace(tempWorkspace(), {});
  after(() => rmSync(ws.dir, { recursive: true, force: true }));
  const log = join(dir, "round.log");

  const r = runClaude(ws, "round", "P", ["Read"], log);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "done");
  const [call] = lines(scopes);
  assert.deepEqual(call!.slice(0, SCOPE.length + 3), ["systemd-run", ...SCOPE, claude, "-p"]);

  writeFileSync(join(dir, "scope-fail"), NO_BUS_259);
  assert.throws(() => runClaude(ws, "round", "P", ["Read"], log), { message: `systemd-run made no scope for claude -p: ${NO_BUS_259}` });
  assert.match(readFileSync(log, "utf8"), new RegExp(`${NO_BUS_259}\\n.*exit=1`), "logged before it dies");

  rmSync(join(dir, "scope-fail"));
  writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\necho FIRST >&2\nhead -c 5000 /dev/zero | tr '\\0' b >&2\necho LAST >&2\necho HEAD\nexec head -c ${64 * 1024 * 1024 + 1} /dev/zero\n`);
  assert.equal(runClaude(ws, "round", "P", ["Read"], log).status, 1);
  const logged = readFileSync(log, "utf8");
  assert.match(logged, new RegExp(`claude -p wrote more than the ${64 * 1024 * 1024} bytes of output that are read\\nb{4091}LAST\\n.*exit=1`), "an overflow is claude's, logged with the tail of its stderr");
  assert.ok(!logged.includes("FIRST") && !logged.includes("HEAD"), "tails, not heads");
});

test("a scheduler job's calls get scopes named after its run, and claude never sees the job", () => {
  const pgid = procStat(process.pid)?.pgid;
  const [, first] = claudeScoped(["agents"], "linux", { [JOB_ENV]: "superfactory.ada up" });
  const [, second] = claudeScoped(["agents"], "linux", { [JOB_ENV]: "superfactory.ada up" });
  assert.match(first[0] as string, new RegExp(`^--unit=factory-job-superfactory\\.ada_up-${pgid}-${process.pid}-\\d+$`));
  assert.notEqual(first[0], second[0], "a unit name per call");
  assert.deepEqual(first.slice(1, SCOPE.length + 1), SCOPE);
  assert.deepEqual(claudeScoped(["agents"], "linux", {})[1].slice(0, SCOPE.length), SCOPE, "no job, no unit name");
  assert.deepEqual(claudeEnv({ [JOB_ENV]: "x", HOME: "/h" }), { HOME: "/h" });
});

test("the scope is asked for quietly, so systemd-run's own failure is stderr's first line", () => {
  assert.ok(SCOPE.indexOf("--quiet") >= 0 && SCOPE.indexOf("--quiet") < SCOPE.indexOf("--"), "--quiet, before the --");
});

test("where there is no systemd, claude runs bare", () => {
  assert.deepEqual(claudeScoped(["respawn", "r0"], "darwin")[1], ["respawn", "r0"]);
  assert.equal(claudeScoped(["respawn", "r0"], "linux")[0], "systemd-run");
});

test("an agent's session is its newest live one, else its newest, and only its background ones count", () => {
  const ws = openWorkspace(tempWorkspace(), {});
  after(() => rmSync(ws.dir, { recursive: true, force: true }));
  const row = (id: string, state: string, extra: Partial<Session> = {}) => ({ id, name: "bea", kind: "background", state, ...extra }) as Session;
  const listed = [row("a", "stopped"), row("b", "running"), row("c", "running", { kind: "interactive" }), row("d", "running", { name: "ada" })];
  const bea = agentSessions(ws, (where) => (where === "local" ? listed : undefined)).find((x) => x.agent.name === "bea");
  assert.deepEqual(bea?.hits.map((s) => s.id), ["a", "b"]);
  const t = { alive: (s: Session | null | undefined) => s?.state === "running" } as Transport;
  assert.equal(pick(t, bea?.hits ?? [])?.id, "b");
  assert.equal(pick(t, [row("a", "stopped"), row("e", "failed")])?.id, "a");
  assert.equal(pick(t, []), null);
  // newest by updatedAt, else startedAt, else createdAt, whatever order the listing has
  const old = row("old", "failed", { updatedAt: "2026-11-06T10:00:00Z" });
  const recent = row("new", "failed", { startedAt: "2026-11-13T10:00:00Z" });
  assert.equal(pick(t, [old, recent])?.id, "new");
  assert.equal(pick(t, [recent, old])?.id, "new");
  const liveOld = row("live", "running", { createdAt: "2026-11-01T10:00:00Z" });
  assert.equal(pick(t, [recent, liveOld])?.id, "live");
  // compared as instants: 11:30+02:00 is 09:30Z, older than 10:00Z though it sorts later as text
  const plus2 = row("plus2", "failed", { updatedAt: "2026-11-13T11:30:00+02:00" });
  const zulu = row("zulu", "failed", { updatedAt: "2026-11-13T10:00:00Z" });
  assert.equal(pick(t, [plus2, zulu])?.id, "zulu");
  assert.equal(pick(t, [zulu, plus2])?.id, "zulu");
  // a missing or unparseable timestamp ranks as oldest
  const none = row("none", "failed");
  const junk = row("junk", "failed", { updatedAt: "yesterday-ish" });
  assert.equal(pick(t, [none, junk, old])?.id, "old");
  // a garbled field falls through to the next one that parses
  const garbled = row("garbled", "failed", { updatedAt: "not a date", startedAt: "2026-11-13T08:00:00Z" });
  const clean = row("clean", "failed", { createdAt: "2026-11-10T08:00:00Z" });
  assert.equal(pick(t, [clean, garbled])?.id, "garbled");
  assert.equal(pick(t, [garbled, clean])?.id, "garbled");
  // `claude agents --json --all` as it is: startedAt in epoch milliseconds, no other time
  const listedNow = [
    { id: "1c8affa6", cwd: "/w", kind: "background", startedAt: 1794674031535, sessionId: "s1", name: "bea", state: "stopped" },
    { id: "2d9b00b7", cwd: "/w", kind: "background", startedAt: 1794708148625, sessionId: "s2", name: "bea", state: "stopped" },
  ] as Session[];
  assert.equal(pick(t, listedNow)?.id, "2d9b00b7", "the later start, though listed second");
  assert.equal(pick(t, [...listedNow].reverse())?.id, "2d9b00b7");
  const isoLater = row("iso", "failed", { startedAt: new Date(1794708148625 + 1000).toISOString() });
  assert.equal(pick(t, [isoLater, ...listedNow])?.id, "iso", "a number and a date string compare as instants");
  // two live, the older listed first: only reading the numbers picks the later one
  const liveEarlier = { id: "3e1f0c42", cwd: "/w", kind: "background", startedAt: 1794674031535, sessionId: "s3", name: "bea", state: "running" } as Session;
  const liveLater = { id: "4f2a1d53", cwd: "/w", kind: "background", startedAt: 1794708148625, sessionId: "s4", name: "bea", state: "running" } as Session;
  assert.equal(pick(t, [liveEarlier, liveLater])?.id, "4f2a1d53", "the later live start, though listed second");
  // findSession goes by the same rule and never returns an interactive session
  const ft = { ...t, sessions: () => [row("i", "running", { kind: "interactive", updatedAt: "2026-11-13T12:00:00Z" }), old, recent] } as Transport;
  assert.equal(findSession(ft, "bea")?.id, "new");
});

test("the daemon is down, and no session alive, when its supervisor is gone, unnamed, or has no control socket", () => {
  const was = { cfg: process.env.CLAUDE_CONFIG_DIR, socks: process.env.SF_CC_DAEMON_DIR };
  const d = tempDir();
  const cfg = join(d, "config"), socks = join(d, "sockets");
  const row = { kind: "background", state: "done", name: "bea", pid: process.pid } as Session;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.SF_CC_DAEMON_DIR = socks;
  try {
    assert.equal(daemonAlive(), false, "no roster");
    fakeDaemon(cfg);
    assert.equal(daemonAlive(), false, "no socket dir");
    mkdirSync(join(socks, "d1"), { recursive: true });
    assert.equal(daemonAlive(), false, "a socket dir with no control.sock");
    writeFileSync(join(socks, "d1", "control.sock"), "");
    assert.equal(daemonAlive(), true);
    assert.equal(sessionAlive(row), true);
    const gone = spawnSync("true").pid as number;
    fakeDaemon(cfg, gone);
    assert.equal(daemonAlive(), false, "a supervisor that has exited");
    assert.equal(sessionAlive(row), false, "a done row behind a dead daemon is not alive");
    writeFileSync(join(cfg, "daemon", "roster.json"), JSON.stringify({}));
    assert.equal(daemonAlive(), false, "a roster that names no pid");
  } finally {
    process.env.CLAUDE_CONFIG_DIR = was.cfg;
    process.env.SF_CC_DAEMON_DIR = was.socks;
  }
});

test("a row is alive while its worker's pid exists, through a supervisor restart; one the listing keeps after its worker is gone is not", () => {
  const was = { cfg: process.env.CLAUDE_CONFIG_DIR, socks: process.env.SF_CC_DAEMON_DIR };
  const d = tempDir();
  const cfg = join(d, "config"), socks = join(d, "sockets");
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.SF_CC_DAEMON_DIR = socks;
  const worker = spawn("sleep", ["60"]);
  const sup2 = spawn("sleep", ["60"]);
  try {
    fakeDaemon(cfg);
    mkdirSync(join(socks, "d1"), { recursive: true });
    writeFileSync(join(socks, "d1", "control.sock"), "");
    const gone = spawnSync("true").pid as number;
    const live = worker.pid as number;
    const row = (id: string, extra: Partial<Session>) => ({ id, name: "bea", kind: "background", startedAt: Date.now(), ...extra }) as Session;
    assert.equal(sessionAlive(row("a1", { state: "done" })), false, "no pid, done: a worker the daemon retired");
    assert.equal(sessionAlive(row("a2", { state: "blocked" })), false, "no pid, blocked: a worker gone at a reboot");
    assert.equal(sessionAlive(row("a3", { state: "done", status: "idle", pid: live })), true, "a pid, done and idle: it wakes on a message");
    assert.equal(sessionAlive(row("a4", { state: "working", status: "busy", pid: live })), true, "a pid, working");
    assert.equal(sessionAlive(row("a5", { state: "done", pid: gone })), false, "a pid whose process has exited");
    assert.equal(sessionAlive(row("a6", { state: "done", pid: 0 })), false, "a pid that is not one");
    assert.equal(sessionAlive(row("a7", { state: "done", pid: 1 })), true, "a pid run by another user (EPERM) exists");
    // the supervisor restarts, and the worker, started before the new one, keeps running
    const old = row("a8", { state: "done", pid: live, startedAt: Date.now() - 3_600_000 });
    fakeDaemon(cfg, sup2.pid as number);
    assert.equal(daemonAlive(), true);
    assert.equal(sessionAlive(old), true, "a session started before the supervisor restarted, still running");
    assert.equal(sessionAlive(row("a9", { state: "done", startedAt: Date.now() - 3_600_000 })), false, "and its pid-less neighbour is still dead");
  } finally {
    worker.kill();
    sup2.kill();
    process.env.CLAUDE_CONFIG_DIR = was.cfg;
    process.env.SF_CC_DAEMON_DIR = was.socks;
  }
});
