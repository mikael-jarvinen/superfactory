import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { projectDirFor, report, TranscriptUsage, weekOf } from "../src/board/analytics.js";
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

  // weeks start on Monday, UTC, and a wait is split across the weeks it spans
  assert.equal(new Date(weekOf(Date.parse("2026-11-08T23:59:00Z"))).toISOString().slice(0, 10), "2026-11-02");
  assert.deepEqual(r.weeks.map((w) => w.week), ["2026-11-02", "2026-11-09"]);
  const [w1, w2] = r.weeks;
  assert.equal(w1!.states["gate"]!.seconds, 12 * H);
  assert.equal(w2!.states["gate"]!.seconds, 33 * H);
  assert.equal(w1!.states["gate"]!.entries, 1);
  assert.equal(w2!.states["gate"]!.entries ?? 0, 0);
  assert.equal(w1!.states["building"]!.tokens.output, 12 + 40);
  assert.equal(w1!.states["queued"]!.seconds, (6 * 24 + 15) * H, "LOCAL-b's queue in its first week");
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
  Object.assign(w, { fetch: async (u: string) => (u.startsWith("/api/analytics") ? { ok: true, json: async () => d } : { ok: false }), matchMedia: () => ({ matches: true }), innerWidth: 375 });
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
  // served, the report runs to the real now, so the weeks run on to this one
  assert.equal(doc.querySelectorAll(".wk").length, d.weeks.length);
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
  // the page's own stylesheet keeps the item table, the one wide thing, in a box of its own
  const css = readFileSync(new URL("../src/board/static/analytics.css", import.meta.url), "utf8");
  assert.match(css, /\.tbl\{overflow-x:auto/);
});

test("the nav link reaches every other page through common.js", () => {
  for (const f of ["board.html", "messages.html", "tickets.html", "wiki.html"]) {
    const html = readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8");
    assert.match(html, /\/static\/common\.js/, `${f} loads common.js`);
  }
});
