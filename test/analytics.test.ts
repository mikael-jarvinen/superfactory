import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { projectDirFor, quantile, report, stat, TranscriptUsage, weekOf } from "../src/board/analytics.js";
import { serve } from "../src/board/server.js";
import { appendEvent, saveRec } from "../src/state.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { worktreePath } from "../src/worktree.js";
import { GROUPED, tempWorkspace } from "./helpers.js";

// A fresh workspace with a lead (ada), builders (bea, cal), a reviewer (rae) and two assistants
// (otto, nap), whose history is written with known times, and transcripts under the test's own
// claude config dir.
const NOW = Date.parse("2026-11-11T09:00:00Z");
const H = 3600;

function ev(ws: Workspace, t: string, ticket: string, from: string | null, to: string, agent: string | null) {
  appendEvent(ws, { t, ticket, from, to, agent, evidence: null, note: null, pr: null });
}

function rec(ws: Workspace, ticket: string, state: string, agent: string | null, since: string) {
  saveRec(ws, {
    ticket, state: state as never, stack: null, agent, jira: null, worktree: null, pr: null, asked_you: null,
    since, created: since, blocked_from: null, title: `${ticket} title`,
  });
}

const call = (t: string, id: string, u: Record<string, number>) =>
  JSON.stringify({ type: "assistant", timestamp: t, requestId: `req_${id}`, message: { id, role: "assistant", content: [{ type: "text", text: "x" }], usage: u } });

function transcript(cwd: string, file: string, name: string | null, lines: string[]) {
  const dir = projectDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const head = name ? [JSON.stringify({ type: "agent-name", agentName: name, sessionId: "s" })] : [];
  writeFileSync(join(dir, file), [...head, ...lines].join("\n") + "\n");
}

