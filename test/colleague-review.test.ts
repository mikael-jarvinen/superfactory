import assert from "node:assert/strict";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, test } from "node:test";
import { serve } from "../src/board/server.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { stateChecks } from "../src/doctor.js";
import { openForReview } from "../src/gate/open.js";
import { allRecs, appendEvent, loadRec, transition } from "../src/state.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

// [gate] colleague_review: true by default, the step as it always was; false where nobody reviews
// as a colleague, so your-review goes straight to done and colleague-review is nowhere.
const OFF_TOML = `${TOML}\n[gate]\ncolleague_review = false\n`;
const ON_TOML = `${TOML}\n[gate]\ncolleague_review = true\n`;
const quiet = () => {};
const OFF_MSG = /colleague review is off in this workspace \(\[gate\] colleague_review = false\); from your-review an item goes to done/;

const problems = (toml: string): string[] => {
  try {
    loadConfig(join(tempWorkspace(toml), "factory.toml"), {});
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
};

// An item walked to your-review, through the CLI as the lead would.
function toYourReview(ws: string, t: string) {
  for (const args of [
    ["state", t, "building", "--agent", "bea", "--stack", "app"],
    ["state", t, "pr-open", "--pr", "acme/web#1", "--head", "abc1234abc1234"],
    ["state", t, "gate", "--force"],
    ["state", t, "your-review", "--reviewed", "abc1234abc1234"],
  ]) {
    const r = factory(ws, args);
    assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
  }
}

test("colleague_review is on by default, and a true or false is all it takes", () => {
  assert.equal(loadConfig(join(tempWorkspace(TOML), "factory.toml"), {}).gate.colleagueReview, true);
  assert.equal(loadConfig(join(tempWorkspace(ON_TOML), "factory.toml"), {}).gate.colleagueReview, true);
  assert.equal(loadConfig(join(tempWorkspace(OFF_TOML), "factory.toml"), {}).gate.colleagueReview, false);
  assert.deepEqual(problems(`${TOML}\n[gate]\ncolleague_review = "no"\n`), ['gate.colleague_review: must be true or false, got "no"']);
});

test("a jira tracker needs a colleague-review status only while the step is on", () => {
  const without = (toml: string) => toml.replace('colleague-review = "In Review"\n', "");
  assert.deepEqual(problems(without(TOML)), ["tracker.status.colleague-review: missing; the tracker needs a status for it"]);
  assert.deepEqual(problems(without(ON_TOML)), ["tracker.status.colleague-review: missing; the tracker needs a status for it"]);
  assert.deepEqual(problems(without(OFF_TOML)), []);
  assert.deepEqual(problems(OFF_TOML), [], "a status left in place is not an error");
});

test("on: your-review goes to colleague-review and on to done, as before", () => {
  const ws = tempWorkspace(ON_TOML);
  toYourReview(ws, "WEB-1");
  const r = factory(ws, ["state", "WEB-1", "colleague-review", "--evidence", "Alex asked the team"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WEB-1: your-review -> colleague-review/);
  assert.equal(factory(ws, ["state", "WEB-1", "done", "--evidence", "mergesha"]).status, 0);
});

test("off: colleague-review is refused, --force too, and your-review goes straight to done", () => {
  const ws = tempWorkspace(OFF_TOML);
  toYourReview(ws, "WEB-1");
  for (const args of [["state", "WEB-1", "colleague-review"], ["state", "WEB-1", "colleague-review", "--force"]]) {
    const r = factory(ws, args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, /WEB-1: colleague-review refused -- /);
    assert.match(r.stderr, OFF_MSG);
  }
  // A refused transition lists where the item can go, and colleague-review is not among them.
  const bad = factory(ws, ["state", "WEB-1", "gate"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /From your-review you can go to: blocked, done, fixing, off\./);
  // From blocked, which may otherwise go anywhere, it is refused too.
  assert.equal(factory(ws, ["state", "WEB-1", "blocked", "--note", "asked Alex"]).status, 0);
  assert.match(factory(ws, ["state", "WEB-1", "colleague-review"]).stderr, OFF_MSG);
  assert.equal(factory(ws, ["state", "WEB-1", "your-review"]).status, 0);
  const done = factory(ws, ["state", "WEB-1", "done", "--evidence", "mergesha"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /WEB-1: your-review -> done/);
});

test("on, the transition list still offers colleague-review", () => {
  const ws = tempWorkspace(ON_TOML);
  toYourReview(ws, "WEB-1");
  assert.match(factory(ws, ["state", "WEB-1", "gate"]).stderr, /From your-review you can go to: blocked, colleague-review, done, fixing, off\./);
});

test("off: pr-open-for-review refuses before it reads a PR", () => {
  const ws = openWorkspace(tempWorkspace(OFF_TOML));
  transition(ws, "WEB-1", "building", { agent: "bea", stack: "app" }, quiet);
  transition(ws, "WEB-1", "pr-open", { pr: "acme/web#1", head: "abc1234" }, quiet);
  transition(ws, "WEB-1", "your-review", { reviewed: "abc1234", force: true }, quiet);
  // No gh stub: had it got as far as GitHub, the error would be about reading the PR.
  assert.throws(() => openForReview(ws, "WEB-1", quiet),
    (e: Error) => /^pr-open-for-review: REFUSED -- colleague review is off in this workspace .*; nothing opened$/.test(e.message));
  // And through the CLI, with the same words and a failing exit.
  const r = factory(ws.dir, ["pr-open-for-review", "WEB-1"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, OFF_MSG);
});

test("the board has a colleague-review column only while the step is on", async () => {
  const columns = async (toml: string) => {
    const board = await serve(openWorkspace(tempWorkspace(toml)), { host: "127.0.0.1", port: 0 });
    after(() => board.close());
    return (await (await fetch(board.url + "/api")).json()).columns as string[];
  };
  const all = ["designing", "design-review", "building", "agent-review", "fixing", "gate", "your-review", "colleague-review", "blocked"];
  assert.deepEqual(await columns(TOML), all);
  assert.deepEqual(await columns(ON_TOML), all);
  assert.deepEqual(await columns(OFF_TOML), all.filter((c) => c !== "colleague-review"));
});

// An item that went into colleague-review while the switch was on, with the switch then turned off
// in factory.toml, as a human would.
function stranded(): string {
  const dir = tempWorkspace(ON_TOML);
  const on = openWorkspace(dir);
  transition(on, "WEB-1", "building", { agent: "bea", stack: "app" }, quiet);
  transition(on, "WEB-1", "colleague-review", { force: true }, quiet);
  const toml = join(dir, "factory.toml");
  writeFileSync(toml, readFileSync(toml, "utf8").replace("colleague_review = true", "colleague_review = false"));
  return dir;
}

test("doctor: off with an item left in colleague-review is MISSING, naming it; off and empty is ok; on says nothing", () => {
  const on = openWorkspace(tempWorkspace(ON_TOML));
  transition(on, "WEB-1", "building", { agent: "bea", stack: "app" }, quiet);
  transition(on, "WEB-1", "colleague-review", { force: true }, quiet);
  assert.deepEqual(stateChecks(on), [], "on: no line, whatever sits in colleague-review");

  const [left] = stateChecks(openWorkspace(stranded()));
  assert.equal(left?.status, "missing");
  assert.match(left?.what ?? "", /^no item in colleague-review: colleague review is off in this workspace .*; in it: WEB-1$/);
  assert.equal(left?.fix, "once merged, factory state <TICKET> done --evidence <merge sha>; else factory state <TICKET> fixing");

  const [ok] = stateChecks(openWorkspace(tempWorkspace(OFF_TOML)));
  assert.equal(ok?.status, "ok");
  assert.match(ok?.what ?? "", /^no item in colleague-review: colleague review is off in this workspace \(\[gate\] colleague_review = false\); from your-review an item goes to done$/);
});

test("doctor run on the command line: off with an item in colleague-review exits 1 with the MISSING line", () => {
  const r = factory(stranded(), ["doctor"]);
  assert.match(r.stdout, /^MISSING no item in colleague-review: colleague review is off in this workspace .*; in it: WEB-1 \[fix: once merged, /m);
  assert.equal(r.status, 1);
});

test("the board keeps a colleague-review column while an item is stranded in it", async () => {
  const board = await serve(openWorkspace(stranded()), { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const snap = (await (await fetch(board.url + "/api")).json()) as { columns: string[]; tickets: { ticket: string; column: string }[] };
  assert.ok(snap.columns.includes("colleague-review"), snap.columns.join(", "));
  assert.deepEqual(snap.tickets.map((t) => `${t.ticket} ${t.column}`), ["WEB-1 colleague-review"]);
});

test("records written before `reached` get it from the events log, read once until the log changes", () => {
  const dir = tempWorkspace(OFF_TOML);
  for (const t of ["WEB-1", "WEB-2", "WEB-3", "WEB-4"]) {
    assert.equal(factory(dir, ["state", t, "building"]).status, 0);
    assert.equal(factory(dir, ["state", t, "pr-open", "--pr", `acme/web#${t.slice(4)}`, "--head", "aaa1111"]).status, 0);
  }
  for (const t of ["WEB-1", "WEB-2"]) {
    assert.equal(factory(dir, ["state", t, "your-review", "--reviewed", "aaa1111", "--force"]).status, 0);
    assert.equal(factory(dir, ["state", t, "off", "--force"]).status, 0);
  }
  // Four records as written before the field: two have been in your-review, by the log only.
  for (const t of ["WEB-1", "WEB-2", "WEB-3", "WEB-4"]) {
    const f = join(dir, "state", `${t}.json`);
    const { reached, ...old } = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    assert.ok(Array.isArray(reached), t);
    writeFileSync(f, JSON.stringify(old));
  }
  const ws = openWorkspace(dir);
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (p === ws.events) reads++;
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const reachedOf = () => Object.fromEntries(allRecs(ws).map((r) => [r.ticket, r.reached]));
    const want = { "WEB-1": ["your-review"], "WEB-2": ["your-review"], "WEB-3": [], "WEB-4": [] };
    for (let i = 0; i < 3; i++) assert.deepEqual(reachedOf(), want);
    assert.deepEqual(loadRec(ws, "WEB-3")?.reached, []);
    assert.equal(reads, 1, "four old records over three snapshots and a load read the log once");
    appendEvent(ws, { t: new Date().toISOString(), ticket: "WEB-3", from: "pr-open", to: "your-review" });
    assert.deepEqual(reachedOf(), { ...want, "WEB-3": ["your-review"] });
    assert.equal(reads, 2, "a changed log is read again, once");
    // Nothing is written on a read.
    assert.equal((JSON.parse(readFileSync(join(dir, "state", "WEB-1.json"), "utf8")) as Record<string, unknown>).reached, undefined);
  } finally {
    fs.readFileSync = real;
    syncBuiltinESMExports();
  }
});
