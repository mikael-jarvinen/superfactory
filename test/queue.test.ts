import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { handledFile, markHandled, queue, queueCards } from "../src/board/queue.js";
import { serve } from "../src/board/server.js";
import { say } from "../src/messages.js";
import { transition } from "../src/state.js";
import { firstSentence, pyDumps, wrap } from "../src/util.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { factory, tempDir, tempWorkspace } from "./helpers.js";

const noInboxLock = process.platform !== "darwin" && process.platform !== "linux" && "the inbox lock is built for macOS and Linux only";

function workspace(opts: { since?: false } = {}): Workspace {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  mkdirSync(ws.stateDir, { recursive: true });
  // A queue that has been on since before any of these rows; the first-read start has a test of its own.
  if (opts.since !== false) writeHandledFile(ws, { start: "2000-01-01T00:00:00Z", handled: {} });
  return ws;
}
const writeHandledFile = (ws: Workspace, v: unknown) => {
  mkdirSync(ws.logsDir, { recursive: true });
  writeFileSync(handledFile(ws), typeof v === "string" ? v : JSON.stringify(v));
};
const row = (ws: Workspace, t: string, kind: string, text: string, ticket: string | null = null, file = ws.messages) =>
  appendFileSync(file, pyDumps({ t, text, ticket, kind, link: null }) + "\n");
const rec = (ws: Workspace, ticket: string, state: string, asked: { question: string; at: string } | null = null) =>
  writeFileSync(join(ws.stateDir, `${ticket}.json`), JSON.stringify({ ticket, state, asked_you: asked, since: asked?.at ?? null }));
const unblock = (ws: Workspace, t: string, ticket: string, to = "building") =>
  appendFileSync(ws.events, pyDumps({ t, ticket, from: "blocked", to }) + "\n");
const move = (ws: Workspace, t: string, ticket: string, from: string, to: string) =>
  appendFileSync(ws.events, pyDumps({ t, ticket, from, to }) + "\n");
const T = (m: number) => `2026-11-16T12:${String(m).padStart(2, "0")}:00+00:00`;

test("queue: the lead's decision and blocked rows, oldest first, older than the thread shows too", () => {
  const ws = workspace();
  row(ws, T(1), "decision", "rolled away long ago", null, ws.messages + ".1");
  row(ws, T(2), "note", "just news");
  row(ws, T(3), "blocked", "which db?", "LOCAL-db");
  row(ws, T(4), "human", "not a question for me");
  row(ws, T(5), "alex", "the legacy human kind is the human's too");
  row(ws, T(6), "decision", "ship on friday?", "LOCAL-ship");
  for (let i = 0; i < 80; i++) row(ws, T(7), "note", `filler ${i}`);
  const q = queue(ws);
  assert.deepEqual(q.map((i) => [i.kind, i.ticket, i.text]), [
    ["decision", null, "rolled away long ago"], ["blocked", "LOCAL-db", "which db?"], ["decision", "LOCAL-ship", "ship on friday?"],
  ]);
  assert.ok(q.every((i) => i.from === "message" && i.t === i.at));
  assert.equal(new Set(q.map((i) => i.id)).size, 3);
});

test("queue: a blocked question leaves once its ticket leaves blocked after it, and so does a decision", () => {
  const ws = workspace();
  unblock(ws, T(0), "LOCAL-a"); // an earlier episode: the question after it is still open
  row(ws, T(1), "blocked", "a?", "LOCAL-a");
  row(ws, T(2), "blocked", "b?", "LOCAL-b");
  row(ws, T(3), "decision", "c?", "LOCAL-b");
  row(ws, T(3), "decision", "d?", "LOCAL-a");
  rec(ws, "LOCAL-a", "blocked", { question: "a?", at: T(1) });
  rec(ws, "LOCAL-b", "building");
  unblock(ws, T(4), "LOCAL-b");
  assert.deepEqual(queue(ws).map((i) => i.text), ["a?", "d?"]);
});

