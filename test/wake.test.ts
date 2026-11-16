import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { defaultLogsDir } from "../src/config.js";
import { wakeHookLog } from "../src/failures.js";
import { agentOrDie } from "../src/fleet.js";
import { settingsFile } from "../src/launch.js";
import { recipient } from "../src/hooks/wake.js";
import { ListingTimedOut, Unreachable } from "../src/remote.js";
import { type Transport, transportFor } from "../src/transport.js";
import { wake } from "../src/wake.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, fakeDaemon, TOML, tempWorkspace } from "./helpers.js";

const ASSISTANT_TOML = TOML.replace("[tracker]", `[roles.assistant]
cwd = "assistants"
model = "opus"
permission_mode = "auto"
settings = "readonly"

[[agents]]
name = "vega"
role = "assistant"

[tracker]`);

// rae on host far, which nothing answers.
const HOSTED_TOML = TOML.replace(`name = "rae"
role = "reviewer"`, `name = "rae"
role = "reviewer"
host = "far"
cwd = "/far/rae"`) + `
[hosts.far]
url = "http://127.0.0.1:9"
token_file = "token"
hash_files = ["daemon.toml", "workspace.toml"]
`;

// A claude whose listings come from files: live.json for `agents --json`, all.json for --all. A
// respawn of an id in respawnable copies after.json over live.json, as the session coming back; a
// start logs itself. Every call is a line in calls.
function fakeFleet(toml = TOML) {
  const ws = tempWorkspace(toml);
  after(() => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(join(ws, "bin", "claude"), `#!/bin/sh
D=${ws}
echo "$*" >> $D/calls
case "$1" in
  agents) [ -f $D/listing-hang ] && sleep 60
    if [ "$3" = --all ]; then cat $D/all.json 2>/dev/null || echo '[]'; else cat $D/live.json 2>/dev/null || echo '[]'; fi ;;
  respawn) [ -f $D/respawn-hang ] && sleep 30
    [ -f $D/respawn-fail ] && { cat $D/respawn-fail >&2; exit 1; }
    [ -f $D/after.json ] && cp $D/after.json $D/live.json
    [ -f $D/hang-after-respawn ] && touch $D/listing-hang; echo "respawned $2" ;;
  --bg) n=; prev=; for a in "$@"; do [ "$prev" = --name ] && n=$a; prev=$a; done
    printf '[{"id":"new1","name":"%s","kind":"background","state":"idle","pid":${process.pid}}]' "$n" > $D/live.json
    echo "backgrounded · new1 · $n" ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(ws, "token"), "t".repeat(40));
  const put = (f: string, rows: unknown[]) => writeFileSync(join(ws, f), JSON.stringify(rows));
  const calls = () => (existsSync(join(ws, "calls")) ? readFileSync(join(ws, "calls"), "utf8").trim().split("\n") : []);
  return { ws, put, calls };
}

// A row as the listing has it for a session with a worker: a pid that exists, this process's.
const sess = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, kind: "background", state: "done", status: "idle", pid: process.pid, ...extra });
const hookIn = (to: string) => JSON.stringify({ tool_name: "SendMessage", tool_input: { to, message: "hi" } });
const wakeHook = (ws: string, to: string, extra: string[] = []) =>
  factory(undefined, ["--workspace", ws, "hook", "wake", ...extra], { env: { CLAUDE_BIN: join(ws, "bin", "claude") }, input: hookIn(to) });

test("the recipient is the name without the listing's [ref]", () => {
  assert.equal(recipient("bea"), "bea");
  assert.equal(recipient("bea [3fa9c1]"), "bea");
  assert.equal(recipient("  "), null);
  assert.equal(recipient(undefined), null);
});

test("the wake hook respawns the newest session of an agent that is off, then lets the send through", () => {
  const { ws, put, calls } = fakeFleet();
  put("all.json", [sess("old1", "bea", { startedAt: 1000 }), sess("new2", "bea", { startedAt: 2000 }), sess("x9", "cal", { startedAt: 3000 })]);
  put("after.json", [sess("new2", "bea", { startedAt: 2000 })]);
  const r = wakeHook(ws, "bea [aa11]");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn new2"]);
});

test("the wake hook leaves a live recipient, and anyone not in the fleet, alone", () => {
  const { ws, put, calls } = fakeFleet();
  put("live.json", [sess("b1", "bea")]);
  put("all.json", [sess("b1", "bea"), sess("o1", "otto")]);
  assert.equal(wakeHook(ws, "bea").status, 0);
  assert.equal(wakeHook(ws, "otto").status, 0);
  assert.equal(wakeHook(ws, "main").status, 0);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), []);
  assert.ok(!calls().some((c) => c.includes("--all")), "a live recipient costs one listing, not the stopped ones too");
});

test("the wake hook blocks the send, saying why, when the recipient does not come back", () => {
  const { ws, put } = fakeFleet();
  let r = wakeHook(ws, "bea");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bea is off and has no session to wake/);

  put("all.json", [sess("b1", "bea")]);
  writeFileSync(join(ws, "respawn-fail"), "no such session");
  r = wakeHook(ws, "bea");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bea is off and did not wake: respawn of b1 failed: no such session/);

  rmSync(join(ws, "respawn-fail"));
  r = wakeHook(ws, "bea", ["--wait-seconds", "1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bea is off and did not wake: respawned b1, and it was not listed live within 1 s/);
});

test("the wake hook lets the send through when the workspace does not load or the event is not JSON, and says so", () => {
  const { ws } = fakeFleet();
  const told = (r: { stdout: string }) => (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  let r = factory(undefined, ["--workspace", join(ws, "nowhere"), "hook", "wake"], { input: hookIn("bea") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(told(r), /^wake check failed: --workspace \S+nowhere: no such directory; message sent without a wake check$/);
  assert.match(r.stderr, /no workspace found, so not logged/);
  r = factory(undefined, ["--workspace", ws, "hook", "wake"], { input: "not json" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /the hook's input is not JSON .*; message sent without a wake check/);
  // a factory.toml that does not load: logged in the workspace's default logs/
  writeFileSync(join(ws, "factory.toml"), "[[agents]\n");
  r = factory(undefined, ["--workspace", ws, "hook", "wake"], { input: hookIn("bea") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(told(r), /^wake check failed: \S+factory\.toml has 1 problem:[\s\S]*not valid TOML[\s\S]*; message sent without a wake check$/);
  assert.match(r.stderr, /\n\s+at /, "with the stack");
  const lines = readFileSync(wakeHookLog(defaultLogsDir(ws)), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]!) as Record<string, string>;
  assert.equal(row.to, "bea");
  assert.equal(`wake check failed: ${row.error}; message sent without a wake check`, told(r));
});

test("a listing that is JSON but no list is a listing that failed, for every caller, not a crash", () => {
  const { ws } = fakeFleet();
  writeFileSync(join(ws, "live.json"), "{}");
  const r = factory(ws, ["wake", "bea"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /`claude agents --json` returned something that is not a JSON list/);
  assert.doesNotMatch(r.stderr, /TypeError|\n\s+at /);
});

test("factory wake: already live, woken, or not", () => {
  const { ws, put } = fakeFleet();
  put("all.json", [sess("b1", "bea")]);
  put("after.json", [sess("b1", "bea")]);
  let r = factory(ws, ["wake", "bea"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea woke: b1 respawned, live as b1, same conversation/);
  r = factory(ws, ["wake", "bea"]);
  assert.match(r.stdout, /bea is already live \(b1\)/);
  r = factory(ws, ["wake", "cal"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cal has no session to wake/);
});

test("every role's settings wake the recipient before SendMessage, inside the hook's timeout", () => {
  const dir = tempWorkspace(ASSISTANT_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  for (const name of ["ada", "bea", "rae", "vega"]) {
    const s = JSON.parse(readFileSync(settingsFile(ws, agentOrDie(ws, name)), "utf8"));
    const wakes = (s.hooks.PreToolUse as { matcher?: string; hooks: { command: string; timeout: number }[] }[]).filter((h) => h.matcher === "SendMessage");
    assert.equal(wakes.length, 1, name);
    assert.match(wakes[0]!.hooks[0]!.command, / --workspace \S+ hook wake$/, name);
    assert.equal(wakes[0]!.hooks[0]!.timeout, 90, name);
  }
});

test("a fix round on an item whose session was stopped idle wakes that session instead of starting one", () => {
  const { ws, put, calls } = fakeFleet();
  for (const args of [["queued", "--stack", "app"], ["building", "--agent", "bea"], ["pr-open", "--pr", "acme/web#1", "--head", "abc1234abc1234"],
    ["agent-review", "--evidence", "reviewer briefed"], ["fixing", "--evidence", "2 high"]]) {
    const st = factory(ws, ["state", "TEST-3", ...args]);
    assert.equal(st.status, 0, st.stderr);
  }
  const off = sess("b7", "bea", { cwd: join(ws, "repos", "web", ".claude", "worktrees", "TEST-3") });
  put("all.json", [off]);
  put("after.json", [off]);
  const r = factory(ws, ["dispatch", "bea", "TEST-3"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea was off; woke b7 \(its conversation kept\)/);
  assert.match(r.stdout, /bea is still on TEST-3 \(b7\), so it keeps its context/);
  assert.ok(!calls().some((c) => c.startsWith("--bg")), "no new session");
});

test("a stopped session on another item is not woken for a dispatch, nor any with --force", () => {
  const { ws, put, calls } = fakeFleet();
  put("all.json", [sess("b7", "bea", { cwd: join(ws, "repos", "web", ".claude", "worktrees", "TEST-2") })]);
  factory(ws, ["dispatch", "bea", "TEST-3"]);
  put("all.json", [sess("b8", "bea", { cwd: join(ws, "repos", "web", ".claude", "worktrees", "TEST-3") })]);
  factory(ws, ["dispatch", "bea", "TEST-3", "--force"]);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), []);
});

test("a named assistant that is off is woken on its conversation; --force starts it fresh", () => {
  const { ws, put, calls } = fakeFleet(ASSISTANT_TOML);
  mkdirSync(join(ws, "assistants"));
  put("all.json", [sess("v1", "vega")]);
  put("after.json", [sess("v1", "vega")]);
  let r = factory(ws, ["assistant", "vega"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /vega was off; woke v1 \(its conversation kept\)\n  next: send it the task by message/);
  assert.ok(!calls().some((c) => c.startsWith("--bg")));
  rmSync(join(ws, "live.json"));
  r = factory(ws, ["assistant", "vega", "--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn v1"]);
  assert.ok(calls().some((c) => c.startsWith("--bg")), "--force starts a fresh one");
});

test("the session a wake respawns is the one last active by its transcript, not the one started last", () => {
  const { ws, put, calls } = fakeFleet();
  const cfg = join(ws, "claude-config");
  fakeDaemon(cfg);
  const proj = join(cfg, "projects", "-w-bea-dir");
  mkdirSync(proj, { recursive: true });
  const row = (id: string, startedAt: number) => sess(id, "bea", { startedAt, cwd: "/w/bea.dir", sessionId: `${id}-uuid` });
  writeFileSync(join(proj, "old1-uuid.jsonl"), "{}\n");
  writeFileSync(join(proj, "new2-uuid.jsonl"), "{}\n");
  utimesSync(join(proj, "new2-uuid.jsonl"), 2000, 2000);
  utimesSync(join(proj, "old1-uuid.jsonl"), 5000, 5000);
  put("all.json", [row("old1", 1000), row("new2", 2000)]);
  put("after.json", [row("old1", 1000)]);
  let r = factory(ws, ["wake", "bea"], { env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn old1"], "old1 started first but talked last");
  // With no transcript to go by, the one started last.
  rmSync(join(ws, "live.json"));
  rmSync(proj, { recursive: true });
  put("after.json", [row("new2", 2000)]);
  r = factory(ws, ["wake", "bea"], { env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn old1", "respawn new2"]);
});

test("a named assistant that does not wake is not started fresh; --force starts it fresh", () => {
  const { ws, put, calls } = fakeFleet(ASSISTANT_TOML);
  mkdirSync(join(ws, "assistants"));
  put("all.json", [sess("v1", "vega")]);
  writeFileSync(join(ws, "respawn-fail"), "session v1 is gone");
  let r = factory(ws, ["assistant", "vega"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /vega was off and did not wake: respawn of v1 failed: session v1 is gone\. Nothing was started/);
  assert.ok(!calls().some((c) => c.startsWith("--bg")), "no fresh session without --force");
  r = factory(ws, ["assistant", "vega", "--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(calls().some((c) => c.startsWith("--bg")), "--force starts a fresh one");
});

test("a session on a host wakes only agents on its own host, and lets a message to any other through", () => {
  const { ws, put, calls } = fakeFleet(HOSTED_TOML);
  // the lead and bea are on the primary, which a host cannot list: nothing is asked, the send goes
  for (const to of ["ada", "bea"]) {
    const r = wakeHook(ws, to, ["--from-host", "far"]);
    assert.equal(r.status, 0, `${to}: ${r.stderr}`);
  }
  assert.deepEqual(calls(), []);
  // rae is on far too, so far's own claude wakes it, with no settle
  put("all.json", [sess("r1", "rae")]);
  put("after.json", [sess("r1", "rae")]);
  const t0 = Date.now();
  const r = wakeHook(ws, "rae", ["--from-host", "far"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn r1"]);
  assert.ok(Date.now() - t0 < 10_000, "no settle for a wake on the sender's own machine");
});

test("the wake hook answers inside its timeout: a respawn that hangs, or a session that never lists live, blocks in time", () => {
  const { ws, put } = fakeFleet();
  put("all.json", [sess("b1", "bea")]);
  writeFileSync(join(ws, "respawn-hang"), "");
  let t0 = Date.now();
  let r = wakeHook(ws, "bea", ["--timeout-seconds", "32"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bea is off and did not wake/);
  assert.ok(Date.now() - t0 < 32_000, `the hung respawn took ${Date.now() - t0} ms`);

  rmSync(join(ws, "respawn-hang"));
  t0 = Date.now();
  r = wakeHook(ws, "bea", ["--timeout-seconds", "32"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /respawned b1, and it was not listed live in the time the hook has/);
  assert.ok(Date.now() - t0 < 32_000, `the wait took ${Date.now() - t0} ms`);
});

test("a hosted agent's settings tell the wake hook its host", () => {
  const dir = tempWorkspace(HOSTED_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "t".repeat(40));
  const ws = openWorkspace(dir, {});
  const wakeCmd = (name: string) => {
    const s = JSON.parse(readFileSync(settingsFile(ws, agentOrDie(ws, name)), "utf8"));
    return (s.hooks.PreToolUse as { matcher?: string; hooks: { command: string }[] }[]).find((h) => h.matcher === "SendMessage")!.hooks[0]!.command;
  };
  assert.match(wakeCmd("rae"), / hook wake --from-host far$/);
  assert.match(wakeCmd("bea"), / hook wake$/);
});

test("a local listing that hangs is cut off and the send let through, as for a host that cannot be listed", () => {
  const { ws, calls } = fakeFleet();
  writeFileSync(join(ws, "listing-hang"), "");
  const t0 = Date.now();
  const r = wakeHook(ws, "bea");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!calls().some((c) => c.startsWith("respawn")), "nothing is woken on a guess");
  assert.ok(Date.now() - t0 < 30_000, `the hung listing took ${Date.now() - t0} ms`);
});

test("a listing that hangs after the respawn leaves the recipient unknown, and the send is let through", () => {
  const { ws, put, calls } = fakeFleet();
  put("all.json", [sess("b1", "bea")]);
  put("after.json", [sess("b1", "bea")]);
  writeFileSync(join(ws, "hang-after-respawn"), "");
  const r = wakeHook(ws, "bea", ["--wait-seconds", "1", "--settle-seconds", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn b1"]);
});

test("a remote respawn left too little time fails rather than run past it", () => {
  const dir = tempWorkspace(HOSTED_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "t".repeat(40));
  const ws = openWorkspace(dir, {});
  const t = transportFor(ws, agentOrDie(ws, "rae"));
  const t0 = Date.now();
  const r = t.respawn("rae", "r1", 5_500);
  assert.equal(r.ok, false);
  assert.match(r.why, /5500 ms is too little for a respawn on far/);
  assert.ok(Date.now() - t0 < 1_000, "nothing was asked");
});

test("the hook's own error lets the send through, logged and told to the sender", () => {
  const { ws, put } = fakeFleet();
  // a listing that is JSON but no list: the listing fails
  writeFileSync(join(ws, "live.json"), "{}");
  put("all.json", [sess("b1", "bea")]);
  const r = factory(undefined, ["--workspace", ws, "hook", "wake"], {
    env: { CLAUDE_BIN: join(ws, "bin", "claude") },
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-123", cwd: "/w/ada", tool_name: "SendMessage", tool_input: { to: "bea", message: "hi" } }),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.additionalContext, "wake check failed: `claude agents --json` returned something that is not a JSON list; message sent without a wake check");
  assert.match(r.stderr, /\n\s+at /, "with the stack");
  const lines = readFileSync(wakeHookLog(openWorkspace(ws, {}).logsDir), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]!) as Record<string, string>;
  assert.equal(row.from, "session s-123 in /w/ada");
  assert.equal(row.to, "bea");
  assert.match(row.error!, /not a JSON list/);
  assert.match(row.stack!, /not a JSON list[\s\S]*\n\s+at /);
  assert.ok(!Number.isNaN(Date.parse(row.at!)));
});

test("a local listing that timed out says so, not that a host is unknown", () => {
  const u = new ListingTimedOut("`claude agents --json` did not answer in 20 s");
  assert.ok(u instanceof Unreachable);
  assert.equal(u.message, "the local listing timed out: `claude agents --json` did not answer in 20 s");
  assert.equal(u.brief, u.message);
  assert.equal(new Unreachable("far", "ECONNREFUSED").message, "host far is unknown: ECONNREFUSED");
});

test("a respawn leaves room for one listing after it", () => {
  const dir = tempWorkspace(HOSTED_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "t".repeat(40));
  const ws = openWorkspace(dir, {});
  let given: number | undefined;
  const far = {
    where: "far",
    sessions: (all = false) => (all ? [sess("r1", "rae")] : []),
    alive: (s: unknown) => !!s && (s as { alive?: unknown }).alive === true,
    respawn: (_n: string, _id: string, ms?: number) => ((given = ms), { ok: false, said: "", why: "stop here" }),
  } as unknown as Transport;
  wake(ws, agentOrDie(ws, "rae"), { t: far, deadline: Date.now() + 60_000 });
  assert.ok(given !== undefined && given <= 40_000 && given > 39_000, `respawn given ${given} ms of 60 000: 20 000 for a listing comes off`);
});

test("a listing that breaks, rather than cannot be had, is thrown on and not taken for unknown", () => {
  const dir = tempWorkspace(HOSTED_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "t".repeat(40));
  const ws = openWorkspace(dir, {});
  const broken = { where: "far", sessions: () => { throw new TypeError("a malformed row"); }, alive: () => false } as unknown as Transport;
  assert.throws(() => wake(ws, agentOrDie(ws, "rae"), { t: broken }), /a malformed row/);
  const away = { where: "far", sessions: () => { throw new Unreachable("far", "ECONNREFUSED"); }, alive: () => false } as unknown as Transport;
  assert.deepEqual(wake(ws, agentOrDie(ws, "rae"), { t: away }), { is: "unknown", why: "host far: ECONNREFUSED" });
});

// What a failed SendMessage hands a PostToolUse hook, recorded from a real one.
const FAILED_SEND = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/fixtures/sendmessage-failed.json", import.meta.url)), "utf8")) as {
  hook_event_name: string; tool_input: Record<string, unknown>; tool_response: Record<string, unknown>;
};

test("from a host, a failed send to an agent it cannot wake says it is off and to tell the lead", () => {
  const { ws } = fakeFleet(HOSTED_TOML);
  const run = (ev: Record<string, unknown>) =>
    factory(undefined, ["--workspace", ws, "hook", "wake", "--from-host", "far"], { env: { CLAUDE_BIN: join(ws, "bin", "claude") }, input: JSON.stringify(ev) });
  const failed = (to: string) => ({ ...FAILED_SEND, tool_input: { ...FAILED_SEND.tool_input, to } });
  assert.equal(FAILED_SEND.hook_event_name, "PostToolUse");
  const r = run(failed("bea"));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bea runs on the primary, not on far, and was not reachable: it is most likely off/);
  assert.match(r.stderr, /Tell ada that bea is off/);
  assert.equal(run({ ...failed("bea"), tool_response: { success: true, message: "sent" } }).status, 0, "a send that went through");
  assert.equal(run(failed("ada")).status, 0, "the lead: nobody else can wake it");
  assert.equal(run(failed("rae")).status, 0, "an agent on far, which the PreToolUse half already tried");
  // should a failed send come as a tool error instead
  const err = run({ hook_event_name: "PostToolUseFailure", tool_name: "SendMessage", tool_input: { to: "bea", message: "hi" }, error: "No agent named 'bea' is reachable." });
  assert.equal(err.status, 2);
  assert.match(err.stderr, /Tell ada that bea is off/);
  // Any other failed send passes as it is: a name two sessions share (as Claude Code answered it),
  // or a send interrupted or refused for its input.
  const twoNamed = { ...failed("bea"), tool_response: { success: false, message: "2 agents are named 'bea'. Re-send with the ref of the one you mean: bea [aa11], bea [bb22]" } };
  assert.equal(run(twoNamed).status, 0, "two sessions named bea");
  assert.equal(run({ hook_event_name: "PostToolUseFailure", tool_name: "SendMessage", tool_input: { to: "bea", message: "hi" }, error: "Interrupted by user", is_interrupt: true }).status, 0, "interrupted");
  assert.equal(run({ hook_event_name: "PostToolUseFailure", tool_name: "SendMessage", tool_input: { to: "bea" } }).status, 0, "no error said");
});

test("from a host, a failed send whose workspace does not load is answered as the event it is", () => {
  const { ws } = fakeFleet(HOSTED_TOML);
  writeFileSync(join(ws, "factory.toml"), "[[agents]\n");
  const run = (ev: Record<string, unknown>) =>
    factory(undefined, ["--workspace", ws, "hook", "wake", "--from-host", "far"], { env: { CLAUDE_BIN: join(ws, "bin", "claude") }, input: JSON.stringify(ev) });
  const answered = (r: { stdout: string }) => (JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
  let r = run({ ...FAILED_SEND, tool_input: { ...FAILED_SEND.tool_input, to: "bea" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(answered(r).hookEventName, "PostToolUse");
  assert.match(answered(r).additionalContext, /^wake check failed: [\s\S]*not valid TOML[\s\S]*; the failed send to bea is not explained$/);
  r = run({ hook_event_name: "PostToolUseFailure", tool_name: "SendMessage", tool_input: { to: "bea", message: "hi" }, error: "No agent named 'bea' is reachable." });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(answered(r).hookEventName, "PostToolUseFailure");
  assert.equal(readFileSync(wakeHookLog(defaultLogsDir(ws)), "utf8").trim().split("\n").length, 2);
  r = run({ ...FAILED_SEND, hook_event_name: "PreToolUse", tool_input: { ...FAILED_SEND.tool_input, to: "bea" } });
  assert.equal(answered(r).hookEventName, "PreToolUse");
});

test("only a hosted agent's settings explain a failed send", () => {
  const dir = tempWorkspace(HOSTED_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "t".repeat(40));
  const ws = openWorkspace(dir, {});
  for (const ev of ["PostToolUse", "PostToolUseFailure"]) {
    const post = (name: string) =>
      ((JSON.parse(readFileSync(settingsFile(ws, agentOrDie(ws, name)), "utf8")).hooks[ev] ?? []) as { matcher?: string; hooks: { command: string }[] }[])
        .filter((h) => h.matcher === "SendMessage").map((h) => h.hooks[0]!.command);
    assert.equal(post("rae").length, 1, ev);
    assert.match(post("rae")[0]!, / hook wake --from-host far$/, ev);
    assert.deepEqual(post("bea"), [], ev);
  }
});
