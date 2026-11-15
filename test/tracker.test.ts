import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { postMessage } from "../src/board/inbox.js";
import { serve } from "../src/board/server.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { type Actor, checkMove as checkMoveSpent, cliActor, mentions, type MoveProof } from "../src/tickets/guard.js";
import { withLock } from "../src/tickets/lock.js";
import * as T from "../src/tickets/store.js";
import * as W from "../src/wiki/store.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempDir, tempWorkspace } from "./helpers.js";

// The guard with no oks spent elsewhere.
const checkMove = (ws: Parameters<typeof checkMoveSpent>[0], tk: T.Ticket, to: T.TicketState, a: Actor, p: MoveProof = {}) => checkMoveSpent(ws, tk, to, a, p, () => []);
// A Done move on an ok also names the message it spent; the board's ids are random.
const withoutOk = (p: MoveProof) => {
  const { ok, ...rest } = p;
  assert.match(String(ok), /^[0-9a-f]{6}$/);
  return rest;
};

const NO_TRACKER = TOML.replace(/\[tracker\][\s\S]*?done = "Done"\n/, "");
const LOCAL = (extra = "") => `${NO_TRACKER}
[tracker]
kind = "local"
${extra}
[[tracker.projects]]
key = "RPE"
name = "RPE Training App"
labels = ["task", "story", "phase:mvp"]
repo = "web"

[[tracker.projects]]
key = "WEB"
name = "Website"
`;
const ONE = `${NO_TRACKER}
[tracker]
kind = "local"

[[tracker.projects]]
key = "RPE"
name = "RPE"
`;

const ADA: Actor = { human: false, name: "ada" };
const ALEX: Actor = { human: true, name: "Alex" };
const IMPORT: Actor = { human: false, name: "plane", importer: true };

// gh as the guard calls it ($3 is the PR): #95 merged and RPE-1's by its branch, #94 merged and
// RPE-1's by its title, #97 merged but RPE-10's, #96 open, #98 merged and RPE-1's after a second,
// anything else GitHub cannot be reached.
function fakeGh(): string {
  const f = join(tempDir(), "gh");
  writeFileSync(f, `#!/bin/sh
case "$3" in
  95) echo '{"state":"MERGED","mergedAt":"2026-11-15T10:00:00Z","title":"Plan view","body":"","headRefName":"ada/rpe-1-plan-view"}' ;;
  94) echo '{"state":"MERGED","mergedAt":"2026-11-15T10:00:00Z","title":"Plan view (RPE-1)","body":"","headRefName":"plan"}' ;;
  97) echo '{"state":"MERGED","mergedAt":"2026-11-15T10:00:00Z","title":"RPE-10: other","body":"see RPE-100","headRefName":"ada/rpe-10"}' ;;
  96) echo '{"state":"OPEN","mergedAt":null,"title":"RPE-1","body":"","headRefName":"ada/rpe-1"}' ;;
  98) sleep 1; echo '{"state":"MERGED","mergedAt":"2026-11-15T10:00:00Z","title":"RPE-1","body":"","headRefName":"x"}' ;;
  *) echo "error connecting to api.github.com" >&2; exit 1 ;;
esac
`);
  chmodSync(f, 0o755);
  return f;
}
process.env.GH_BIN = fakeGh();