// Mikael, 2026-11-20: seven items waiting, five of them decisions on CL-2446 answered on 16 Nov,
// back the moment the lead blocked the ticket.
test("queue: a decision leaves once its ticket moves past it, and blocking the ticket later never brings it back", () => {
  const ws = workspace();
  row(ws, T(1), "decision", "design A or B?", "LOCAL-d");
  move(ws, T(2), "LOCAL-d", "designing", "design-review"); // parked to wait for the answer
  move(ws, T(3), "LOCAL-d", "design-review", "design-review"); // recorded again: no move
  assert.deepEqual(queue(ws).map((i) => i.text), ["design A or B?"], "a move to where it waits on the human keeps it");
  move(ws, T(4), "LOCAL-d", "design-review", "building");
  assert.deepEqual(queue(ws), [], "the ticket moved on past it");
  move(ws, T(5), "LOCAL-d", "building", "blocked");
  rec(ws, "LOCAL-d", "blocked", { question: "which API key?", at: T(5) });
  assert.deepEqual(queue(ws).map((i) => [i.from, i.text]), [["board", "which API key?"]]);

  row(ws, T(6), "decision", "ship it friday?", "LOCAL-e");
  row(ws, T(7), "answer", "an answer on another ticket", "LOCAL-other");
  row(ws, T(7), "answer", "an answer on no ticket");
  assert.deepEqual(queue(ws).map((i) => i.text), ["which API key?", "ship it friday?"]);
  row(ws, T(8), "answer", "Done: shipping friday, as you said.", "LOCAL-e");
  assert.deepEqual(queue(ws).map((i) => i.text), ["which API key?"], "the lead answered on its ticket");
});

test("queue: turned on with history, an old decision stays out when its ticket is blocked, and the row a block was asked with comes in", () => {
  const ws = workspace({ since: false });
  // Never moved on in the events log, so only the start keeps it out.
  row(ws, "2026-01-01T09:00:00+00:00", "decision", "an old decision", "LOCAL-old");
  rec(ws, "LOCAL-old", "blocked", { question: "a new block", at: "2026-01-05T09:00:00+00:00" });
  // The block's question was posted as a decision, a few minutes before the block was recorded.
  row(ws, "2026-01-03T08:58:00+00:00", "decision", "posted with its block", "LOCAL-asked");
  rec(ws, "LOCAL-asked", "blocked", { question: "posted with its block", at: "2026-01-03T09:00:00+00:00" });
  assert.deepEqual(queue(ws).map((i) => [i.from, i.text]), [["message", "posted with its block"], ["board", "a new block"]]);
});

test("queue: a blocked record whose question never reached the thread is on it, once", () => {
  const ws = workspace();
  rec(ws, "LOCAL-quiet", "blocked", { question: "only on the board", at: T(2) });
  rec(ws, "LOCAL-said", "blocked", { question: "also in the thread", at: T(3) });
  rec(ws, "LOCAL-busy", "building");
  row(ws, T(1), "decision", "said in the thread", "LOCAL-said");
  const q = queue(ws);
  assert.deepEqual(q.map((i) => [i.from, i.ticket, i.text, i.t, i.at]), [
    ["message", "LOCAL-said", "said in the thread", T(1), T(1)],
    ["board", "LOCAL-quiet", "only on the board", null, T(2)],
  ]);
  // Blocked again after it was answered: the old row was answered when the ticket left blocked, and
  // the record is the new question.
  unblock(ws, T(4), "LOCAL-said");
  rec(ws, "LOCAL-said", "blocked", { question: "a second question", at: T(5) });
  assert.deepEqual(queue(ws).map((i) => i.text), ["only on the board", "a second question"]);
});

test("queue: the page marks an item handled; reading the thread or writing in it does not", { skip: noInboxLock }, async () => {
  const ws = workspace();
  row(ws, T(1), "decision", "ship on friday?", "LOCAL-ship");
  row(ws, T(2), "blocked", "which db?", "LOCAL-db");
  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const page = { "Content-Type": "application/json", "Origin": board.url };
  type Card = { id: string; questions: { id: string; text: string; in_thread: boolean }[] };
  const get = async () => (await (await fetch(board.url + "/api/messages")).json()) as { queue: Card[]; messages: { qid?: string; text: string }[] };
  const handle = (id: unknown, headers: Record<string, string> = page) =>
    fetch(board.url + "/api/messages/handled", { method: "POST", headers, body: JSON.stringify({ id }) });

  const d = await get();
  assert.deepEqual(d.queue.map((c) => c.questions.map((q) => [q.text, q.in_thread])), [[["ship on friday?", true]], [["which db?", true]]]);
  // Each card's question names its message in the thread by the same id.
  assert.deepEqual(d.queue.map((c) => d.messages.find((m) => m.qid === c.id)?.text), ["ship on friday?", "which db?"]);

  assert.equal((await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ text: "yes, friday" }) })).status, 200);
  await get();
  assert.equal((await get()).queue.length, 2, "a message in the thread and a read leave the queue as it was");

  const id = d.queue[0]!.id;
  for (const bad of ["m000000000000", "nope", 42, null]) assert.equal((await handle(bad)).status, 400, `refused: ${String(bad)}`);
  assert.equal((await handle(id, { "Content-Type": "application/json", "Origin": "https://elsewhere.example" })).status, 403);
  assert.equal((await get()).queue.length, 2);

  assert.equal((await handle(id)).status, 200);
  assert.deepEqual((await get()).queue.map((c) => c.questions[0]!.text), ["which db?"]);
  assert.ok(id in JSON.parse(readFileSync(handledFile(ws), "utf8")).handled, "kept in logs/");
  assert.equal((await handle(id)).status, 200, "handled twice is still handled");
});