function workspace(): Workspace {
  const dir = tempWorkspace(GROUPED);
  const ws = openWorkspace(dir);
  // LOCAL-a: otto's, through review and a fix, waiting on the human across a week boundary.
  ev(ws, "2026-11-02T10:00:00Z", "LOCAL-a", null, "building", "otto");
  ev(ws, "2026-11-02T12:00:00Z", "LOCAL-a", "building", "pr-open", "otto");
  ev(ws, "2026-11-02T13:00:00Z", "LOCAL-a", "pr-open", "agent-review", "otto");
  ev(ws, "2026-11-02T14:00:00Z", "LOCAL-a", "agent-review", "fixing", "otto");
  ev(ws, "2026-11-02T15:00:00Z", "LOCAL-a", "fixing", "agent-review", "otto");
  ev(ws, "2026-11-08T12:00:00Z", "LOCAL-a", "agent-review", "gate", "otto");
  ev(ws, "2026-11-10T09:00:00Z", "LOCAL-a", "gate", "your-review", "otto");
  rec(ws, "LOCAL-a", "your-review", "otto", "2026-11-10T09:00:00+00:00");
  // LOCAL-b: also otto's, queued all along, so not a working state.
  ev(ws, "2026-11-02T09:00:00Z", "LOCAL-b", null, "queued", "otto");
  rec(ws, "LOCAL-b", "queued", "otto", "2026-11-02T09:00:00+00:00");
  // WEB-1: bea built it in its worktree and it is done.
  ev(ws, "2026-11-03T00:00:00Z", "WEB-1", null, "building", "bea");
  ev(ws, "2026-11-03T06:00:00Z", "WEB-1", "building", "done", "bea");
  rec(ws, "WEB-1", "done", "bea", "2026-11-03T06:00:00+00:00");
  // LOCAL-gone: its record was removed, so it no longer counts up to now.
  ev(ws, "2026-11-04T00:00:00Z", "LOCAL-gone", null, "queued", null);
  writeFileSync(ws.events, readFileSync(ws.events, "utf8") + '{"torn": \n');

  const otto = join(dir, "assistants");
  const big = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
  transcript(otto, "s1.jsonl", "otto", [
    call("2026-11-01T12:00:00Z", "m0", { output_tokens: 7000 }), // before the first change: not counted
    call("2026-11-02T09:30:00Z", "m00", { output_tokens: 7 }), // LOCAL-b, otto's only item yet, is queued
    call("2026-11-02T11:00:00Z", "m1", big),
    call("2026-11-02T11:00:01Z", "m1", { ...big, output_tokens: 12 }), // the same call's last content block, its full output
    call("2026-11-02T13:30:00Z", "m2", { output_tokens: 3 }),
    call("2026-11-02T14:30:00Z", "m3", { output_tokens: 20 }),
    call("2026-11-10T12:00:00Z", "m6", { output_tokens: 11 }), // LOCAL-a with the human
  ]);
  mkdirSync(join(projectDirFor(otto), "s1", "subagents"), { recursive: true });
  writeFileSync(join(projectDirFor(otto), "s1", "subagents", "agent-x.jsonl"), call("2026-11-02T14:45:00Z", "m4", { output_tokens: 5 }) + "\n");
  // nap shares the cwd and is never an item's agent; a session with no name is nobody's.
  transcript(otto, "s2.jsonl", "nap", [call("2026-11-02T11:00:00Z", "n1", { output_tokens: 9 })]);
  transcript(otto, "s3.jsonl", null, [call("2026-11-02T11:00:00Z", "q1", { output_tokens: 1000 })]);
  transcript(otto, "s4.jsonl", "otto-probe", [call("2026-11-02T11:00:00Z", "p1", { output_tokens: 1000 })]);
  // last written before the first change, so never read
  transcript(otto, "s5.jsonl", "otto", [call("2026-11-02T11:00:00Z", "o1", { output_tokens: 1000 })]);
  utimesSync(join(projectDirFor(otto), "s5.jsonl"), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
  // the lead is left out, whatever it was doing
  transcript(join(dir, "lead"), "l1.jsonl", "ada", [call("2026-11-02T11:00:00Z", "a1", { output_tokens: 1000 })]);
  // bea's worktree of WEB-1
  transcript(worktreePath(ws.config.repos.web!.path, "WEB-1"), "b1.jsonl", "bea", [call("2026-11-03T03:00:00Z", "b1", { output_tokens: 40 })]);
  return ws;
}

test("time, entries and tokens per item and state, and per week", () => {
  const ws = workspace();
  const r = report(ws, new TranscriptUsage(), NOW);
  const item = (k: string) => r.items.find((i) => i.ticket === k)!;
  const a = item("LOCAL-a").states;
  assert.equal(a["building"]!.seconds, 2 * H);
  assert.equal(a["pr-open"]!.seconds, H);
  assert.equal(a["agent-review"]!.entries, 2, "entered twice");
  assert.equal(a["agent-review"]!.seconds, H + (5 * 24 + 21) * H);
  assert.equal(a["fixing"]!.seconds, H);
  assert.equal(a["gate"]!.seconds, 45 * H);
  assert.equal(a["your-review"]!.seconds, 24 * H, "the current state counts up to now");
  assert.deepEqual(item("WEB-1").states["done"], { seconds: 0, entries: 1, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }, "done counts its entry only");
  assert.equal(item("LOCAL-gone").live, false);
  assert.equal(item("LOCAL-gone").states["queued"]!.seconds, 0, "an item off the board stops at its last change");
  assert.equal(item("LOCAL-b").states["queued"]!.seconds, (9 * 24) * H);

  // tokens: one call counted once with its largest counts, and not to an item its agent is free of
  assert.deepEqual(a["building"]!.tokens, { input: 100, output: 12, cache_read: 1000, cache_write: 50 });
  assert.equal(a["agent-review"]!.tokens.output, 3, "an agent's review fixes are its item's");
  assert.equal(a["your-review"]!.tokens.output, 0, "waiting on the human, the agent is free");
  assert.equal(a["fixing"]!.tokens.output, 25, "a subagent's calls are its session's");
  assert.equal(item("LOCAL-b").states["queued"]!.tokens.output, 0, "nor is a queued one");
  assert.equal(item("WEB-1").states["building"]!.tokens.output, 40, "a builder's worktree is its item's");
  assert.deepEqual(Object.keys(r.unattributed).sort(), ["nap", "otto"], "before the first change, and sessions of no fleet agent, are not counted");
  assert.equal(r.unattributed["otto"]!.output, 7 + 11, "otto's calls while its items were queued or with the human");
  assert.equal(r.unattributed["nap"]!.output, 9);
  assert.deepEqual(r.left_out.sort(), ["ada", "rae"]);

  // weeks start on Monday, UTC, and a stay counts whole in the week it ended
  assert.equal(new Date(weekOf(Date.parse("2026-11-08T23:59:00Z"))).toISOString().slice(0, 10), "2026-11-02");
  assert.deepEqual(r.weeks.map((w) => w.week), ["2026-11-02", "2026-11-09"]);
  const [w1, w2] = r.weeks;
  assert.equal(w1!.tickets, 2, "LOCAL-a and WEB-1; LOCAL-b's queue is still open");
  assert.equal(w1!.states["gate"], undefined, "the gate stay ended the next week");
  assert.equal(w2!.states["gate"]!.seconds, 45 * H, "whole, though it began the week before");
  assert.deepEqual(w1!.stats["building"]!.seconds, { n: 2, mean: 4 * H, p50: 4 * H, p80: 5.2 * H, p95: 5.8 * H });
  assert.equal(w1!.stats["agent-review"]!.seconds.mean, 142 * H, "a ticket's two stays in a state are added up");
  assert.equal(w1!.stats["agent-review"]!.entries.mean, 2);
  assert.equal(w1!.states["building"]!.tokens.output, 12 + 40);
  // open stays are in no average, and counted in the week holding now
  assert.equal(w1!.states["queued"], undefined);
  assert.deepEqual(w1!.open, {});
  assert.deepEqual(w2!.open, { "queued": { n: 1, longest: 216 * H }, "your-review": { n: 1, longest: 24 * H } });
  assert.equal(w2!.stats["your-review"], undefined);
  assert.deepEqual(r.all.open, w2!.open);
  assert.equal(r.all.tickets, 2, "LOCAL-gone's last state has no end, so it is in no average");
  assert.equal(r.all.stats["gate"]!.seconds.mean, 45 * H);
  assert.equal(r.all.total!.seconds.mean, (2 + 1 + 142 + 1 + 45 + 6) * H / 2);
});

test("a transcript is read on from where it stopped, and a call is still counted once", () => {
  const ws = workspace();
  const usage = new TranscriptUsage();
  report(ws, usage, NOW);
  const f = join(projectDirFor(join(ws.dir, "assistants")), "s1.jsonl");
  writeFileSync(f, readFileSync(f, "utf8") + call("2026-11-02T14:31:00Z", "m3", { output_tokens: 20 }) + "\n" +
    call("2026-11-02T14:40:00Z", "m5", { output_tokens: 100 }) + "\n");
  const r = report(ws, usage, NOW);
  assert.equal(r.items.find((i) => i.ticket === "LOCAL-a")!.states["fixing"]!.tokens.output, 125);
});

test("the page and its JSON are served, and the page renders them at phone width", async () => {
  const ws = workspace();
  process.env.CLAUDE_BIN = join(ws.dir, "bin", "claude");
  const b = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => b.close());
  const page = await (await fetch(`${b.url}/analytics`)).text();
  assert.match(page, /analytics\.js/);
  const d = await (await fetch(`${b.url}/api/analytics`)).json();
  assert.deepEqual(d.items.map((i: { ticket: string }) => i.ticket).sort(), ["LOCAL-a", "LOCAL-b", "LOCAL-gone", "WEB-1"]);

  const dom = new JSDOM(page.replace(/<script src[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: `${b.url}/analytics`, pretendToBeVisual: true });
  after(() => dom.window.close());
  const w = dom.window;
  let down = false;
  const ticks: (() => Promise<void>)[] = [];
  Object.assign(w, {
    fetch: async (u: string) => (u.startsWith("/api/analytics") && !down ? { ok: true, json: async () => d } : { ok: false, status: 500, json: async () => ({ error: "boom" }) }),
    matchMedia: () => ({ matches: true }), innerWidth: 375,
    setInterval: (fn: () => Promise<void>, ms: number) => (ms === 30000 && ticks.push(fn), 0),
  });
  const ctx = dom.getInternalVMContext();
  for (const f of ["common.js", "analytics.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(ctx);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  const doc = w.document;
  for (const end = Date.now() + 5000; !doc.querySelector(".wk");) {
    if (Date.now() > end) assert.fail("the page never rendered");
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(doc.querySelectorAll('header nav a[href="/analytics"]').length, 1, "one analytics link");
  // all time first: one bar, labelled, of averages per ticket
  assert.equal(doc.querySelectorAll(".wk").length, 1);
  assert.match(doc.querySelector(".wk")!.textContent!, /^All time.*2 tickets/);
  assert.match(doc.getElementById("barsh")!.textContent!, /Average time per ticket, all time/);
  assert.equal(doc.querySelector("tbody tr td.k b")!.textContent, "LOCAL-b", "the most time first: queued an hour before LOCAL-a started");
  (doc.querySelector('[data-metric="tokens"]') as HTMLElement).click();
  assert.equal(doc.querySelector("tbody tr td.k b")!.textContent, "LOCAL-a");
  assert.match(doc.querySelector("tbody tr")!.textContent!, /1\.2k/, "LOCAL-a's tokens: 1162 + 25");
  const f = doc.getElementById("find") as HTMLInputElement;
  f.value = "web-1";
  f.dispatchEvent(new w.Event("input"));
  assert.deepEqual([...doc.querySelectorAll("tbody td.k b")].map((x) => x.textContent), ["WEB-1"]);
  // a refresh leaves the filter as it is, caret and all, and the table where it was scrolled to
  f.value = "local";
  f.setSelectionRange(2, 2);
  f.dispatchEvent(new w.Event("input"));
  (doc.querySelector(".tbl") as HTMLElement).scrollLeft = 120;
  const later = structuredClone(d);
  later.items.find((i: { ticket: string }) => i.ticket === "LOCAL-a").states["your-review"].seconds += 86400;
  const old = doc.querySelector(".tbl");
  (w as unknown as { render: (x: unknown) => void }).render(later);
  assert.notEqual(doc.querySelector(".tbl"), old, "the table was rebuilt");
  assert.equal(doc.getElementById("find"), f, "the same input");
  assert.equal(f.selectionStart, 2);
  assert.equal((doc.querySelector(".tbl") as HTMLElement).scrollLeft, 120);
  // a report that fails leaves the last good one, and says so
  const at = doc.getElementById("at")!.textContent;
  const table = doc.querySelector(".tbl")!.innerHTML;
  down = true;
  assert.equal(ticks.length, 1);
  await ticks[0]!();
  assert.equal(doc.getElementById("at")!.textContent, "not answering");
  assert.notEqual(at, "not answering");
  assert.equal(doc.querySelector(".tbl")!.innerHTML, table);
  // the page's own stylesheet keeps the item table, the one wide thing, in a box of its own
  const css = readFileSync(new URL("../src/board/static/analytics.css", import.meta.url), "utf8");
  assert.match(css, /\.tbl\{overflow-x:auto/);
});

test("done counts no time, even for an item forced back out of it", () => {
  const ws = openWorkspace(tempWorkspace(GROUPED));
  ev(ws, "2026-11-05T00:00:00Z", "LOCAL-re", null, "building", null);
  ev(ws, "2026-11-05T01:00:00Z", "LOCAL-re", "building", "done", null);
  ev(ws, "2026-11-06T01:00:00Z", "LOCAL-re", "done", "building", null);
  ev(ws, "2026-11-06T02:00:00Z", "LOCAL-re", "building", "done", null);
  rec(ws, "LOCAL-re", "done", null, "2026-11-06T02:00:00+00:00");
  const s = report(ws, new TranscriptUsage(), NOW).items[0]!.states;
  assert.equal(s["done"]!.seconds, 0);
  assert.equal(s["done"]!.entries, 2);
  assert.equal(s["building"]!.seconds, 2 * H);
});

test("the lead's and reviewers' sessions are not counted, even in an agent's cwd", () => {
  const ws = workspace();
  const shared = join(ws.dir, "assistants");
  transcript(shared, "lead.jsonl", "ada", [call("2026-11-01T12:00:00Z", "x1", { output_tokens: 1 }), call("2026-11-02T11:00:00Z", "x2", { output_tokens: 500 })]);
  transcript(shared, "rev.jsonl", "rae", [call("2026-11-02T11:00:00Z", "x3", { output_tokens: 500 })]);
  const r = report(ws, new TranscriptUsage(), NOW);
  assert.deepEqual(Object.keys(r.unattributed).sort(), ["nap", "otto"]);
  assert.equal(r.items.find((i) => i.ticket === "LOCAL-a")!.states["building"]!.tokens.output, 12);
});

test("the nav link reaches every other page through common.js", () => {
  for (const f of ["board.html", "messages.html", "tickets.html", "wiki.html"]) {
    const html = readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8");
    assert.match(html, /\/static\/common\.js/, `${f} loads common.js`);
  }
});

test("percentiles: none, one, two and a few values", () => {
  assert.ok(Number.isNaN(quantile([], 0.5)));
  assert.equal(stat([]), null, "no tickets make no figures");
  assert.deepEqual(stat([7]), { n: 1, mean: 7, p50: 7, p80: 7, p95: 7 }, "one ticket is every percentile of itself");
  const two = stat([10, 0])!;
  assert.deepEqual([two.n, two.mean, two.p50], [2, 5, 5], "sorted first; the median of two is their mean");
  assert.ok(Math.abs(two.p80 - 8) < 1e-9 && Math.abs(two.p95 - 9.5) < 1e-9, "between the two, by rank");
  // 1..5: ranks 0..4, so p80 sits at rank 3.2 and p95 at 3.8
  const five = stat([5, 3, 1, 4, 2])!;
  assert.equal(five.mean, 3);
  assert.equal(five.p50, 3);
  assert.ok(Math.abs(five.p80 - 4.2) < 1e-9);
  assert.ok(Math.abs(five.p95 - 4.8) < 1e-9);
  // a long tail moves p95 and the mean, not the median
  const tail = stat([1, 1, 1, 1, 100])!;
  assert.equal(tail.p50, 1);
  assert.ok(tail.mean > 20 && tail.p95 > 80);
});

test("a stay counts whole in the week and month it ended, across a year end too", () => {
  const ws = openWorkspace(tempWorkspace(GROUPED));
  // Friday noon to the next Tuesday noon: over the month's end (Sunday) and the week's (Monday)
  ev(ws, "2026-10-30T12:00:00Z", "LOCAL-x", null, "building", null);
  ev(ws, "2026-11-03T12:00:00Z", "LOCAL-x", "building", "done", null);
  // over a year's end, forced out of done and back, so building twice in the same week and month
  ev(ws, "2026-12-31T20:00:00Z", "LOCAL-y", null, "building", null);
  ev(ws, "2027-01-01T04:00:00Z", "LOCAL-y", "building", "done", null);
  ev(ws, "2027-01-02T00:00:00Z", "LOCAL-y", "done", "building", null);
  ev(ws, "2027-01-02T01:00:00Z", "LOCAL-y", "building", "done", null);
  rec(ws, "LOCAL-x", "done", null, "2026-11-03T12:00:00+00:00");
  rec(ws, "LOCAL-y", "done", null, "2027-01-02T01:00:00+00:00");
  const r = report(ws, new TranscriptUsage(), Date.parse("2027-01-15T00:00:00Z"));
  const wk = (k: string) => r.weeks.find((w) => w.week === k)!;
  const mo = (k: string) => r.months.find((m) => m.month === k)!;
  assert.equal(wk("2026-10-26").stats["building"], undefined, "nothing ended the week it began");
  assert.deepEqual(wk("2026-11-02").stats["building"]!.seconds, { n: 1, mean: 96 * H, p50: 96 * H, p80: 96 * H, p95: 96 * H });
  assert.equal(mo("2026-10").stats["building"], undefined);
  assert.equal(mo("2026-11").states["building"]!.seconds, 96 * H);
  assert.equal(mo("2026-12").tickets, 0, "the year-end stay ended in January");
  assert.equal(mo("2027-01").stats["building"]!.seconds.mean, 9 * H, "8h and 1h, one ticket");
  assert.equal(mo("2027-01").stats["building"]!.entries.mean, 2);
  assert.equal(wk("2026-12-28").stats["building"]!.seconds.n, 1);
  assert.equal(mo("2027-01").stats["done"]!.seconds.mean, 0, "done counts no time");
  assert.equal(mo("2027-01").stats["done"]!.entries.mean, 2);
  // a past period does not change as time goes on
  const later = report(ws, new TranscriptUsage(), Date.parse("2027-03-01T00:00:00Z"));
  assert.deepEqual(later.months.find((m) => m.month === "2026-11"), mo("2026-11"));
});

test("a period with nothing in it is listed empty, up to the one holding now", () => {
  const ws = openWorkspace(tempWorkspace(GROUPED));
  ev(ws, "2026-11-03T00:00:00Z", "WEB-1", null, "building", null);
  ev(ws, "2026-11-03T06:00:00Z", "WEB-1", "building", "done", null);
  rec(ws, "WEB-1", "done", null, "2026-11-03T06:00:00+00:00");
  const r = report(ws, new TranscriptUsage(), Date.parse("2027-01-06T00:00:00Z"));
  assert.deepEqual(r.weeks.map((w) => w.week), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28", "2027-01-04"]);
  const none = { states: {}, tickets: 0, stats: {}, total: null, open: {} };
  for (const w of r.weeks.slice(1)) assert.deepEqual({ ...w, week: undefined }, { ...none, week: undefined });
  assert.deepEqual(r.months.map((m) => m.month), ["2026-11", "2026-12", "2027-01"]);
  assert.deepEqual({ ...r.months[1]!, month: undefined }, { ...none, month: undefined });

  // a fresh workspace, with no history at all, has the current week and month, empty
  const fresh = report(openWorkspace(tempWorkspace(GROUPED)), new TranscriptUsage(), Date.parse("2026-11-17T10:00:00Z"));
  assert.deepEqual(fresh.weeks, [{ week: "2026-11-16", ...none }]);
  assert.deepEqual(fresh.months, [{ month: "2026-11", ...none }]);
  assert.deepEqual(fresh.all, none);
  assert.deepEqual(fresh.items, []);
});

// The page against a report given to it, at phone width.
async function page(d: unknown) {
  const html = readFileSync(new URL("../src/board/static/analytics.html", import.meta.url), "utf8");
  const dom = new JSDOM(html.replace(/<script src[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "http://board.test/analytics", pretendToBeVisual: true });
  after(() => dom.window.close());
  const w = dom.window;
  const state = { down: false, ticks: [] as (() => Promise<void>)[] };
  Object.assign(w, {
    fetch: async (u: string) => (u.startsWith("/api/analytics") && !state.down ? { ok: true, json: async () => d } : { ok: false, status: 500, json: async () => ({}) }),
    matchMedia: () => ({ matches: true }), innerWidth: 375,
    setInterval: (fn: () => Promise<void>, ms: number) => (ms === 30000 && state.ticks.push(fn), 0),
  });
  const ctx = dom.getInternalVMContext();
  for (const f of ["common.js", "analytics.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(ctx);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  for (const end = Date.now() + 5000; !w.document.getElementById("periods")?.children.length;) {
    if (Date.now() > end) assert.fail("the page never rendered");
    await new Promise((r) => setTimeout(r, 20));
  }
  return { w, doc: w.document, state };
}

const rows = (doc: Document) => [...doc.querySelectorAll("#ptable tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()));
const click = (doc: Document, sel: string) => (doc.querySelector(sel) as HTMLElement).click();

test("week and month: labelled bars of averages, a tooltip of the spread, and the change from the period before", async () => {
  const d = JSON.parse(JSON.stringify(report(workspace(), new TranscriptUsage(), Date.parse("2026-11-18T09:00:00Z"))));
  const { doc, state } = await page(d);
  assert.equal(doc.getElementById("per")!.hidden, true, "all time first, as before");
  click(doc, '[data-period="week"]');
  assert.equal(doc.getElementById("all")!.hidden, true);
  assert.deepEqual([...doc.querySelectorAll(".wk .d")].map((x) => x.textContent), ["Week of 16 Nov so far", "Week of 9 Nov", "Week of 2 Nov"]);
  assert.deepEqual([...doc.querySelectorAll(".wk .v")].map((x) => x.textContent), ["0 tickets", "1 ticket", "2 tickets"]);
  assert.match(doc.querySelector(".wk .open")!.textContent!, /still in: queued 1, your-review 1/);
  // a tap on a segment shows the state's spread in real units, and a second tap hides it; a tap
  // focuses the segment just before its click, and that must not count as the first of two taps
  (doc.querySelector('.wk:nth-child(3) .stk i[data-s="building"]') as HTMLElement).focus();
  click(doc, '.wk:nth-child(3) .stk i[data-s="building"]');
  const tip = doc.getElementById("tip")!;
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent!, /building/);
  assert.match(tip.textContent!, /Week of 2 Nov/);
  assert.match(tip.textContent!, /average4\.0h/);
  assert.match(tip.textContent!, /median4\.0h/);
  assert.match(tip.textContent!, /p805\.2h/);
  assert.match(tip.textContent!, /p955\.8h/);
  assert.match(tip.textContent!, /n2 tickets/);
  click(doc, '.wk:nth-child(3) .stk i[data-s="building"]');
  assert.equal(tip.hidden, true);
  // the table: averages per ticket, newest first, with the change from the week before
  const r = rows(doc);
  assert.deepEqual(r.map((x) => x[0]), ["Week of 16 Novso far", "Week of 9 Nov", "Week of 2 Nov"]);
  const col = (name: string) => [...doc.querySelectorAll("#ptable thead th")].findIndex((th) => th.textContent === name);
  assert.equal(r[2]![col("tickets")], "2", "the oldest has no week before");
  assert.equal(r[1]![col("tickets")], "1↓1");
  assert.equal(r[1]![col("gate")], "45.0h↑45.0h", "none the week before: the change is by how much");
  assert.equal(r[2]![col("building")], "4.0h");
  assert.equal(r[1]![col("building")], "\u00b7", "no stay ended in building: no figure, so no made-up drop");
  assert.equal(r[0]![col("your-review")], "·1 still in");
  assert.equal(doc.querySelectorAll("#ptable tbody tr:first-child .dl").length, 0, "the running week shows no change");
  assert.equal(r[0]![col("tickets")], "\u00b7", "its own figures still show, with no arrow");
  // the trend cards are averages per ticket too, and pick the measure
  assert.equal(doc.querySelectorAll(".trend").length, 4);
  assert.match(doc.querySelector(".trend")!.textContent!, /avg per ticket, so far/);
  assert.equal(doc.querySelectorAll(".trend .dl").length, 0, "nor do the trend cards while it runs");
  // the running week is empty: it has no figure, so it carries no point rather than dipping to 0
  assert.match(doc.querySelector(".trend .tv")!.textContent!, /^\u00b7/);
  assert.equal(doc.querySelectorAll(".trend polyline.so").length, 0, "no dashed line to an empty week");
  assert.equal(doc.querySelectorAll(".trend polyline").length, 4, "the finished weeks make one line each");
  click(doc, '.trend[data-metric="entries"]');
  assert.equal(doc.querySelector('#metrics [data-metric="entries"]')!.getAttribute("aria-pressed"), "true");
  assert.match(doc.getElementById("barsh")!.textContent!, /Average entries per ticket, by week/);
  click(doc, '[data-period="month"]');
  assert.deepEqual([...doc.querySelectorAll(".wk .d")].map((x) => x.textContent), ["November 2026 so far"]);
  assert.equal(doc.querySelectorAll(".trend svg").length, 0, "one month makes no line");
  // a failed fetch keeps the last good view
  const table = doc.getElementById("ptable")!.innerHTML;
  state.down = true;
  await state.ticks[0]!();
  assert.equal(doc.getElementById("at")!.textContent, "not answering");
  assert.equal(doc.getElementById("ptable")!.innerHTML, table);
});

test("a fresh workspace's page shows the current period empty", async () => {
  const d = JSON.parse(JSON.stringify(report(openWorkspace(tempWorkspace(GROUPED)), new TranscriptUsage(), Date.parse("2026-11-17T10:00:00Z"))));
  const { doc } = await page(d);
  assert.match(doc.getElementById("weeks")!.textContent!, /No transitions recorded yet/);
  for (const p of ["week", "month"]) {
    click(doc, `[data-period="${p}"]`);
    const r = rows(doc);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0]!.slice(1), ["·"], "no tickets and no state columns");
    assert.match(doc.getElementById("trends")!.textContent!, /time\u00b7 avg per ticket, so far/);
  }
});