const problems = (toml: string): string[] => {
  const dir = tempDir();
  writeFileSync(join(dir, "factory.toml"), toml);
  try {
    loadConfig(join(dir, "factory.toml"));
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
};

test("config: a local tracker takes projects, and nothing else does", () => {
  assert.deepEqual(problems(LOCAL()), []);
  assert.deepEqual(problems(`${NO_TRACKER}\n[tracker]\nkind = "local"\n`), ["tracker.projects: missing; a local tracker needs at least one [[tracker.projects]]"]);
  assert.deepEqual(problems(`${NO_TRACKER}
[tracker]
kind = "local"

[[tracker.projects]]
key = "rpe"

[[tracker.projects]]
key = "WEB"
labels = ["Bad Label"]

[[tracker.projects]]
key = "OPS"

[[tracker.projects]]
key = "OPS"
`), [
    "tracker.projects[0].key: must be 2 to 10 capital letters or digits, starting with a letter, got \"rpe\"",
    "tracker.projects[1].labels: \"Bad Label\" is not a label: lower-case words, digits, ':' and '-'",
    "tracker.projects[3].key: \"OPS\" is already a project",
  ]);
  assert.deepEqual(problems(TOML.replace('kind = "jira"', 'kind = "jira"\ndir = "x"') + '\n[[tracker.projects]]\nkey = "RPE"\n'), [
    "tracker.projects: only a local tracker has projects; kind is \"jira\"",
    "tracker.dir: only a local tracker has a dir; kind is \"jira\"",
  ]);
});

// The rule Mikko set: issue tracking is off unless asked for. A Jira workspace, or one with no
// tracker, has no ticket or wiki command, no /tickets or /wiki page, no API and no header link.
for (const [name, toml] of [["jira", TOML], ["none", NO_TRACKER]] as const)
  test(`off by default: a ${name} workspace has no local tracker anywhere`, async () => {
    const dir = tempWorkspace(toml);
    for (const args of [["ticket", "list"], ["ticket", "create", "--title", "x"], ["wiki", "list"]]) {
      const r = factory(dir, args);
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, /no local tracker/, args.join(" "));
    }
    const ws = openWorkspace(dir);
    assert.equal(T.enabled(ws), false);
    const board = await serve(ws, { port: 0, host: "127.0.0.1", reviews: async () => "{}" });
    after(() => board.close());
    for (const p of ["/tickets", "/wiki", "/api/tickets", "/api/tickets?summary=1", "/api/tickets/RPE-1", "/api/wiki", "/api/wiki/RPE/x"])
      assert.equal((await fetch(board.url + p)).status, 404, p);
    const post = await fetch(board.url + "/api/tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: "RPE", title: "x" }) });
    assert.equal(post.status, 404);
    const snap = (await (await fetch(board.url + "/api")).json()) as { tracker: unknown };
    assert.equal(snap.tracker, null, "the board's header gets no tracker links");
  });

test("store: numbers per project, the floor, events folded, a bare number with one project", async () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  const a = T.create(ws, { project: "RPE", title: "first" }, ADA);
  const b = T.create(ws, { project: "WEB", title: "web first" }, ADA);
  assert.equal(a.key, "RPE-1");
  assert.equal(b.key, "WEB-1");
  T.setFloor(ws, "RPE", 341);
  assert.equal(T.create(ws, { project: "RPE", title: "after the import" }, ADA).key, "RPE-341");
  T.setFloor(ws, "RPE", 10);
  assert.equal(T.create(ws, { project: "RPE", title: "a floor never goes down" }, ADA).key, "RPE-342");
  // an import keeps its number and time, and the next new one goes past it
  T.create(ws, { project: "WEB", number: 40, t: "2026-01-02T03:04:05Z", title: "imported", state: "Done", source: { system: "plane" } }, IMPORT);
  assert.equal(T.create(ws, { project: "WEB", title: "next" }, ADA).key, "WEB-41");
  assert.throws(() => T.create(ws, { project: "WEB", number: 40, title: "again" }, IMPORT), /EEXIST/);
  assert.throws(() => T.create(ws, { project: "WEB", number: 50, title: "an agent's number" }, ADA), /only an import/);
  assert.throws(() => T.create(ws, { project: "WEB", title: "straight to Todo", state: "Todo" }, ADA), /Backlog only/);

  T.describe(ws, "RPE-1", "more", "ada");
  T.label(ws, "RPE-1", "add", "task", "ada");
  assert.throws(() => T.label(ws, "RPE-1", "add", "nope", "ada"), /not a label of RPE; labels: task, story, phase:mvp/);
  T.label(ws, "WEB-1", "add", "anything-goes", "ada");
  T.relate(ws, "RPE-1", "blocked_by", "WEB-1", "ada");
  T.link(ws, "RPE-1", "https://example.com/x", "x", "ada");
  T.comment(ws, "RPE-1", "a comment", "ada");
  await T.move(ws, "RPE-1", "Todo", ALEX);
  const tk = T.load(ws, "RPE-1");
  assert.equal(tk.state, "Todo");
  assert.equal(tk.body, "more");
  assert.deepEqual(tk.labels, ["task"]);
  assert.deepEqual(tk.relations, [{ kind: "blocked_by", to: "WEB-1" }]);
  assert.equal(tk.comments.length, 1);
  T.relate(ws, "RPE-1", "blocked_by", "WEB-1", "ada", "unrelate");
  assert.deepEqual(T.load(ws, "RPE-1").relations, []);
  assert.deepEqual(T.list(ws, "WEB").map((t) => t.key), ["WEB-1", "WEB-40", "WEB-41"]);
  assert.equal(T.load(ws, "WEB-40").created, "2026-01-02T03:04:05Z");
  assert.throws(() => T.resolveKey(ws, "12"), /name the project/);
  assert.throws(() => T.resolveKey(ws, "OPS-1"), /no project "OPS"/);

  const one = openWorkspace(tempWorkspace(ONE));
  assert.equal(T.resolveKey(one, "12"), "RPE-12");
});