// /messages as the page runs it, with the panel: GET /api/messages answers `data`, and every POST is recorded.
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));
async function messagesPage(data: object) {
  const html = readFileSync(new URL("../src/board/static/messages.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://board.test/messages" });
  windows.push(dom);
  const w = dom.window;
  const s = { data, posts: [] as [string, Record<string, unknown>][], handledStatus: 200, hold: null as Promise<void> | null };
  Object.defineProperty(w.document, "visibilityState", { get: () => "hidden" });
  Object.assign(w, {
    scrollTo: () => {},
    fetch: async (url: string, o?: { method?: string; body?: string }) => {
      if (o?.method === "POST") {
        s.posts.push([url, JSON.parse(o.body ?? "{}")]);
        if (url === "/api/messages" && s.hold) await s.hold;
        const status = url === "/api/messages/handled" ? s.handledStatus : 200;
        return { ok: status < 300, status, json: async () => (status < 300 ? { ok: true } : { ok: false, error: "nothing in the queue has that id" }) };
      }
      return { ok: true, status: 200, json: async () => structuredClone(s.data) };
    },
  });
  const ctx = dom.getInternalVMContext();
  for (const f of ["common.js", "marked.umd.js", "purify.min.js", "markdown.js", "messages.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(ctx);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  return { s, w, doc: w.document, settle };
}

// A card as GET /api/messages serves it: one posted question, or only a blocked note.
const card = (id: string, text: string, o: { in_thread?: boolean; ticket?: string | null; unposted?: boolean } = {}) => o.unposted
  ? { id, ids: [id], ticket: o.ticket ?? null, kinds: ["blocked"], at: T(1), last: T(1), age_min: 5, questions: [], blocked: { id, at: T(1), note: text }, unposted: true }
  : { id, ids: [id], ticket: o.ticket ?? null, kinds: ["decision"], at: T(1), last: T(1), age_min: 5, blocked: null, unposted: false,
    questions: [{ id, t: T(1), kind: "decision", text, link: null, in_thread: !!o.in_thread }] };

test("the message page: a shut panel with a count, a link into the thread, handled and reply", async () => {
  const item = (id: string, text: string, in_thread: boolean, ticket: string | null = null) => card(id, text, { in_thread, ticket });
  const { s, doc, w, settle } = await messagesPage({
    at: "12:00", human: "Alex", lead: "niilo", lead_avatar: null, status: "idle", seen: null,
    messages: [{ t: T(1), kind: "decision", text: "ship on friday?", ticket: "LOCAL-ship", from: "lead", qid: "maaaaaaaaaaaa", age_min: 5 }],
    queue: [item("maaaaaaaaaaaa", "ship on friday?", true, "LOCAL-ship"), item("mbbbbbbbbbbbb", "## old one\nwith **more** words", false)],
  });
  const panel = doc.getElementById("queue") as HTMLDetailsElement;
  assert.equal(panel.open, false, "shut until opened");
  assert.equal(doc.getElementById("qcount")!.textContent, "2");
  const rows = [...doc.querySelectorAll(".qi")];
  assert.deepEqual(rows.map((r) => r.querySelector(".qbody")!.textContent!.trim()), ["ship on friday?", "old one\nwith more words"]);
  assert.equal(rows[0]!.querySelector(".tk")!.textContent, "LOCAL-ship");
  assert.equal(rows[0]!.querySelector("a.qgo")!.getAttribute("href"), "#q-maaaaaaaaaaaa");
  assert.ok(doc.getElementById("q-maaaaaaaaaaaa"), "the message in the thread carries the anchor");
  // The question is shown whole, without a click: Mikael, 2026-11-24, "it always collapses the message".
  assert.match(rows[1]!.querySelector(".qbody")!.innerHTML, /<strong>more<\/strong>/);
  assert.equal(rows[1]!.querySelector("a.qgo"), null, "not in the thread: no link to it");

  (doc.querySelector('[data-done="mbbbbbbbbbbbb"]') as HTMLElement).click();
  await settle();
  assert.deepEqual(s.posts, [["/api/messages/handled", { id: "mbbbbbbbbbbbb" }]]);

  // A reply from the panel quotes the question, and once sent marks it handled.
  (doc.querySelector('[data-reply="maaaaaaaaaaaa"]') as HTMLElement).click();
  const t = doc.getElementById("t") as HTMLTextAreaElement;
  assert.equal(t.value, "> LOCAL-ship: ship on friday?\n\n");
  assert.equal(doc.getElementById("replying")!.hidden, false);
  t.value += "yes";
  doc.getElementById("f")!.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  assert.deepEqual(s.posts.slice(1).map(([u, b]) => [u, b.id ?? b.text]), [
    ["/api/messages", "> LOCAL-ship: ship on friday?\n\nyes"], ["/api/messages/handled", "maaaaaaaaaaaa"],
  ]);
  assert.equal(doc.getElementById("replying")!.hidden, true);

  // A plain message marks nothing.
  t.value = "unrelated";
  doc.getElementById("f")!.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  assert.deepEqual(s.posts.at(-1), ["/api/messages", { text: "unrelated", images: [] }]);
  assert.equal(s.posts.length, 4);
});

test("queue: a fresh workspace with only the config it must have, its own names and its own state dir", { skip: noInboxLock }, async () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  // No legacy kind, no tracker, its own human and lead, state and logs where this workspace puts them.
  writeFileSync(join(dir, "factory.toml"), `[human]\nname = "Robin"\n\n[paths]\nrepos = "repos"\nstate = "data/st"\nlogs = "data/lg"\n\n[roles.lead]\ncwd = "lead"\nsettings = "lead"\n\n[[agents]]\nname = "kai"\nrole = "lead"\n`);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  process.env.SF_NOTIFY = "0";
  const ws = openWorkspace(dir);
  assert.equal(ws.stateDir, join(dir, "data", "st"));
  const quiet = () => {};
  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  type Card = { id: string; unposted: boolean; questions: { text: string }[]; blocked: { note: string } | null };
  const get = async () => ((await (await fetch(board.url + "/api/messages")).json()) as { human: string; lead: string; queue: Card[] });
  assert.deepEqual((await get()).queue, [], "nothing yet, and the first read sets the queue's start");
  // The lead's real writers: `factory say` and `factory state`.
  say(ws, ["pick a colour?"], { kind: "decision", ticket: "LOCAL-colour" }, quiet);
  say(ws, ["just news"], { kind: "note" }, quiet);
  transition(ws, "LOCAL-key", "designing", {}, quiet);
  transition(ws, "LOCAL-key", "blocked", { note: "need the key" }, quiet);
  const d = await get();
  assert.deepEqual([d.human, d.lead], ["Robin", "kai"]);
  assert.deepEqual(d.queue.map((c) => [c.unposted, c.questions[0]?.text ?? c.blocked?.note]), [[false, "pick a colour?"], [true, "need the key"]]);

  const r = await fetch(board.url + "/api/messages/handled", { method: "POST", headers: { "Content-Type": "application/json", "Origin": board.url }, body: JSON.stringify({ id: d.queue[0]!.id }) });
  assert.deepEqual((await get()).queue.map((c) => c.blocked?.note), ["need the key"]);
  assert.equal(r.status, 200);
  assert.equal(handledFile(ws), join(dir, "data", "lg", "messages-handled.json"));
  transition(ws, "LOCAL-key", "building", {}, quiet);
  assert.deepEqual((await get()).queue, [], "handled, and unblocked");
});

test("queue: a blocked record is the row posted with it, not an older question on the same ticket", () => {
  const ws = workspace();
  // Asked and handled long before the ticket was blocked with a new question that was never posted.
  row(ws, T(1), "decision", "old, handled", "LOCAL-x");
  const old = queue(ws)[0]!.id;
  assert.deepEqual(markHandled(ws, old), { ok: true });
  rec(ws, "LOCAL-x", "blocked", { question: "new question", at: T(30) });
  assert.deepEqual(queue(ws).map((i) => [i.from, i.text]), [["board", "new question"]]);
  // Posted a few minutes before the block was recorded: that row is the question, once.
  row(ws, T(25), "blocked", "posted first", "LOCAL-y");
  rec(ws, "LOCAL-y", "blocked", { question: "posted first", at: T(30) });
  assert.deepEqual(queue(ws).map((i) => [i.from, i.text]), [["message", "posted first"], ["board", "new question"]]);
});

test("queue: an unblock far back in a large events log still answers its question, and appends are read as they come", () => {
  const ws = workspace();
  row(ws, T(1), "blocked", "answered long ago", "LOCAL-old");
  row(ws, T(2), "blocked", "answered now", "LOCAL-new");
  unblock(ws, T(3), "LOCAL-old");
  const pad = pyDumps({ t: T(4), ticket: "LOCAL-pad", from: "building", to: "agent-review", note: "x".repeat(900) }) + "\n";
  appendFileSync(ws.events, pad.repeat(Math.ceil((4.1 * 1024 * 1024) / pad.length)));
  assert.deepEqual(queue(ws).map((i) => i.text), ["answered now"]);
  unblock(ws, T(5), "LOCAL-new");
  assert.deepEqual(queue(ws), []);
  // A torn last line is read once it is whole.
  row(ws, T(6), "blocked", "torn", "LOCAL-torn");
  const line = pyDumps({ t: T(7), ticket: "LOCAL-torn", from: "blocked", to: "building" }) + "\n";
  appendFileSync(ws.events, line.slice(0, 20));
  assert.deepEqual(queue(ws).map((i) => i.text), ["torn"]);
  appendFileSync(ws.events, line.slice(20));
  assert.deepEqual(queue(ws), []);
});

test("queue: turned on in a workspace with history, only what is still blocked is waiting", () => {
  const ws = workspace({ since: false });
  row(ws, "2026-01-01T09:00:00+00:00", "decision", "answered in the thread months ago", "LOCAL-done");
  row(ws, "2026-01-02T09:00:00+00:00", "blocked", "still blocked", "LOCAL-stuck");
  rec(ws, "LOCAL-stuck", "blocked", { question: "still blocked", at: "2026-01-02T09:00:00+00:00" });
  rec(ws, "LOCAL-quiet", "blocked", { question: "never posted", at: "2026-01-03T09:00:00+00:00" });
  assert.deepEqual(queue(ws).map((i) => i.text), ["still blocked", "never posted"]);
  const start = JSON.parse(readFileSync(handledFile(ws), "utf8")).start as string;
  assert.ok(Math.abs(Date.now() - 24 * 3600_000 - Date.parse(start)) < 60_000, "the first read set the start, a day back");
  assert.deepEqual(queue(ws).map((i) => i.text), ["still blocked", "never posted"], "and keeps it");
  // A question asked after the start is waiting.
  const now = new Date(Date.parse(start) + 1000).toISOString();
  row(ws, now, "decision", "asked after", "LOCAL-new");
  assert.deepEqual(queue(ws).map((i) => i.text), ["still blocked", "never posted", "asked after"]);
});

test("queue: a handled file that does not parse shows everything and is never written over", () => {
  const ws = workspace();
  row(ws, T(1), "decision", "a?");
  const id = queue(ws)[0]!.id;
  writeHandledFile(ws, "{ torn");
  assert.deepEqual(queue(ws).map((i) => i.text), ["a?"]);
  const r = markHandled(ws, id);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(handledFile(ws), "utf8"), "{ torn");
});

