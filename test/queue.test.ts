import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { handledFile, markHandled, queue } from "../src/board/queue.js";
import { serve } from "../src/board/server.js";
import { say } from "../src/messages.js";
import { transition } from "../src/state.js";
import { pyDumps } from "../src/util.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { tempDir, tempWorkspace } from "./helpers.js";

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

test("queue: a blocked question leaves once its ticket leaves blocked after it, a decision does not", () => {
  const ws = workspace();
  unblock(ws, T(0), "LOCAL-a"); // an earlier episode: the question after it is still open
  row(ws, T(1), "blocked", "a?", "LOCAL-a");
  row(ws, T(2), "blocked", "b?", "LOCAL-b");
  row(ws, T(3), "decision", "c?", "LOCAL-b");
  rec(ws, "LOCAL-a", "blocked", { question: "a?", at: T(1) });
  rec(ws, "LOCAL-b", "building");
  unblock(ws, T(4), "LOCAL-b");
  assert.deepEqual(queue(ws).map((i) => i.text), ["a?", "c?"]);
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
  // Blocked again after it was answered: the old row is the earlier episode's, the record is new.
  unblock(ws, T(4), "LOCAL-said");
  rec(ws, "LOCAL-said", "blocked", { question: "a second question", at: T(5) });
  assert.deepEqual(queue(ws).map((i) => i.text), ["said in the thread", "only on the board", "a second question"]);
});

test("queue: the page marks an item handled; reading the thread or writing in it does not", { skip: noInboxLock }, async () => {
  const ws = workspace();
  row(ws, T(1), "decision", "ship on friday?", "LOCAL-ship");
  row(ws, T(2), "blocked", "which db?", "LOCAL-db");
  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const page = { "Content-Type": "application/json", "Origin": board.url };
  const get = async () => (await (await fetch(board.url + "/api/messages")).json()) as { queue: { id: string; text: string; in_thread: boolean }[]; messages: { qid?: string; text: string }[] };
  const handle = (id: unknown, headers: Record<string, string> = page) =>
    fetch(board.url + "/api/messages/handled", { method: "POST", headers, body: JSON.stringify({ id }) });

  const d = await get();
  assert.deepEqual(d.queue.map((i) => [i.text, i.in_thread]), [["ship on friday?", true], ["which db?", true]]);
  // Each queue row names its message in the thread by the same id.
  assert.deepEqual(d.queue.map((i) => d.messages.find((m) => m.qid === i.id)?.text), ["ship on friday?", "which db?"]);

  assert.equal((await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ text: "yes, friday" }) })).status, 200);
  await get();
  assert.equal((await get()).queue.length, 2, "a message in the thread and a read leave the queue as it was");

  const id = d.queue[0]!.id;
  for (const bad of ["m000000000000", "nope", 42, null]) assert.equal((await handle(bad)).status, 400, `refused: ${String(bad)}`);
  assert.equal((await handle(id, { "Content-Type": "application/json", "Origin": "https://elsewhere.example" })).status, 403);
  assert.equal((await get()).queue.length, 2);

  assert.equal((await handle(id)).status, 200);
  assert.deepEqual((await get()).queue.map((i) => i.text), ["which db?"]);
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

test("the message page: a shut panel with a count, a link into the thread, handled and reply", async () => {
  const item = (id: string, text: string, in_thread: boolean, ticket: string | null = null) =>
    ({ id, t: T(1), at: T(1), kind: "decision", ticket, text, link: null, from: "message", age_min: 5, in_thread });
  const { s, doc, w, settle } = await messagesPage({
    at: "12:00", human: "Alex", lead: "niilo", lead_avatar: null, status: "idle", seen: null,
    messages: [{ t: T(1), kind: "decision", text: "ship on friday?", ticket: "LOCAL-ship", from: "lead", qid: "maaaaaaaaaaaa", age_min: 5 }],
    queue: [item("maaaaaaaaaaaa", "ship on friday?", true, "LOCAL-ship"), item("mbbbbbbbbbbbb", "## old one\nwith **more** words", false)],
  });
  const panel = doc.getElementById("queue") as HTMLDetailsElement;
  assert.equal(panel.open, false, "shut until opened");
  assert.equal(doc.getElementById("qcount")!.textContent, "2");
  const rows = [...doc.querySelectorAll(".qi")];
  assert.deepEqual(rows.map((r) => r.querySelector(".line")!.textContent), ["ship on friday?", "old one"]);
  assert.equal(rows[0]!.querySelector(".tk")!.textContent, "LOCAL-ship");
  assert.equal(rows[0]!.querySelector("a.line")!.getAttribute("href"), "#q-maaaaaaaaaaaa");
  assert.ok(doc.getElementById("q-maaaaaaaaaaaa"), "the message in the thread carries the anchor");

  // One not in the thread opens its words in the panel.
  (rows[1]!.querySelector("button.line") as HTMLElement).click();
  await settle();
  assert.match(doc.querySelectorAll(".qi")[1]!.querySelector(".body")!.innerHTML, /<strong>more<\/strong>/);

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
  const get = async () => ((await (await fetch(board.url + "/api/messages")).json()) as { human: string; lead: string; queue: { id: string; text: string; from: string }[] });
  assert.deepEqual((await get()).queue, [], "nothing yet, and the first read sets the queue's start");
  // The lead's real writers: `factory say` and `factory state`.
  say(ws, ["pick a colour?"], { kind: "decision", ticket: "LOCAL-colour" }, quiet);
  say(ws, ["just news"], { kind: "note" }, quiet);
  transition(ws, "LOCAL-key", "queued", {}, quiet);
  transition(ws, "LOCAL-key", "blocked", { note: "need the key" }, quiet);
  const d = await get();
  assert.deepEqual([d.human, d.lead], ["Robin", "kai"]);
  assert.deepEqual(d.queue.map((i) => [i.from, i.text]), [["message", "pick a colour?"], ["board", "need the key"]]);

  const r = await fetch(board.url + "/api/messages/handled", { method: "POST", headers: { "Content-Type": "application/json", "Origin": board.url }, body: JSON.stringify({ id: d.queue[0]!.id }) });
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
  const item = { id: "maaaaaaaaaaaa", t: T(1), at: T(1), kind: "decision", ticket: "LOCAL-ship", text: "ship on friday?", link: null, from: "message", age_min: 5, in_thread: false };
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
  const item = (id: string, text: string) => ({ id, t: T(1), at: T(1), kind: "decision", ticket: null, text, link: null, from: "message", age_min: 5, in_thread: false });
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
