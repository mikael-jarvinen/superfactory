import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { factory, tempWorkspace } from "./helpers.js";

// Walk one item through every state with a throwaway store, and check the refusals.
test("state walk", () => {
  const ws = tempWorkspace();
  after(() => rmSync(ws, { recursive: true, force: true }));
  const T = "TEST-1";
  const failures: string[] = [];
  const ok = (...args: string[]) => {
    const r = factory(ws, args);
    if (r.status !== 0) failures.push(`expected ok: ${args.join(" ")}\n${r.stderr}`);
  };
  const no = (...args: string[]) => {
    const r = factory(ws, args);
    if (r.status === 0) failures.push(`expected refusal: ${args.join(" ")}`);
  };

  ok("state", T, "queued", "--stack", "app");
  no("state", T, "fixing");
  ok("state", T, "building", "--agent", "bea");
  ok("state", T, "queued", "--evidence", "sent back");
  ok("state", T, "building", "--agent", "bea");
  no("state", T, "pr-open");
  no("state", T, "pr-open", "--pr", "bad", "--head", "abc1234");
  ok("state", T, "pr-open", "--pr", "acme/web#1", "--head", "abc1234abc1234");
  ok("state", T, "agent-review", "--evidence", "reviewer briefed");
  ok("state", T, "fixing", "--evidence", "2 high");
  ok("state", T, "agent-review", "--evidence", "delta");
  ok("state", T, "gate", "--evidence", "ship/ship on abc1234");
  no("state", T, "your-review");
  no("state", T, "your-review", "--reviewed", "9999999");
  ok("state", T, "your-review", "--reviewed", "abc1234abc1234");
  ok("state", T, "blocked", "--note", "asked Alex about X");
  ok("state", T, "your-review");
  ok("state", T, "colleague-review", "--evidence", "Alex asked the team");
  ok("state", T, "queued", "--note", "next slice");
  ok("state", T, "building", "--agent", "bea");
  ok("state", T, "pr-open", "--pr", "acme/web#2", "--head", "def5678def5678");
  ok("state", T, "gate", "--force");
  ok("state", T, "your-review", "--reviewed", "def5678def5678");
  ok("state", T, "colleague-review");
  ok("state", T, "done", "--evidence", "mergesha");
  no("state", T, "building");
  ok("state", "--list", "--all");
  const L = "LOCAL-ad-hoc";
  ok("state", L, "building", "--stack", "app", "--note", "no tracker ticket");
  ok("state", L, "pr-open", "--pr", "acme/web#3", "--head", "aaa1111aaa1111");
  assert.deepEqual(failures, []);

  const local = JSON.parse(readFileSync(join(ws, "state", `${L}.json`), "utf8"));
  assert.equal(local.jira, null, "a local key carries no tracker status");
  const rec = JSON.parse(readFileSync(join(ws, "state", `${T}.json`), "utf8"));
  assert.equal(rec.state, "done");
  assert.equal(rec.pr.number, 2);
  assert.equal(rec.jira, "Done");
  assert.deepEqual(rec.prs, [{ head: "def5678def5678", number: 2, repo: "acme/web", reviewed_sha: "def5678def5678" }]);
  const events = readFileSync(join(ws, "state", "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(events.length >= 18, `events count ${events.length}`);
});

test("transition output and refusal messages", () => {
  const ws = tempWorkspace();
  after(() => rmSync(ws, { recursive: true, force: true }));
  let r = factory(ws, ["state", "TEST-2", "building"]);
  assert.equal(r.stdout, "TEST-2: (new) -> building  agent=None  jira should read: In Progress\n");
  r = factory(ws, ["state", "TEST-2", "done"]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "factory: TEST-2: building -> done is not a valid transition. From building you can go to: " +
    "blocked, pr-open, queued. Use --force if you mean it.\n");
  r = factory(ws, ["state", "TEST-2", "blocked"]);
  assert.match(r.stdout, /warning: blocked without --note: record the question you asked Alex/);
  r = factory(ws, ["state", "nope", "queued"]);
  assert.equal(r.stderr, "factory: 'nope' is neither a ticket key nor a local key like LOCAL-fix-flaky-login\n");
  r = factory(ws, ["drop", "TEST-2"]);
  assert.match(r.stderr, /TEST-2 is not a LOCAL key/);
  factory(ws, ["state", "LOCAL-gone", "queued"]);
  r = factory(ws, ["drop", "LOCAL-gone", "--note", "not asked for"]);
  assert.equal(r.stdout, "  dropped LOCAL-gone (was queued)\n");
  const last = readFileSync(join(ws, "state", "events.jsonl"), "utf8").trim().split("\n").pop() as string;
  assert.match(last, /^\{"at": "[^"]+", "event": "dropped", "from_state": "queued", "note": "not asked for", "ticket": "LOCAL-gone"\}$/);
});

// Mikael split lyyti-classic#8754 off LOCAL-reports-petes-design, and the PR stayed on both cards.
test("state --remove-pr takes a PR off an item and logs it", () => {
  const ws = tempWorkspace();
  after(() => rmSync(ws, { recursive: true, force: true }));
  const T = "TEST-3";
  factory(ws, ["state", T, "building", "--agent", "bea"]);
  factory(ws, ["state", T, "pr-open", "--pr", "acme/web#1", "--head", "abc1234"]);
  factory(ws, ["state", T, "pr-open", "--pr", "acme/web#2", "--head", "def5678"]);
  let r = factory(ws, ["state", T, "--remove-pr", "acme/web#2", "--note", "split off to TEST-4"]);
  assert.equal(r.stdout, "TEST-3: removed PR acme/web#2; PRs now: acme/web#1\n");
  const rec = JSON.parse(readFileSync(join(ws, "state", `${T}.json`), "utf8"));
  assert.equal(rec.state, "pr-open", "no transition");
  assert.deepEqual(rec.prs, [{ head: "abc1234", number: 1, repo: "acme/web" }]);
  assert.deepEqual(rec.pr, rec.prs[0], "the focus moves to the PR left");
  const last = JSON.parse(readFileSync(join(ws, "state", "events.jsonl"), "utf8").trim().split("\n").pop() as string);
  assert.deepEqual([last.from, last.to, last.evidence, last.note], ["pr-open", "pr-open", "removed PR acme/web#2", "split off to TEST-4"]);
  r = factory(ws, ["state", T, "--remove-pr", "acme/web#2"]);
  assert.equal(r.stderr, "factory: TEST-3 has no PR acme/web#2; it has: acme/web#1\n");
});