test("the message page: reply keeps a draft, cancel takes back only the quote, a question gone meanwhile is no error", async () => {
  const item = card("maaaaaaaaaaaa", "ship on friday?", { ticket: "LOCAL-ship" });
  const { s, doc, w, settle } = await messagesPage({
    at: "12:00", human: "Alex", lead: "niilo", lead_avatar: null, status: "idle", seen: null, messages: [], queue: [item],
  });
  const t = doc.getElementById("t") as HTMLTextAreaElement;
  const reply = () => (doc.querySelector('[data-reply="maaaaaaaaaaaa"]') as HTMLElement).click();
  t.value = "half typed";
  reply();
  assert.equal(t.value, "> LOCAL-ship: ship on friday?\n\nhalf typed");
  reply();
  assert.equal(t.value, "> LOCAL-ship: ship on friday?\n\nhalf typed", "a second reply does not quote twice");
  t.value += ", and more";
  (doc.getElementById("unreply") as HTMLElement).click();
  assert.equal(t.value, "half typed, and more");
  assert.equal(doc.getElementById("replying")!.hidden, true);

  reply();
  s.handledStatus = 400; // its ticket moved on while the reply was written
  doc.getElementById("f")!.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  assert.deepEqual(s.posts.map(([u]) => u), ["/api/messages", "/api/messages/handled"]);
  assert.equal(doc.getElementById("err")!.textContent, "");
  // The handled button still says when it was refused.
  (doc.querySelector('[data-done="maaaaaaaaaaaa"]') as HTMLElement).click();
  await settle();
  assert.equal(doc.getElementById("err")!.textContent, "nothing in the queue has that id");
});

