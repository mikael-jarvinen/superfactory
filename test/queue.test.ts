import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { handledFile, queue } from "../src/board/queue.js";
import { serve } from "../src/board/server.js";
import { say } from "../src/messages.js";
import { transition } from "../src/state.js";
import { pyDumps } from "../src/util.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { tempDir, tempWorkspace } from "./helpers.js";

const noInboxLock = process.platform !== "darwin" && process.platform !== "linux" && "the inbox lock is built for macOS and Linux only";

function workspace(): Workspace {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  mkdirSync(ws.stateDir, { recursive: true });
  return ws;
}
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
  const s = { data, posts: [] as [string, Record<string, unknown>][] };
  Object.defineProperty(w.document, "visibilityState", { get: () => "hidden" });
  Object.assign(w, {
    scrollTo: () => {},
    fetch: async (url: string, o?: { method?: string; body?: string }) => {
      if (o?.method === "POST") {
        s.posts.push([url, JSON.parse(o.body ?? "{}")]);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
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
  // The lead's real writers: `factory say` and `factory state`.
  say(ws, ["pick a colour?"], { kind: "decision", ticket: "LOCAL-colour" }, quiet);
  say(ws, ["just news"], { kind: "note" }, quiet);
  transition(ws, "LOCAL-key", "queued", {}, quiet);
  transition(ws, "LOCAL-key", "blocked", { note: "need the key" }, quiet);

  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const get = async () => ((await (await fetch(board.url + "/api/messages")).json()) as { human: string; lead: string; queue: { id: string; text: string; from: string }[] });
  const d = await get();
  assert.deepEqual([d.human, d.lead], ["Robin", "kai"]);
  assert.deepEqual(d.queue.map((i) => [i.from, i.text]), [["message", "pick a colour?"], ["board", "need the key"]]);

  const r = await fetch(board.url + "/api/messages/handled", { method: "POST", headers: { "Content-Type": "application/json", "Origin": board.url }, body: JSON.stringify({ id: d.queue[0]!.id }) });
  assert.equal(r.status, 200);
  assert.equal(handledFile(ws), join(dir, "data", "lg", "messages-handled.json"));
  transition(ws, "LOCAL-key", "building", {}, quiet);
  assert.deepEqual((await get()).queue, [], "handled, and unblocked");
});