test("guard: Backlog needs the human's message, Done this ticket's merged PR or the human's ok from any state, the rest is free", async () => {
  const dir = tempWorkspace(LOCAL());
  const ws = openWorkspace(dir);
  postMessage(ws, "ship the planner change once it is green");
  const agent = cliActor(ws, undefined);
  assert.deepEqual(agent, { human: false, name: "ada" }, "the CLI writes as the lead by default");
  assert.throws(() => cliActor(ws, "Alex"), /writes as an agent/);
  assert.throws(() => cliActor(ws, "zed"), /no such agent/);

  const tk = T.create(ws, { project: "RPE", title: "t" }, ADA);
  await assert.rejects(checkMove(ws, tk, "Todo", agent), /REFUSED: RPE-1 is in Backlog/);
  await assert.rejects(checkMove(ws, tk, "Todo", agent, { asked: "the planner" }), /at least 20/);
  await assert.rejects(checkMove(ws, tk, "Todo", agent, { asked: "words nobody ever said here" }), /not in any of Alex's messages/);
  assert.deepEqual(await checkMove(ws, tk, "Todo", agent, { asked: "ship the   planner change" }), { asked: "ship the planner change" }, "from the message log");
  await assert.rejects(checkMove(ws, tk, "Todo", agent, { asked: "ok" + " ".repeat(30) }), /at least 20/);
  // a row an agent posts is not the human's, whatever it says
  appendFileSync(ws.messages, JSON.stringify({ t: "2026-11-15T00:00:00Z", id: "a1", text: "words an agent wrote for itself", kind: "ada" }) + "\n");
  await assert.rejects(checkMove(ws, tk, "Todo", agent, { asked: "words an agent wrote for itself" }), /not in any of Alex's messages/);
  assert.deepEqual(await checkMove(ws, tk, "Todo", ALEX), {}, "the human is never refused");
  // Backlog straight to Done: one quote answers both, or the quote and the PR
  assert.deepEqual(withoutOk(await checkMove(ws, tk, "Done", agent, { asked: "ship the planner change" })), { asked: "ship the planner change" });
  await assert.rejects(checkMove(ws, tk, "Done", agent, { merged: "#95" }), /REFUSED: RPE-1 is in Backlog/);
  assert.deepEqual(await checkMove(ws, tk, "Done", agent, { asked: "ship the planner change", merged: "#95" }), { asked: "ship the planner change", merged: "#95" });
  assert.deepEqual(await checkMove(ws, tk, "Cancelled", agent, { asked: "ship the planner change" }), { asked: "ship the planner change" }, "Cancelled needs no PR");

  // the store runs the guard itself: no caller can skip it
  await assert.rejects(T.move(ws, "RPE-1", "Todo", ADA), /REFUSED: RPE-1 is in Backlog/);
  assert.equal(T.load(ws, "RPE-1").state, "Backlog");
  await T.move(ws, "RPE-1", "In Review", ALEX);
  const rev = T.load(ws, "RPE-1");
  await assert.rejects(checkMove(ws, rev, "Done", agent), /Done is Alex's merge, or Alex's ok, from any state/);
  // a ticket with nothing to merge goes to Done on the human's quoted ok, judged as out of Backlog
  assert.deepEqual(withoutOk(await checkMove(ws, rev, "Done", agent, { asked: "ship the planner change" })), { asked: "ship the planner change" });
  await assert.rejects(checkMove(ws, rev, "Done", agent, { asked: "words an agent wrote for itself" }), /not in any of Alex's messages/);
  await assert.rejects(checkMove(ws, rev, "Done", agent, { asked: "ship" }), /at least 20/);
  await assert.rejects(checkMove(ws, rev, "Done", agent, { merged: "yes" }), /PR number/);
  await assert.rejects(checkMove(ws, rev, "Done", agent, { merged: "#96" }), /acme\/web#96 is OPEN, not merged/);
  await assert.rejects(checkMove(ws, rev, "Done", agent, { merged: "#1" }), /could not ask GitHub about acme\/web#1: error connecting/);
  await assert.rejects(checkMove(ws, rev, "Done", agent, { merged: "#97" }), /acme\/web#97 is merged but is not RPE-1's: its title, body and branch \("ada\/rpe-10"\) never name RPE-1/);
  assert.deepEqual(await checkMove(ws, rev, "Done", agent, { merged: "#95" }), { merged: "#95" }, "by its branch");
  assert.deepEqual(await checkMove(ws, rev, "Done", agent, { merged: "#94" }), { merged: "#94" }, "by its title");
  for (const to of ["In Progress", "Todo", "In Design", "In Testing", "Cancelled"] as const)
    assert.deepEqual(await checkMove(ws, rev, to, agent), {}, `${to} is free`);
  // back to work, then on to Done, still needs the PR
  await T.move(ws, "RPE-1", "In Progress", ADA);
  await assert.rejects(T.move(ws, "RPE-1", "Done", ADA), /Done is Alex's merge/);
  await assert.rejects(T.move(ws, "RPE-1", "Done", ADA, { merged: "#96" }), /not merged/);
  assert.equal(T.load(ws, "RPE-1").state, "In Progress");
  assert.equal((await T.move(ws, "RPE-1", "Done", ADA, { merged: "#95" })).ticket.state, "Done");
  // the store records the ok it was given
  await T.move(ws, "RPE-1", "In Progress", ADA);
  await assert.rejects(T.move(ws, "RPE-1", "Done", ADA, { asked: "words an agent wrote for itself" }), /not in any/);
  assert.equal((await T.move(ws, "RPE-1", "Done", ADA, { asked: "ship the planner change" })).ticket.state, "Done");
  const ev = readFileSync(join(T.projectDir(ws, "RPE"), "RPE-1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  assert.equal(ev.asked, "ship the planner change");
  assert.match(ev.ok, /^[0-9a-f]{6}$/, "and the message it spent");
  assert.equal(ev.merged, undefined);
  T.create(ws, { project: "WEB", title: "w" }, ADA);
  await assert.rejects(T.move(ws, "WEB-1", "Done", ADA, { asked: "ship the planner change", merged: "#95" }), /WEB names no repo/);

  assert.ok(mentions("drake/rpe-1-plan", "RPE-1") && mentions("Fixes RPE-1.", "RPE-1"));
  assert.ok(!mentions("RPE-10", "RPE-1") && !mentions("XRPE-1", "RPE-1") && !mentions("RPE-1a", "RPE-1"));
});

test("guard: one message closes one ticket, and an empty quote gets the refusal that names both proofs", async () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  postMessage(ws, "please look at the backlog items today");
  postMessage(ws, "the export work is done, close it");
  const ok = "please look at the backlog items today";
  for (let i = 0; i < 3; i++) T.create(ws, { project: "RPE", title: `t${i}` }, ADA);
  // one quote covers Backlog straight to Done on A
  assert.equal((await T.move(ws, "RPE-1", "Done", ADA, { asked: ok })).ticket.state, "Done");
  await T.move(ws, "RPE-2", "In Review", ALEX);
  await assert.rejects(T.move(ws, "RPE-2", "Done", ADA, { asked: ok }), /REFUSED: Alex's message with "please look at the backlog items today" already closed RPE-1; one message closes one ticket/);
  await assert.rejects(T.move(ws, "RPE-2", "Done", ADA, { asked: "look at the backlog items" }), /already closed RPE-1/, "a shorter cut of the same message is the same message");
  await assert.rejects(T.move(ws, "RPE-3", "Done", ADA, { asked: ok }), /already closed RPE-1/, "Backlog to Done on another ticket too");
  assert.equal(T.load(ws, "RPE-2").state, "In Review");
  assert.equal(T.load(ws, "RPE-3").state, "Backlog");
  // the message it spent is still A's own
  await T.move(ws, "RPE-1", "In Progress", ALEX);
  assert.equal((await T.move(ws, "RPE-1", "Done", ADA, { asked: ok })).ticket.state, "Done");
  // another message is a fresh ok; an ok is spent on Done only, not out of Backlog
  assert.equal((await T.move(ws, "RPE-2", "Done", ADA, { asked: "the export work is done" })).ticket.state, "Done");
  assert.equal((await T.move(ws, "RPE-3", "Todo", ADA, { asked: "the export work is done" })).ticket.state, "Todo");
  // the same words sent again are a second message, and a second ok
  await assert.rejects(T.move(ws, "RPE-3", "Done", ADA, { asked: ok }), /already closed RPE-1/);
  postMessage(ws, "please look at the backlog items today");
  assert.equal((await T.move(ws, "RPE-3", "Done", ADA, { asked: ok })).ticket.state, "Done", "a phrase sent twice closes two tickets");
  // the human is never refused
  await T.move(ws, "RPE-3", "In Review", ALEX);
  assert.equal((await T.move(ws, "RPE-3", "Done", ALEX)).ticket.state, "Done");

  // an empty quote is no quote
  T.create(ws, { project: "RPE", title: "t3" }, ADA);
  await T.move(ws, "RPE-4", "In Review", ALEX);
  await assert.rejects(T.move(ws, "RPE-4", "Done", ADA, { asked: "" }), (e: Error) =>
    /REFUSED: Done is Alex's merge, or Alex's ok, from any state/.test(e.message) && /--merged '#<pr>'/.test(e.message) && /--asked "<their words>"/.test(e.message));
});

test("guard: a message naming tickets closes each of them and no other, in any project", async () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  postMessage(ws, "RPE-1 and rpe-2 are done, close both");
  postMessage(ws, "the WEB-1 copy change is done too");
  for (let i = 0; i < 3; i++) T.create(ws, { project: "RPE", title: `t${i}` }, ADA);
  T.create(ws, { project: "WEB", title: "w" }, ADA);
  for (const k of ["RPE-1", "RPE-2", "RPE-3", "WEB-1"]) await T.move(ws, k, "In Review", ALEX);
  assert.equal((await T.move(ws, "RPE-1", "Done", ADA, { asked: "RPE-1 and rpe-2 are done" })).ticket.state, "Done");
  assert.equal((await T.move(ws, "RPE-2", "Done", ADA, { asked: "RPE-1 and rpe-2 are done" })).ticket.state, "Done", "each key it names");
  await assert.rejects(T.move(ws, "RPE-3", "Done", ADA, { asked: "RPE-1 and rpe-2 are done" }), /names RPE-1, rpe-2, not RPE-3/);
  await assert.rejects(T.move(ws, "RPE-3", "Done", ADA, { asked: "are done, close both" }), /names RPE-1, rpe-2, not RPE-3/, "a cut that leaves the keys out is still that message");
  await assert.rejects(T.move(ws, "WEB-1", "Done", ADA, { asked: "RPE-1 and rpe-2 are done" }), /not WEB-1/, "nor one in another project");
  await assert.rejects(T.move(ws, "RPE-3", "Done", ADA, { asked: "the WEB-1 copy change is done" }), /names WEB-1, not RPE-3/);
  assert.equal((await T.move(ws, "WEB-1", "Done", ADA, { asked: "the WEB-1 copy change is done" })).ticket.state, "Done");
  assert.equal(T.load(ws, "RPE-3").state, "In Review");
});

test("guard: an ok spent in one project is spent in all, and a merged move spends none", async () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  postMessage(ws, "that is finished, ship it whenever");
  const ok = "that is finished, ship it whenever";
  T.create(ws, { project: "RPE", title: "r" }, ADA);
  T.create(ws, { project: "RPE", title: "r2" }, ADA);
  T.create(ws, { project: "WEB", title: "w" }, ADA);
  // Backlog to Done with both proofs: the merge is the proof, so the quote stays unspent
  const merged = await T.move(ws, "RPE-1", "Done", ADA, { asked: ok, merged: "#95" });
  assert.equal(merged.ticket.state, "Done");
  const ev = readFileSync(join(T.projectDir(ws, "RPE"), "RPE-1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  assert.equal(ev.merged, "#95");
  assert.ok(!T.spentOks(ws, "RPE-2").length, "a merged move spends no ok");
  assert.equal((await T.move(ws, "WEB-1", "Done", ADA, { asked: ok })).ticket.state, "Done");
  await T.move(ws, "RPE-2", "In Review", ALEX);
  await assert.rejects(T.move(ws, "RPE-2", "Done", ADA, { asked: ok }), /already closed WEB-1/);
  assert.deepEqual(T.spentOks(ws, "RPE-2").map((s) => s.key), ["WEB-1"]);
});

test("guard: a legacy message kind is shown as the human's but is never quotable", async () => {
  // the test config's legacy_message_kind is "alex"
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  mkdirSync(ws.stateDir, { recursive: true });
  appendFileSync(ws.messages, JSON.stringify({ t: "2026-11-15T00:00:00Z", id: "n1", text: "a note that reads like an order", kind: "alex" }) + "\n");
  const tk = T.create(ws, { project: "RPE", title: "t" }, ADA);
  await assert.rejects(checkMove(ws, tk, "Todo", ADA, { asked: "a note that reads like an order" }), /not in any of Alex's messages/);
  await T.move(ws, "RPE-1", "In Testing", ALEX);
  await assert.rejects(checkMove(ws, T.load(ws, "RPE-1"), "Done", ADA, { asked: "a note that reads like an order" }), /not in any of Alex's messages/, "nor is it an ok for Done");
});

test("store: GitHub is asked before the lock, so a slow answer holds up no other write", async () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  T.create(ws, { project: "RPE", title: "t" }, ADA);
  await T.move(ws, "RPE-1", "In Review", ALEX);
  const start = Date.now();
  const moving = T.move(ws, "RPE-1", "Done", ADA, { merged: "#98" });
  await new Promise((r) => setTimeout(r, 100));
  T.label(ws, "RPE-1", "add", "task", "ada");
  assert.ok(Date.now() - start < 900, "the label did not wait for GitHub");
  assert.equal((await moving).ticket.state, "Done");
  assert.deepEqual(T.load(ws, "RPE-1").labels, ["task"]);
});

test("lock: a directory at the bare key blocks no ticket or page", async () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  T.create(ws, { project: "RPE", title: "t" }, ADA);
  mkdirSync(join(T.projectDir(ws, "RPE"), ".locks", "RPE-1"), { recursive: true });
  mkdirSync(join(W.wikiDir(ws, "RPE"), ".locks", "notes"), { recursive: true });
  await T.move(ws, "RPE-1", "In Review", ALEX);
  T.label(ws, "RPE-1", "add", "task", "ada");
  assert.equal(T.load(ws, "RPE-1").state, "In Review");
  assert.deepEqual(T.load(ws, "RPE-1").labels, ["task"]);
  W.save(ws, { project: "RPE", path: "notes", title: "Notes", body: "b", by: "ada", base: null });
  assert.equal(W.read(ws, "RPE", "notes").body.trim(), "b");
});

test("store: a torn line costs one event, the next lands on a line of its own", () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  T.create(ws, { project: "RPE", title: "t" }, ADA);
  const f = join(ws.stateDir, "tracker", "tickets", "RPE", "RPE-1.jsonl");
  appendFileSync(f, '{"t":"2026-11-15T00:00:00Z","by":"ada","op":"comm');
  T.comment(ws, "RPE-1", "after the tear", "ada");
  T.comment(ws, "RPE-1", "and another", "ada");
  assert.deepEqual(T.load(ws, "RPE-1").comments.map((c) => c.body), ["after the tear", "and another"]);
  assert.equal(readFileSync(f, "utf8").split("\n").filter(Boolean).length, 4);
});

test("lock: two processes at once never both hold it, and a killed holder's lock is free", async () => {
  const dir = tempDir();
  const counter = join(dir, "n");
  writeFileSync(counter, "0");
  const lockJs = fileURLToPath(new URL("../src/tickets/lock.js", import.meta.url));
  // each writer reads, waits, writes: without the lock two of them lose an increment
  const writer = `const { withLock } = await import(${JSON.stringify(lockJs)});
const fs = await import("node:fs");
for (let i = 0; i < 40; i++) withLock(${JSON.stringify(join(dir, "l"))}, () => {
  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
});`;
  const runOne = () => new Promise<number>((resolve) => spawn(process.execPath, ["--input-type=module", "-e", writer], { stdio: "inherit" }).on("exit", (c) => resolve(c ?? 1)));
  assert.deepEqual(await Promise.all([runOne(), runOne(), runOne()]), [0, 0, 0]);
  assert.equal(readFileSync(counter, "utf8"), "120");

  const holder = spawn(process.execPath, ["--input-type=module", "-e", `const { withLock } = await import(${JSON.stringify(lockJs)});
withLock(${JSON.stringify(join(dir, "k"))}, () => { process.stdout.write("held\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });`]);
  await new Promise<void>((r) => holder.stdout.once("data", () => r()));
  assert.throws(() => withLock(join(dir, "k"), () => 0, 100), /another writer holds/);
  holder.kill("SIGKILL");
  await new Promise((r) => holder.on("exit", r));
  assert.equal(withLock(join(dir, "k"), () => "mine"), "mine");
});

test("the CLI: create, list by project, move with its guards, describe appends, wiki edit with a base", () => {
  const dir = tempWorkspace(LOCAL());
  const ok = (args: string[]) => {
    const r = factory(dir, args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const no = (args: string[], re: RegExp) => {
    const r = factory(dir, args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, re);
  };
  assert.match(ok(["ticket", "create", "--project", "RPE", "--title", "Plan view", "--body", "first words", "--label", "task"]), /RPE-1 filed in Backlog/);
  ok(["ticket", "create", "--project", "WEB", "--title", "Landing page", "--as", "bea"]);
  no(["ticket", "create", "--title", "which project"], /--project is needed/);
  assert.match(ok(["ticket", "list", "--project", "RPE"]), /RPE-1 +Backlog/);
  assert.doesNotMatch(ok(["ticket", "list", "--project", "RPE"]), /WEB-1/);
  assert.match(ok(["ticket", "list"]), /WEB-1/);
  no(["ticket", "move", "RPE-1", "Todo"], /REFUSED/);
  postMessage(openWorkspace(dir), "go ahead with the plan view please");
  no(["ticket", "move", "RPE-1", "Todo", "--asked", "the plan view"], /at least 20/);
  assert.match(ok(["ticket", "move", "RPE-1", "Todo", "--asked", "go ahead with the plan view"]), /Backlog -> Todo/);
  ok(["ticket", "move", "RPE-1", "In Review"]);
  no(["ticket", "move", "RPE-1", "Done"], /--merged/);
  no(["ticket", "move", "RPE-1", "Done", "--merged", "#96"], /not merged/);
  ok(["ticket", "move", "RPE-1", "Done", "--merged", "#95"]);
  const log = readFileSync(join(dir, "state", "tracker", "tickets", "RPE", "RPE-1.jsonl"), "utf8");
  assert.match(log, /"asked":"go ahead with the plan view"/);
  assert.match(log, /"merged":"#95"/);
  ok(["ticket", "describe", "RPE-1", "second words"]);
  ok(["ticket", "comment", "RPE-1", "a note", "--as", "cal"]);
  const shown = ok(["ticket", "show", "RPE-1"]);
  assert.match(shown, /first words\n\nsecond words/);
  assert.match(shown, /1 comment/);
  assert.match(ok(["ticket", "comments", "RPE-1"]), /--- cal, .*\na note/);
  no(["ticket", "label", "RPE-1", "add", "nope"], /not a label of RPE/);
  no(["ticket", "move", "RPE-1", "Shipped"], /unknown state/);

  const f = join(dir, "page.md");
  writeFileSync(f, "# Vision\n\nwords\n");
  ok(["wiki", "edit", "RPE/vision", "--file", f, "--title", "Vision"]);
  no(["wiki", "edit", "RPE/vision", "--file", f], /--base/);
  const sha = /sha ([0-9a-f]{16})/.exec(ok(["wiki", "show", "RPE/vision"]))?.[1] as string;
  writeFileSync(f, "# Vision\n\nmore words\n");
  no(["wiki", "edit", "RPE/vision", "--file", f, "--base", "0000000000000000"], /changed since/);
  ok(["wiki", "edit", "RPE/vision", "--file", f, "--base", sha]);
  assert.match(ok(["wiki", "list"]), /RPE\/vision +Vision/);
  assert.equal(ok(["wiki", "history", "RPE/vision"]).trim().split("\n").length, 2);
  no(["wiki", "show", "vision"], /name the project/);
});

test("wiki store: a save over a changed page is refused, and a new page must not exist", () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  const a = W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "one", by: "Alex", base: null });
  assert.throws(() => W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "x", by: "Alex", base: null }), W.Conflict);
  const b = W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "two", by: "Alex", base: a.sha });
  assert.throws(() => W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "three", by: "ada", base: a.sha }), W.Conflict);
  // a retry of a save that landed is that save, not a conflict with itself
  assert.equal(W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "two", by: "Alex", base: a.sha }).sha, b.sha);
  assert.equal(W.history(ws, "RPE", "spec").length, 2, "and adds no history");
  W.save(ws, { project: "RPE", path: "spec/child", title: "Child", body: "c", by: "Alex", base: null });
  assert.deepEqual(W.list(ws, "RPE").map((p) => p.path), ["spec", "spec/child"]);
  assert.equal(W.read(ws, "RPE", "spec").body, "two\n");
  assert.equal(b.title, "Spec");
  assert.throws(() => W.checkPath("../etc"), /not a page path/);
  assert.throws(() => W.checkPath("Spec"), /not a page path/);
  assert.equal(W.slug("Strength as one hidden number"), "strength-as-one-hidden-number");
  assert.equal(W.slug("How the planner thinks (RPE-217)"), "how-the-planner-thinks-rpe-217");
});