test("queue: turned on, a decision asked in the day before still waits, and an older one does not", () => {
  const ws = workspace({ since: false });
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d+Z$/, "+00:00");
  row(ws, ago(25), "decision", "asked yesterday morning");
  row(ws, ago(2), "decision", "asked just before the upgrade");
  assert.deepEqual(queue(ws).map((i) => i.text), ["asked just before the upgrade"]);
  // logs/ cleared: the start is set again a day back, and what is still open within it comes back.
  const id = queue(ws)[0]!.id;
  rmSync(handledFile(ws));
  assert.deepEqual(queue(ws).map((i) => i.id), [id]);
});

test("queue: a broken handled file is named on the page with how to mend it", async () => {
  const ws = workspace();
  row(ws, T(1), "decision", "a?");
  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const get = async () => (await (await fetch(board.url + "/api/messages")).json()) as { queue_note: string | null };
  assert.equal((await get()).queue_note, null);
  writeHandledFile(ws, "{ torn");
  const note = (await get()).queue_note!;
  assert.match(note, /messages-handled\.json does not parse/);
  assert.match(note, /delete it/);
  const { doc, settle } = await messagesPage({ at: "12:00", human: "Alex", lead: "niilo", lead_avatar: null, status: "idle", seen: null, messages: [], queue: [], queue_note: note });
  await settle();
  assert.equal(doc.querySelector("#qlist .qnote")!.textContent, note);
});

