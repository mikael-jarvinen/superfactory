import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentOrDie, findSession, type Session } from "../src/fleet.js";
import { claudeScoped, SCOPE } from "../src/scope.js";
import { agentSessions, local, pick, type Transport } from "../src/transport.js";
import { runClaude } from "../src/watchers/job.js";
import { openWorkspace } from "../src/workspace.js";
import { tempDir, tempWorkspace } from "./helpers.js";

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
  const req = { agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, env: process.env };
  const args = (p: string | null) => ["--bg", ...(p ? ["--append-system-prompt-file", p] : []), "P"];

  assert.equal(local.start({ ...req, appendix: "the brief\n", args }), "abc123");
  assert.equal(readFileSync(join(dir, "appendix"), "utf8"), "the brief\n");
  rmSync(readFileSync(join(dir, "args"), "utf8").split(" ")[2] as string);
  rmSync(join(dir, "appendix"));
  local.start({ ...req, appendix: null, args });
  assert.equal(readFileSync(join(dir, "args"), "utf8"), "--bg P\n");
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
  assert.equal(local.start({ agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, appendix: null, env: process.env, args: () => ["--bg", "P"] }), "abc123");
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
    assert.throws(() => local.start({ agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, appendix: null, env: process.env, args: () => ["--bg", "P"] }), /systemd-run made no scope for claude --bg/);
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
  // findSession goes by the same rule and never returns an interactive session
  const ft = { ...t, sessions: () => [row("i", "running", { kind: "interactive", updatedAt: "2026-11-13T12:00:00Z" }), old, recent] } as Transport;
  assert.equal(findSession(ft, "bea")?.id, "new");
});