test("the board: tickets and wiki pages, the API writes as the human, a stale wiki save is 409", async () => {
  const dir = tempWorkspace(LOCAL());
  const ws = openWorkspace(dir);
  const board = await serve(ws, { port: 0, host: "127.0.0.1", reviews: async () => "{}" });
  after(() => board.close());
  const get = async (p: string) => {
    const r = await fetch(board.url + p);
    return { status: r.status, body: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as Record<string, unknown>) : await r.text() };
  };
  const post = async (p: string, b: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) => {
    const r = await fetch(board.url + p, { method: "POST", headers, body: JSON.stringify(b) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  assert.equal((await get("/tickets")).status, 200);
  assert.equal((await get("/wiki")).status, 200);
  assert.equal((await get("/static/tickets.js")).status, 200);

  const c = await post("/api/tickets", { project: "RPE", title: "From the phone", body: "b", labels: ["story"], state: "Todo" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((c.body.ticket as T.Ticket).key, "RPE-1");
  assert.equal((c.body.ticket as T.Ticket).by, "Alex");
  assert.equal((await post("/api/tickets", { project: "RPE", title: "x" }, { "Content-Type": "text/plain" })).status, 403, "only a same-site JSON post");
  assert.equal((await post("/api/tickets", { project: "RPE", title: "x" }, { "Content-Type": "application/json", Origin: "http://evil.example" })).status, 403);
  T.create(ws, { project: "RPE", title: "an agent's" }, ADA);
  assert.equal((await get("/api")).status, 200);
  assert.deepEqual(((await get("/api")).body as { tracker: unknown }).tracker, { backlog: 1 });
  assert.deepEqual((await get("/api/tickets?summary=1")).body, { backlog: 1 });

  for (const op of [{ op: "move", to: "In Review" }, { op: "move", to: "Done" }, { op: "comment", body: "nice" }, { op: "label", name: "task", add: true },
    { op: "title", title: "Renamed" }, { op: "body", body: "replaced" }, { op: "relate", kind: "relates_to", to: "RPE-2" }, { op: "link", url: "https://x.example/1" }]) {
    const r = await post("/api/tickets/RPE-1", op);
    assert.equal(r.status, 200, `${JSON.stringify(op)}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await post("/api/tickets/RPE-1", { op: "label", name: "nope", add: true })).status, 400);
  assert.equal((await post("/api/tickets/RPE-1", { op: "move", to: "Shipped" })).status, 400);
  assert.equal((await post("/api/tickets/RPE-9", { op: "comment", body: "x" })).status, 404);
  const tk = (await get("/api/tickets/RPE-1")).body as unknown as T.Ticket;
  assert.equal(tk.state, "Done", "the human moves straight on from In Review");
  assert.equal(tk.title, "Renamed");
  assert.equal(tk.body, "replaced");
  assert.deepEqual(tk.labels, ["story", "task"]);
  assert.equal(tk.comments[0]?.by, "Alex");
  const list = (await get("/api/tickets?project=RPE")).body as { tickets: { key: string; comments: number }[] };
  assert.deepEqual(list.tickets.map((t) => [t.key, t.comments]), [["RPE-1", 1], ["RPE-2", 0]]);

  const w1 = await post("/api/wiki/RPE/vision", { title: "Vision", body: "v1", base: null });
  assert.equal(w1.status, 200);
  const sha = (w1.body.page as W.Page).sha;
  assert.equal((await post("/api/wiki/RPE/vision", { title: "Vision", body: "v2", base: sha })).status, 200);
  const stale = await post("/api/wiki/RPE/vision", { title: "Vision", body: "v3", base: sha });
  assert.equal(stale.status, 409);
  assert.equal((stale.body.current as W.Page).body, "v2\n", "the page as it now is, for the editor to show");
  assert.notEqual((await post("/api/wiki/RPE/..%2F..%2Fx", { title: "x", body: "x", base: null })).status, 200, "no path outside the wiki");
  assert.equal((await post("/api/wiki/RPE/Bad Path", { title: "x", body: "x", base: null })).status, 400);
  const pg = (await get("/api/wiki/RPE/vision")).body as unknown as W.Page & { history: unknown[] };
  assert.equal(pg.history.length, 2);
  assert.equal(((await get("/api/wiki")).body as { pages: unknown[] }).pages.length, 1);
});