test("queue: a blocked record waits, and can be marked handled, before the workspace has any message log", () => {
  const ws = workspace();
  assert.equal(existsSync(ws.messages), false);
  rec(ws, "LOCAL-first", "blocked", { question: "which account?", at: T(1) });
  const q = queue(ws);
  assert.deepEqual(q.map((i) => [i.from, i.text]), [["board", "which account?"]]);
  assert.deepEqual(markHandled(ws, q[0]!.id), { ok: true });
  assert.deepEqual(queue(ws), []);
});

test("queue: a record marked handled stays handled when the lead posts its question afterwards", () => {
  const ws = workspace();
  rec(ws, "LOCAL-late", "blocked", { question: "which account?", at: T(10) });
  assert.deepEqual(markHandled(ws, queue(ws)[0]!.id), { ok: true });
  row(ws, T(12), "blocked", "which account?", "LOCAL-late");
  assert.deepEqual(queue(ws), []);
  // A later question on the ticket, once it was unblocked and blocked again, is new.
  unblock(ws, T(20), "LOCAL-late");
  rec(ws, "LOCAL-late", "blocked", { question: "and the region?", at: T(30) });
  row(ws, T(31), "blocked", "and the region?", "LOCAL-late");
  assert.deepEqual(queue(ws).map((i) => i.text), ["and the region?"]);
});

test("the message page: a reply marks the question it quoted, even if another reply is started while it sends", async () => {
  const item = (id: string, text: string) => card(id, text);
  const { s, doc, w, settle } = await messagesPage({
    at: "12:00", human: "Alex", lead: "niilo", lead_avatar: null, status: "idle", seen: null, messages: [],
    queue: [item("maaaaaaaaaaaa", "first?"), item("mbbbbbbbbbbbb", "second?")],
  });
  const t = doc.getElementById("t") as HTMLTextAreaElement;
  let release!: () => void;
  s.hold = new Promise((r) => (release = r));
  (doc.querySelector('[data-reply="maaaaaaaaaaaa"]') as HTMLElement).click();
  t.value += "yes";
  doc.getElementById("f")!.dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  (doc.querySelector('[data-reply="mbbbbbbbbbbbb"]') as HTMLElement).click();
  release();
  await settle();
  assert.deepEqual(s.posts.map(([u, b]) => [u, b.id ?? b.text]), [["/api/messages", "> first?\n\nyes"], ["/api/messages/handled", "maaaaaaaaaaaa"]]);
  assert.equal(doc.getElementById("replying")!.hidden, false, "the second reply is still being written");
  assert.equal(t.value, "> second?\n\n");
});

