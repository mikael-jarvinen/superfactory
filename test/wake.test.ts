import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { defaultLogsDir } from "../src/config.js";
import { wakeHookLog } from "../src/failures.js";
import { agentOrDie } from "../src/fleet.js";
import { settingsFile, startLock } from "../src/launch.js";
import { tryLock } from "../src/tickets/lock.js";
import { recipient } from "../src/hooks/wake.js";
import { ListingTimedOut, Unreachable } from "../src/remote.js";
import type { StartRequest, Transport } from "../src/transport.js";
import * as T from "../src/tickets/store.js";
import { trackerTitle } from "../src/tracker/title.js";
import { wake } from "../src/wake.js";
import { queueStateFile } from "../src/watchers/queue.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

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
// start (--bg) lists its agent live as new<n>, n counting the starts, unless bg-unlisted exists;
// bg-fail makes it fail with that file's text, bg-hang makes it hang. A stop takes live.json away.
// Every call is a line in calls.
function fakeFleet(toml = TOML) {
  const ws = tempWorkspace(toml);
  after(() => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(join(ws, "bin", "claude"), `#!/bin/sh
D=${ws}
echo "$*" >> $D/calls
case "$1" in
  agents) [ -f $D/listing-hang ] && sleep 60
    if [ "$3" = --all ]; then cat $D/all.json 2>/dev/null || echo '[]'; else cat $D/live.json 2>/dev/null || echo '[]'; fi ;;
  --bg) [ -f $D/bg-hang ] && exec sleep 60
    [ -f $D/bg-fail ] && { cat $D/bg-fail >&2; exit 1; }
    n=; prev=; for a in "$@"; do [ "$prev" = --name ] && n=$a; prev=$a; done
    echo x >> $D/starts; id=new$(wc -l < $D/starts | tr -d ' ')
    [ -f $D/bg-unlisted ] || printf '[{"id":"%s","name":"%s","kind":"background","state":"idle","pid":${process.pid},"cwd":"%s"}]' "$id" "$n" "$PWD" > $D/live.json
    [ -f $D/hang-after-bg ] && touch $D/listing-hang
    echo "backgrounded · $id · $n" ;;
  stop) grep -qs "\"$2\"" $D/live.json && rm -f $D/live.json ;;
  rm) ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(ws, "token"), "t".repeat(40));
  for (const d of ["lead", "reviewers", "assistants"]) mkdirSync(join(ws, d));
  const put = (f: string, rows: unknown[]) => writeFileSync(join(ws, f), JSON.stringify(rows));
  const calls = () => (existsSync(join(ws, "calls")) ? readFileSync(join(ws, "calls"), "utf8").trim().split("\n") : []);
  const starts = () => calls().filter((c) => c.startsWith("--bg"));
  return { ws, put, calls, starts };
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

test("the wake hook starts a reviewer that is off as a fresh session, then lets the send through", () => {
  const { ws, put, calls, starts } = fakeFleet();
  // an old conversation is listed, ended: it is never resumed
  put("all.json", [sess("old1", "rae", { state: "stopped", pid: null })]);
  const r = wakeHook(ws, "rae [aa11]");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(starts().length, 1);
  assert.match(starts()[0]!, /--name rae --model opus --effort high .*You are one of Ada's reviewers\. Read CLAUDE\.md, reply exactly READY/);
  assert.ok(!calls().some((c) => /^(respawn|stop|rm) /.test(c)), "nothing done to the old row in the hook's time");
});
test("the wake hook leaves a live recipient, and anyone not in the fleet, alone", () => {
  const { ws, put, calls } = fakeFleet();
  put("live.json", [sess("b1", "bea")]);
  put("all.json", [sess("b1", "bea"), sess("o1", "otto")]);
  assert.equal(wakeHook(ws, "bea").status, 0);
  assert.equal(wakeHook(ws, "otto").status, 0);
  assert.equal(wakeHook(ws, "main").status, 0);
  assert.deepEqual(calls().filter((c) => c.startsWith("--bg")), []);
  assert.ok(!calls().some((c) => c.includes("--all")), "a live recipient costs one listing, not the stopped ones too");
});

test("the wake hook blocks the send, saying why, when the recipient does not start", () => {
  const { ws, starts } = fakeFleet();
  // a builder starts fresh on its item, by the lead's dispatch
  let r = wakeHook(ws, "bea");
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "bea is off: a builder starts fresh on its item: `factory dispatch bea <KEY>`. Tell the lead, who starts it with `factory dispatch bea <KEY>`; then send.\n");
  assert.deepEqual(starts(), [], "wake starts no builder");

  writeFileSync(join(ws, "bg-fail"), "no such model");
  r = wakeHook(ws, "rae");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^rae is off and did not start: claude --bg failed: no such model\. Try `factory wake rae`, or tell the lead\.\n$/);

  rmSync(join(ws, "bg-fail"));
  writeFileSync(join(ws, "bg-unlisted"), "");
  r = wakeHook(ws, "rae", ["--wait-seconds", "1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /rae is off and did not start: rae did not appear in `claude agents` within 1s \(launch id new1\)\. Check `claude logs new1`\. Try/);
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

test("factory wake: already live, started fresh, or not", () => {
  const { ws, put, starts } = fakeFleet(ASSISTANT_TOML);
  put("all.json", [sess("r0", "rae", { state: "stopped", pid: null })]);
  let r = factory(ws, ["wake", "rae"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "rae was off; started a fresh session (new1)\n");
  r = factory(ws, ["wake", "rae"]);
  assert.match(r.stdout, /rae is already live \(new1\)/);
  assert.equal(starts().length, 1);
  // each role that wake starts: its role's first prompt and the model and effort the config gives now
  const lines: Record<string, RegExp> = {
    ada: /--name ada --model opus --effort high --autocompact 1M --permission-mode bypassPermissions .*factory status/,
    vega: /--name vega --model opus --permission-mode auto You are one of Ada's assistants\. Read CLAUDE\.md, reply exactly READY, and wait for a task from Ada\.$/,
  };
  for (const [name, line] of Object.entries(lines)) {
    rmSync(join(ws, "live.json"));
    r = factory(ws, ["wake", name]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${name} was off; started a fresh session \\(new\\d\\)\\n$`));
    assert.match(starts().at(-1)!, line, name);
  }
  rmSync(join(ws, "live.json"));
  for (const name of ["bea", "cal"]) {
    r = factory(ws, ["wake", name]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), `${name} did not wake: a builder starts fresh on its item: \`factory dispatch ${name} <KEY>\``);
  }
  assert.equal(starts().length, 3);
});
test("a started session has its settings rendered again", () => {
  const { ws } = fakeFleet();
  const file = settingsFile(openWorkspace(ws, {}), agentOrDie(openWorkspace(ws, {}), "rae"));
  writeFileSync(file, "{}\n");
  const r = factory(ws, ["wake", "rae"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).hooks?.PreToolUse?.length, "the stale file was rendered again");
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

test("factory assistant <name> starts an assistant that is off fresh, and leaves a live one alone", () => {
  const { ws, put, calls, starts } = fakeFleet(ASSISTANT_TOML);
  put("all.json", [sess("v1", "vega", { state: "stopped", pid: null })]);
  let r = factory(ws, ["assistant", "vega"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "vega started (new1)\n");
  assert.equal(starts().length, 1);
  assert.match(starts()[0]!, /--name vega --model opus --permission-mode auto You are one of Ada's assistants/);
  // the ended row goes once the fresh one is up
  assert.ok(calls().includes("stop v1") && calls().includes("rm v1"), calls().join("\n"));
  put("live.json", [sess("new1", "vega")]);
  r = factory(ws, ["assistant", "vega"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /vega is already running \(new1\); send it the task by message/);
  assert.equal(starts().length, 1);
});
test("a session on a host wakes only agents on its own host, and lets a message to any other through", () => {
  const { ws, put, calls } = fakeFleet(HOSTED_TOML);
  // the lead and bea are on the primary, which a host cannot list: nothing is asked, the send goes
  for (const to of ["ada", "bea"]) {
    const r = wakeHook(ws, to, ["--from-host", "far"]);
    assert.equal(r.status, 0, `${to}: ${r.stderr}`);
  }
  assert.deepEqual(calls(), []);
  // rae is on far too, so far's own claude starts it, with no settle, in its cwd there
  writeFileSync(join(ws, "factory.toml"), HOSTED_TOML.replace('cwd = "/far/rae"', `cwd = "${join(ws, "reviewers")}"`));
  const t0 = Date.now();
  const r = wakeHook(ws, "rae", ["--from-host", "far"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls().filter((c) => c.startsWith("--bg") && c.includes("--name rae")).length, 1);
  assert.ok(Date.now() - t0 < 10_000, "no settle for a wake on the sender's own machine");
});

test("the wake hook answers inside its timeout: a start that hangs, or a session that never lists live, blocks in time", () => {
  const { ws } = fakeFleet();
  writeFileSync(join(ws, "bg-hang"), "");
  let t0 = Date.now();
  let r = wakeHook(ws, "rae", ["--timeout-seconds", "50"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /rae is off and did not start: claude --bg did not finish in the \d+ s it had/);
  assert.ok(Date.now() - t0 < 50_000, `the hung start took ${Date.now() - t0} ms`);

  rmSync(join(ws, "bg-hang"));
  writeFileSync(join(ws, "bg-unlisted"), "");
  t0 = Date.now();
  r = wakeHook(ws, "rae", ["--timeout-seconds", "50"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /rae is off and did not start: rae did not appear in `claude agents`/);
  assert.ok(Date.now() - t0 < 50_000, `the wait took ${Date.now() - t0} ms`);
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
  assert.ok(!calls().some((c) => c.startsWith("--bg")), "nothing is started on a guess");
  assert.ok(Date.now() - t0 < 30_000, `the hung listing took ${Date.now() - t0} ms`);
});

test("a listing that hangs after the start leaves the recipient unknown, and the send is let through", () => {
  const { ws, starts } = fakeFleet();
  writeFileSync(join(ws, "hang-after-bg"), "");
  const r = wakeHook(ws, "rae", ["--wait-seconds", "1", "--settle-seconds", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(starts().length, 1);
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

test("a start leaves room for the listings after it, and one left too little time fails rather than run past it", () => {
  const dir = tempWorkspace(HOSTED_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "t".repeat(40));
  const ws = openWorkspace(dir, {});
  mkdirSync(join(dir, "reviewers"));
  const given: (number | undefined)[] = [];
  const far = {
    where: "far",
    sessions: () => [],
    alive: (s: unknown) => !!s && (s as { alive?: unknown }).alive === true,
    start: (req: StartRequest) => (given.push(req.timeoutMs), assert.fail("stop here")),
  } as unknown as Transport;
  assert.throws(() => wake(ws, agentOrDie(ws, "rae"), { t: far, deadline: Date.now() + 60_000 }), /stop here/);
  assert.ok(given.length === 1 && given[0]! <= 20_000 && given[0]! > 19_000, `start given ${given[0]} ms of 60 000: 20 000 for each of two listings comes off`);
  // under a host's child slack and a second, nothing is asked
  const w = wake(ws, agentOrDie(ws, "rae"), { t: far, deadline: Date.now() + 40_000 + 5_500 });
  assert.deepEqual(w, { is: "failed", why: "out of time before starting rae" });
  assert.equal(given.length, 1);
});
// One start of an agent at a time: a wake that finds another start under way waits for it, and
// one whose time runs out first fails, saying so, never starting a second session under the name.
test("a wake waits on the agent's start lock, and fails without starting when it runs out of time", () => {
  const dir = tempWorkspace(HOSTED_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "t".repeat(40));
  const ws = openWorkspace(dir, {});
  mkdirSync(join(dir, "reviewers"));
  let asked = 0;
  const far = { where: "far", sessions: () => (asked++, []), alive: () => false, start: () => assert.fail("no start under another's lock") } as unknown as Transport;
  const fd = tryLock(startLock(ws, "rae"));
  assert.notEqual(fd, null);
  try {
    const w = wake(ws, agentOrDie(ws, "rae"), { t: far, deadline: Date.now() + 1_500 });
    assert.deepEqual(w, { is: "failed", why: "another start of rae is under way; out of time waiting for it" });
    assert.equal(asked, 0, "not even listed while another start holds the lock");
  } finally {
    closeSync(fd!);
  }
});

test("a started session whose settings cannot be rendered fails the wake, saying why", () => {
  const dir = fakeFleet().ws;
  const ws = openWorkspace(dir, {});
  const rae = agentOrDie(ws, "rae");
  (ws.config.roles[rae.role] as { settings: string }).settings = join(dir, "gone.json");
  const w = wake(ws, rae);
  assert.equal(w.is, "failed");
  assert.match((w as { why: string }).why, /^settings for rae: \S+gone\.json does not exist$/);
  assert.ok(!existsSync(join(dir, "starts")), "nothing started");
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

// The fix session a dispatch recorded on an item.
const fixSession = (ws: string, key: string) => (JSON.parse(readFileSync(join(ws, "state", `${key}.json`), "utf8")) as { fix_session: string }).fix_session;

// A checkout of web with one commit and the briefs a builder on the app stack reads.
function webRepo(ws: string) {
  mkdirSync(join(ws, "briefs"), { recursive: true });
  writeFileSync(join(ws, "briefs", "app.md"), "the app stack's brief");
  const web = join(ws, "repos", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "AGENTS.md"), "the repo's brief");
  const origin = join(ws, "web-origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  for (const a of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    ["remote", "add", "origin", origin], ["push", "-q", "origin", "main"]])
    execFileSync("git", ["-C", web, ...a]);
}

test("the first fix round stops the build session and starts a fresh one on the handoff; later rounds keep it", () => {
  const { ws, calls, starts } = fakeFleet();
  webRepo(ws);
  const rec = () => JSON.parse(readFileSync(join(ws, "state", "TEST-50.json"), "utf8")) as { state: string; worktree: string; fix_session?: string };
  let r = factory(ws, ["dispatch", "bea", "TEST-50", "--title", "Fix the export"]);
  assert.equal(r.status, 0, r.stderr);
  const wt = rec().worktree;
  const handoff = `${wt}.handoff.md`;
  assert.match(r.stdout, /bea started \(new1\) for TEST-50 as a BUILDING session/);
  assert.ok(starts()[0]!.includes(`write the handoff for the fix round to ${handoff}`), starts()[0]);
  assert.equal(rec().fix_session, undefined);
  // a re-brief while building goes to the build session
  r = factory(ws, ["dispatch", "bea", "TEST-50"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea is still on TEST-50 \(new1\), so it keeps its context/);
  for (const a of [["pr-open", "--pr", "acme/web#5", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "reviewer briefed"]])
    assert.equal(factory(ws, ["state", "TEST-50", ...a]).status, 0);

  r = factory(ws, ["dispatch", "bea", "TEST-50"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^bea's build session on TEST-50 stopped \(new1\); the fix round starts fresh in the same worktree$/m);
  assert.match(r.stdout, /bea started \(new2\) for TEST-50 as a FIX ROUND session/);
  assert.match(r.stdout, new RegExp(`fix round: it reads the handoff, ${handoff.replace(/[.]/g, "\\.")}`));
  assert.ok(calls().includes("stop new1") && calls().includes("rm new1"), "the build session is stopped and removed");
  assert.equal(starts().length, 2);
  const fix = starts()[1]!;
  assert.match(fix, /--name bea --model opus --effort high .*FIX ROUND, in a fresh session/);
  assert.ok(fix.includes(`the handoff at ${handoff}`), fix);
  assert.deepEqual([rec().state, rec().worktree, rec().fix_session], ["fixing", wt, "new2"], "same worktree, the fix session recorded");

  // the next round goes to the fix session
  assert.equal(factory(ws, ["state", "TEST-50", "agent-review", "--evidence", "round 2 sent"]).status, 0);
  r = factory(ws, ["dispatch", "bea", "TEST-50"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea is still on TEST-50 \(new2\), so it keeps its context/);
  assert.equal(starts().length, 2, "no new session");
  assert.deepEqual([rec().state, rec().fix_session], ["fixing", "new2"]);
  // and the round after, with the item already fixing
  r = factory(ws, ["dispatch", "bea", "TEST-50"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /that is the fix session, which keeps later rounds/);
  assert.equal(starts().length, 2);
});

test("a fix round on an item whose session is off starts a fresh one on the handoff", () => {
  const { ws, starts } = fakeFleet();
  webRepo(ws);
  assert.equal(factory(ws, ["dispatch", "bea", "TEST-51", "--title", "Fix it"]).status, 0);
  rmSync(join(ws, "live.json"));
  for (const a of [["pr-open", "--pr", "acme/web#6", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "briefed"], ["fixing", "--evidence", "2 high"]])
    assert.equal(factory(ws, ["state", "TEST-51", ...a]).status, 0);
  const r = factory(ws, ["dispatch", "bea", "TEST-51"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea started \(new2\) for TEST-51 as a FIX ROUND session/);
  assert.match(starts()[1]!, /FIX ROUND, in a fresh session .*TEST-51\.handoff\.md/);
  assert.equal(fixSession(ws, "TEST-51"), "new2");
});

test("a bare dispatch on an item in review whose session is off starts its fix round; --force does not", () => {
  const { ws, starts } = fakeFleet();
  webRepo(ws);
  const rec = () => JSON.parse(readFileSync(join(ws, "state", "TEST-52.json"), "utf8")) as { state: string; fix_session?: string };
  assert.equal(factory(ws, ["dispatch", "bea", "TEST-52", "--title", "Fix it"]).status, 0);
  rmSync(join(ws, "live.json"));
  for (const a of [["pr-open", "--pr", "acme/web#7", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "briefed"]])
    assert.equal(factory(ws, ["state", "TEST-52", ...a]).status, 0);
  // forced, on a sent PR: a verification or re-brief run, not a fix round
  let r = factory(ws, ["dispatch", "bea", "TEST-52", "--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /as a BUILDING session/);
  assert.doesNotMatch(starts()[1]!, /FIX ROUND/);
  assert.deepEqual([rec().state, rec().fix_session], ["agent-review", undefined], "still in review, no fix session recorded");
  rmSync(join(ws, "live.json"));
  // bare: after a stop it works as it does with the build session live
  r = factory(ws, ["dispatch", "bea", "TEST-52"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea started \(new3\) for TEST-52 as a FIX ROUND session/);
  assert.match(starts()[2]!, /FIX ROUND, in a fresh session/);
  assert.deepEqual([rec().state, rec().fix_session], ["fixing", "new3"]);
});

test("a fix round whose fresh start fails leaves the item in review, and the same dispatch run again starts it", () => {
  const { ws, starts } = fakeFleet();
  webRepo(ws);
  const state = () => (JSON.parse(readFileSync(join(ws, "state", "TEST-53.json"), "utf8")) as { state: string }).state;
  assert.equal(factory(ws, ["dispatch", "bea", "TEST-53", "--title", "Fix it"]).status, 0);
  for (const a of [["pr-open", "--pr", "acme/web#8", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "briefed"]])
    assert.equal(factory(ws, ["state", "TEST-53", ...a]).status, 0);
  writeFileSync(join(ws, "bg-fail"), "no start today");
  let r = factory(ws, ["dispatch", "bea", "TEST-53"]);
  assert.notEqual(r.status, 0);
  assert.equal(state(), "agent-review", "not left in fixing with no session");
  rmSync(join(ws, "bg-fail"));
  r = factory(ws, ["dispatch", "bea", "TEST-53"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /as a FIX ROUND session/);
  assert.equal(state(), "fixing");
  assert.equal(starts().length, 3);
});

// Waiting work has no record, so the dispatch that makes one titles it, and no card shows a bare
// key. --title wins; else the summary the queue watcher last read; else it says how.
test("a dispatch titles a new record: --title, else the queue's last read of the tracker", () => {
  const { ws, put } = fakeFleet(TOML + `
[roles.designer]
cwd = "designers"
model = "opus"
settings = "designer"
add_dirs = ["web"]

[[agents]]
name = "dee"
role = "designer"
`);
  mkdirSync(join(ws, "designers"), { recursive: true });
  mkdirSync(join(ws, "briefs"), { recursive: true });
  writeFileSync(join(ws, "briefs", "app.md"), "the app stack's brief");
  const web = join(ws, "repos", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "AGENTS.md"), "the repo's brief");
  const origin = join(ws, "web-origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  for (const a of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    ["remote", "add", "origin", origin], ["push", "-q", "origin", "main"]])
    execFileSync("git", ["-C", web, ...a]);
  const qs = queueStateFile(openWorkspace(ws, {}));
  mkdirSync(dirname(qs), { recursive: true });
  writeFileSync(qs, JSON.stringify({ known: [], merged: [], conflicting: [], outcomes: ["read"],
    titles: { "TEST-30": "Rename the export", "TEST-31": "Draw the export" } }));
  const rec = (k: string) => JSON.parse(readFileSync(join(ws, "state", `${k}.json`), "utf8")) as { state: string; title?: string };

  let r = factory(ws, ["dispatch", "bea", "TEST-30"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([rec("TEST-30").state, rec("TEST-30").title], ["building", "Rename the export"], "the builder's record has the tracker's title");
  assert.doesNotMatch(r.stdout, /no title/);
  // the first fix round stops the build session for a fresh one, and takes --title all the same
  const wt = (JSON.parse(readFileSync(join(ws, "state", "TEST-30.json"), "utf8")) as { worktree: string }).worktree;
  put("live.json", [sess("new1", "bea", { state: "idle", cwd: wt })]);
  for (const args of [["pr-open", "--pr", "acme/web#1", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "reviewer briefed"], ["fixing", "--evidence", "2 high"]])
    assert.equal(factory(ws, ["state", "TEST-30", ...args]).status, 0);
  r = factory(ws, ["dispatch", "bea", "TEST-30", "--title", "Rename the export, round two"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea's build session on TEST-30 stopped \(new1\); the fix round starts fresh in the same worktree/);
  assert.equal(rec("TEST-30").title, "Rename the export, round two", "--title on the live session's round");
  assert.equal(factory(ws, ["state", "TEST-30", "blocked", "--evidence", "parked for the next case"]).status, 0);
  // taken off the board with its session left running, it goes back on as building, not fixing,
  // which off the board cannot reach
  assert.equal(factory(ws, ["state", "TEST-30", "off"]).status, 0);
  r = factory(ws, ["dispatch", "bea", "TEST-30"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea is still on TEST-30 .*so it keeps its context/);
  assert.equal(rec("TEST-30").state, "building");
  assert.equal((JSON.parse(readFileSync(join(ws, "state", "TEST-30.json"), "utf8")) as { worktree: string }).worktree, wt);

  r = factory(ws, ["dispatch", "dee", "TEST-31"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([rec("TEST-31").state, rec("TEST-31").title], ["designing", "Draw the export"], "and so has the designer's");

  r = factory(ws, ["dispatch", "dee", "TEST-31", "--title", "Draw the export, round two"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec("TEST-31").title, "Draw the export, round two", "--title wins over a title the record has");

  assert.equal(factory(ws, ["state", "TEST-30", "off"]).status, 0);
  r = factory(ws, ["dispatch", "bea", "TEST-32", "--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec("TEST-32").title, undefined, "a key the tracker read never saw gets no title");
  assert.match(r.stdout, /warning: TEST-32 has no title; the card shows its bare key\. Give it one: factory state TEST-32 --title/);
});

// A local tracker's title is the ticket's own; a key it does not hold has none.
test("the tracker's title on a local tracker is the ticket's", () => {
  const LOCAL = `${TOML.replace(/\[tracker\][\s\S]*?done = "Done"\n/, "")}
[tracker]
kind = "local"

[[tracker.projects]]
key = "RPE"
name = "RPE Training App"
`;
  const dir = tempWorkspace(LOCAL);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  T.create(ws, { project: "RPE", number: 1, t: "2026-11-18T10:00:00Z", title: "Log a set's RPE", state: "Backlog", source: { system: "plane" } },
    { human: false, name: "plane", importer: true });
  assert.equal(trackerTitle(ws, "RPE-1"), "Log a set's RPE");
  assert.equal(trackerTitle(ws, "RPE-2"), undefined);
  assert.equal(trackerTitle(ws, "LOCAL-gone"), undefined);
});

// queued is no longer a state. A record written while it was one is off the board, and the approval
// it carries is kept: a builder dispatched on it gets the approved design, and a designer
// dispatched on it gets the last round's links.
test("a queued record with an approval loads as off, approval intact, and a dispatch reads it back", () => {
  const { ws } = fakeFleet(TOML + `
[roles.designer]
cwd = "designers"
model = "opus"
settings = "designer"
add_dirs = ["web"]

[[agents]]
name = "dee"
role = "designer"
`);
  mkdirSync(join(ws, "designers"), { recursive: true });
  mkdirSync(join(ws, "briefs"), { recursive: true });
  writeFileSync(join(ws, "briefs", "app.md"), "the app stack's brief");
  // the builder's checkout, for its worktree: a repo with one commit and its brief
  const web = join(ws, "repos", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "AGENTS.md"), "the repo's brief");
  const origin = join(ws, "web-origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  for (const a of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    ["remote", "add", "origin", origin], ["push", "-q", "origin", "main"]])
    execFileSync("git", ["-C", web, ...a]);
  const design = { approved: "Approved, build it", approved_at: "2026-11-17T10:00:00+00:00", canvas: "https://claude.ai/artifact/c1", slides: "https://claude.ai/artifact/s1" };
  const old = (ticket: string) => writeFileSync(join(ws, "state", `${ticket}.json`), JSON.stringify({
    agent: "dee", asked_you: null, blocked_from: null, created: "2026-11-16T09:00:00+00:00", design, jira: "To Do",
    pr: null, since: "2026-11-17T10:00:00+00:00", stack: "app", state: "queued", ticket, title: "Export the report", worktree: null,
  }));
  mkdirSync(join(ws, "state"), { recursive: true });
  old("TEST-20");
  old("TEST-21");

  let r = factory(ws, ["state", "--off"]);
  assert.equal(r.stdout, "  TEST-20      agent=dee      Export the report\n  TEST-21      agent=dee      Export the report\n");
  r = factory(ws, ["state", "--list"]);
  assert.equal(r.stdout, "  no open tickets\n  and 2 off the board: factory state --off\n");
  r = factory(ws, ["state", "TEST-20"]);
  assert.match(r.stdout, /^ {2}TEST-20 +off .*waiting on: the backlog\n.*design: slides https:\/\/claude\.ai\/artifact\/s1 canvas https:\/\/claude\.ai\/artifact\/c1 approved: Approved, build it/);

  r = factory(ws, ["dispatch", "bea", "TEST-20"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /design approved by Alex \(2026-11-17T10:00:00\+00:00\): slides https:\/\/claude\.ai\/artifact\/s1 canvas https:\/\/claude\.ai\/artifact\/c1\. The brief carries it\./);
  const built = JSON.parse(readFileSync(join(ws, "state", "TEST-20.json"), "utf8"));
  assert.equal(built.state, "building");
  assert.deepEqual(built.design, design, "building keeps the approved design");

  r = factory(ws, ["dispatch", "dee", "TEST-21"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the last round: canvas https:\/\/claude\.ai\/artifact\/c1 slides https:\/\/claude\.ai\/artifact\/s1/);
  assert.equal(JSON.parse(readFileSync(join(ws, "state", "TEST-21.json"), "utf8")).state, "designing");
});

// A builder with several repos and no stack, kept on its live session by a dispatch without --repo,
// keeps the stack of the repo its worktree is in, not the default repo's.
test("a dispatch kept on the live session keeps its worktree's stack, not the default repo's", () => {
  const { ws, put } = fakeFleet(TOML + `
[[agents]]
name = "kit"
role = "builder"
repos = ["web", "api"]
`);
  for (const name of ["web", "api"]) {
    const dir = join(ws, "repos", name), origin = join(ws, `${name}-origin.git`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README"), name);
    writeFileSync(join(dir, "AGENTS.md"), "the repo's brief");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    for (const a of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
      ["remote", "add", "origin", origin], ["push", "-q", "origin", "main"]])
      execFileSync("git", ["-C", dir, ...a]);
  }
  const rec = () => JSON.parse(readFileSync(join(ws, "state", "TEST-40.json"), "utf8")) as { state: string; stack: string | null; worktree: string };
  let r = factory(ws, ["dispatch", "kit", "TEST-40", "--repo", "api", "--title", "On the api"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec().stack, "api");
  const wt = rec().worktree;
  put("live.json", [sess("new1", "kit", { state: "idle", cwd: wt })]);
  // off the board with its session running, then back on by a dispatch that names no repo
  assert.equal(factory(ws, ["state", "TEST-40", "off"]).status, 0);
  r = factory(ws, ["dispatch", "kit", "TEST-40"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kit is still on TEST-40 .*so it keeps its context/);
  assert.deepEqual([rec().state, rec().stack, rec().worktree], ["building", "api", wt], "api's stack, where the worktree is; not web's, the default");
  assert.doesNotMatch(r.stdout, /ignored/, "no --repo given, nothing ignored");
  // a fix round: a --repo that names another repo is said to be ignored; one naming the worktree's
  // is not
  for (const args of [["pr-open", "--pr", "acme/api#1", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "reviewer briefed"], ["fixing", "--evidence", "2 high"]])
    assert.equal(factory(ws, ["state", "TEST-40", ...args]).status, 0);
  r = factory(ws, ["dispatch", "kit", "TEST-40", "--repo", "web"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--repo web ignored: kit is kept in api's worktree$/m);
  assert.equal(rec().stack, "api");
  r = factory(ws, ["dispatch", "kit", "TEST-40", "--repo", "api"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /ignored/);
  // a session in no local repo's worktree (a hosted builder's path, say): the record's stack, and
  // the --repo it overrides is said, with where the stack came from
  put("live.json", [sess(fixSession(ws, "TEST-40"), "kit", { state: "idle", cwd: "/far/worktrees/TEST-40" })]);
  r = factory(ws, ["dispatch", "kit", "TEST-40", "--repo", "web"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--repo web ignored: kit is kept on api, the stack TEST-40's record has$/m);

  // A builder with a stack of its own: --repo is checked against its worktree's repo, never against
  // the stack's name (bea in web's worktree with --repo web was told it was ignored).
  mkdirSync(join(ws, "briefs"), { recursive: true });
  writeFileSync(join(ws, "briefs", "app.md"), "the app stack's brief");
  r = factory(ws, ["dispatch", "bea", "TEST-41", "--repo", "web", "--title", "On the web"]);
  assert.equal(r.status, 0, r.stderr);
  const bwt = (JSON.parse(readFileSync(join(ws, "state", "TEST-41.json"), "utf8")) as { worktree: string }).worktree;
  put("live.json", [sess("new1", "bea", { state: "idle", cwd: bwt })]);
  for (const args of [["pr-open", "--pr", "acme/web#2", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "reviewer briefed"], ["fixing", "--evidence", "1 high"]])
    assert.equal(factory(ws, ["state", "TEST-41", ...args]).status, 0);
  r = factory(ws, ["dispatch", "bea", "TEST-41", "--repo", "web"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bea's build session on TEST-41 stopped/);
  assert.doesNotMatch(r.stdout, /--repo web/, "web is the worktree's repo: nothing ignored");
  r = factory(ws, ["dispatch", "bea", "TEST-41", "--repo", "api"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--repo api ignored: bea is kept in web's worktree$/m);
  put("live.json", [sess(fixSession(ws, "TEST-41"), "bea", { state: "idle", cwd: "/far/worktrees/TEST-41" })]);
  r = factory(ws, ["dispatch", "bea", "TEST-41", "--repo", "api"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--repo api not checked: bea's session is in no local worktree$/m);
});