// Mikael, 2026-11-18: "I need to always manually mark them as handled. Can't you?" The lead reads the
// queue and marks what an answer settles, through the same file the page writes.
test("queue from the CLI: the lead lists the open cards and marks them handled, by id or by ticket", () => {
  const ws = workspace();
  const long = "should the event website keep the old design when the organiser picks a new one, or ask first every time it happens? It matters for the two customers on the old design.";
  row(ws, T(1), "decision", "use the classic route?", "LOCAL-a");
  row(ws, T(2), "decision", long, "LOCAL-b");
  row(ws, T(3), "blocked", "which db?", "LOCAL-a");
  const [a1, b, a2] = queue(ws).map((i) => i.id);

  let r = factory(ws.dir, ["queue"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  // one card per ticket: LOCAL-a's decision and block are one card, under its newest question
  assert.match(lines[0]!, new RegExp(`^${a2} \\(\\+ ${a1}\\)  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  LOCAL-a  decision\\+blocked$`));
  assert.equal(lines[1], "    which db?");
  assert.equal(lines[2], "    and 1 earlier message on it");
  assert.ok(lines[3]!.startsWith(`${b}  `) && lines[3]!.endsWith("LOCAL-b  decision"), lines[3]);
  // the first full sentence, wrapped, never cut mid-sentence
  assert.equal(lines.slice(4).map((l) => l.trim()).join(" "), long.split("? ")[0] + "?");
  assert.ok(lines.slice(4).every((l) => l.startsWith("    ") && l.length <= 104), lines.join("\n"));

  // an id the queue does not hold refuses the call by name, and nothing is marked
  r = factory(ws.dir, ["handled", a1!, "mdeadbeef0000"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /nothing in the queue has the id mdeadbeef0000; nothing marked/);
  assert.equal(queue(ws).length, 3);
  assert.equal(factory(ws.dir, ["handled", "not-an-id"]).status, 1);
  assert.equal(factory(ws.dir, ["handled"]).status, 2, "ids or --ticket");

  r = factory(ws.dir, ["handled", b!]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`handled ${b}`));
  assert.deepEqual(queue(ws).map((i) => i.id), [a1, a2]);
  assert.match(factory(ws.dir, ["handled", b!]).stdout, new RegExp(`${b} was already handled`));

  // the mark is the page's: the same file and format
  const file = JSON.parse(readFileSync(handledFile(ws), "utf8")) as { start: string; handled: Record<string, string> };
  assert.equal(file.start, "2000-01-01T00:00:00Z");
  assert.ok(Number.isFinite(Date.parse(file.handled[b!]!)));

  assert.match(factory(ws.dir, ["handled", "--ticket", "LOCAL-zzz"]).stdout, /nothing open on LOCAL-zzz/);
  // any one id of a card clears the whole card
  r = factory(ws.dir, ["handled", a1!]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`handled ${a1}[\\s\\S]*handled ${a2}`));
  assert.deepEqual(queue(ws), []);
  assert.match(factory(ws.dir, ["queue"]).stdout, /^nothing waiting on the human$/m);
});

test("say --answers posts the message and marks what it answers, and a wrong id posts nothing", () => {
  const ws = workspace();
  row(ws, T(1), "decision", "a?", "LOCAL-a");
  row(ws, T(2), "decision", "b?", "LOCAL-b");
  row(ws, T(3), "decision", "c?", "LOCAL-c");
  const [a, b, c] = queue(ws).map((i) => i.id);
  const posted = () => readFileSync(ws.messages, "utf8").trim().split("\n").length;
  const before = posted();

  let r = factory(ws.dir, ["say", "yes to a", "--kind", "answer", "--answers", `${a},mdeadbeef0000`]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /--answers: nothing in the queue has the id mdeadbeef0000; nothing posted/);
  assert.equal(posted(), before, "nothing posted");
  assert.equal(queue(ws).length, 3);

  r = factory(ws.dir, ["say", "yes to a and b", "--kind", "answer", "--answers", `${a},${b}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted(), before + 1);
  assert.match(r.stdout, new RegExp(`handled ${a}[\\s\\S]*handled ${b}`));
  assert.deepEqual(queue(ws).map((i) => i.id), [c]);

  // repeated --answers works as well as a comma list
  r = factory(ws.dir, ["say", "and c", "--answers", c!, "--answers", a!]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`handled ${c}[\\s\\S]*${a} was already handled`));
  assert.deepEqual(queue(ws), []);
});

// Mikael, 2026-11-24: "It can frequently duplicate topics. Also, it always collapses the message and
// the message can also be a recap sometimes about 'asked mikael...'" The lead's decision on the
// release-message formats was posted with no ticket at 15:45, and LOCAL-reports-launch-copy was
// blocked on it 23 minutes later with the note "asked Mikael which release-message formats ...": two
// cards, and the blocked one showed only the recap.
test("queue cards: a decision and the block on it are one card, showing the decision, not the block's note", () => {
  const ws = workspace();
  const decision = "Cruz studied how earlier releases were announced. Which formats should I draft: a Productboard card, an in-app What's new, a product-updates post, or a blog?";
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  // a decision on its ticket, blocked half an hour later: the ticket folds them
  row(ws, iso(60), "decision", "keep the old layout?", "LOCAL-layout");
  rec(ws, "LOCAL-layout", "blocked", { question: "asked Mikael about the layout", at: iso(30) });
  let cards = queueCards(ws);
  assert.equal(cards.length, 1);
  assert.deepEqual([cards[0]!.questions.map((q) => q.text), cards[0]!.blocked?.note, cards[0]!.unposted], [["keep the old layout?"], "asked Mikael about the layout", false]);
  assert.equal(cards[0]!.ids.length, 2);

  // today's case through the lead's own commands: a decision with no ticket, then the block
  let r = factory(ws.dir, ["say", decision, "--kind", "decision"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /a decision with no --ticket: .* factory state <T> blocked --asks <its id>/);
  const m = queueCards(ws).find((c) => c.questions[0]?.text === decision)!.id;
  assert.equal(factory(ws.dir, ["state", "LOCAL-launch", "designing"]).status, 0);
  r = factory(ws.dir, ["state", "LOCAL-launch", "blocked", "--note", "asked Mikael which release-message formats to draft"]);
  assert.equal(r.status, 0, r.stderr);
  // unlinked: two cards, and the state command says so, naming the loose decision and the fix
  assert.match(r.stdout, /LOCAL-launch's card shows only this block's note, which is not a question/);
  assert.ok(r.stdout.includes(`factory state LOCAL-launch blocked --asks ${m} --note`), r.stdout);
  assert.equal(queueCards(ws).length, 3);
  const loose = queueCards(ws).find((c) => c.ticket === "LOCAL-launch")!;
  assert.equal(loose.unposted, true, "flagged: only a blocked note");
  assert.match(factory(ws.dir, ["queue"]).stdout, /asked Mikael which release-message formats to draft \[only the blocked note: no question posted\]/);

  // --asks folds it: one card, the decision shown whole, the note only as the block
  assert.equal(factory(ws.dir, ["state", "LOCAL-launch", "blocked", "--asks", "mdeadbeef0000"]).status, 1, "a question the queue does not hold");
  assert.equal(factory(ws.dir, ["state", "LOCAL-launch", "building", "--asks", m]).status, 2, "--asks belongs on blocked");
  r = factory(ws.dir, ["state", "LOCAL-launch", "blocked", "--asks", m, "--note", "asked Mikael which release-message formats to draft"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`queue: one card with the posted question ${m}`));
  cards = queueCards(ws);
  assert.equal(cards.length, 2);
  const launch = cards.find((c) => c.ticket === "LOCAL-launch")!;
  assert.deepEqual([launch.id, launch.questions.map((q) => q.text), launch.unposted], [m, [decision], false]);
  const q = factory(ws.dir, ["queue"]).stdout;
  assert.ok(q.includes("    Cruz studied how earlier releases were announced."), q);
  assert.ok(!q.includes("asked Mikael which"), "the recap is not the question");

  // handled by any one of its ids clears the whole card
  const recId = launch.ids.find((id) => id.startsWith("r"))!;
  r = factory(ws.dir, ["handled", recId]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(queueCards(ws).map((c) => c.ticket), ["LOCAL-layout"]);
  assert.ok(markHandled(ws, cards.find((c) => c.ticket === "LOCAL-layout")!.ids[0]).ok);
  assert.deepEqual(queueCards(ws), []);
});

test("queue cards: a block with a decision already open on its ticket says it folded in", () => {
  const ws = workspace();
  let r = factory(ws.dir, ["state", "LOCAL-font", "designing"]);
  assert.equal(r.status, 0, r.stderr);
  r = factory(ws.dir, ["say", "font A or B?", "--kind", "decision", "--ticket", "LOCAL-font"]);
  assert.equal(r.status, 0, r.stderr);
  r = factory(ws.dir, ["state", "LOCAL-font", "blocked", "--note", "asked about the font"]);
  assert.equal(r.status, 0, r.stderr);
  // posted with the block, the question covers the record already: one card, and a mark on either holds
  assert.match(r.stdout, /queue: one card with the posted question m[0-9a-f]{12} \(covers m[0-9a-f]{12}\)/);
  assert.equal(queueCards(ws).length, 1);
});

test("say --answers clears the cards it names, but not a new question it posts on the same ticket", () => {
  const ws = workspace();
  row(ws, T(1), "decision", "a?", "LOCAL-alpha");
  const [a] = queue(ws).map((i) => i.id);
  const r = factory(ws.dir, ["say", "a is settled, so: b?", "--kind", "decision", "--ticket", "LOCAL-alpha", "--answers", a!]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(queueCards(ws).map((c) => c.questions.map((q) => q.text)), [["a is settled, so: b?"]]);
});

test("firstSentence and wrap: a whole sentence, never cut mid-word", () => {
  assert.equal(firstSentence("**Fonts:** pick one. Then the rest."), "Fonts: pick one.");
  assert.equal(firstSentence("## Heading\nbody"), "Heading");
  assert.equal(firstSentence("version 1.2 is out. Next."), "version 1.2 is out.");
  assert.equal(firstSentence("one two three four five six", 13), "one two three…");
  assert.deepEqual(wrap("aaa bbb ccc ddd", 7, "  "), ["  aaa bbb", "  ccc ddd"]);
});
