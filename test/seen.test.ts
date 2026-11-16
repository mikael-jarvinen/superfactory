import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { serve } from "../src/board/server.js";
import { readSeen, seenFile } from "../src/board/seen.js";
import { pyDumps } from "../src/util.js";
import { openWorkspace } from "../src/workspace.js";
import { tempWorkspace } from "./helpers.js";

const noInboxLock = process.platform !== "darwin" && process.platform !== "linux" && "the inbox lock is built for macOS and Linux only";

test("seen: the page marks the newest lead message it showed, forward only, and only a real one", { skip: noInboxLock }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  mkdirSync(ws.stateDir, { recursive: true });
  const row = (t: string, kind: string, text: string) => appendFileSync(ws.messages, pyDumps({ t, kind, text }) + "\n");
  row("2026-11-16T12:00:00+00:00", "note", "first");
  row("2026-11-16T12:05:00+00:00", "human", "a question");
  row("2026-11-16T12:10:00+00:00", "answer", "second");
  // Two lead messages in the same second: one mark covers both.
  row("2026-11-16T12:10:00+00:00", "note", "second, same second");

  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const page = { "Content-Type": "application/json", "Origin": board.url };
  const mark = (t: unknown, headers: Record<string, string> = page) =>
    fetch(board.url + "/api/messages/seen", { method: "POST", headers, body: JSON.stringify({ t }) });
  const seen = async () => (await (await fetch(board.url + "/api/messages")).json()).seen;

  assert.equal(await seen(), null, "nothing marked yet");
  assert.equal((await mark("2026-11-16T12:00:00+00:00")).status, 200);
  assert.equal(await seen(), "2026-11-16T12:00:00+00:00");
  assert.equal(JSON.parse(readFileSync(seenFile(ws), "utf8")).t, "2026-11-16T12:00:00+00:00", "kept in logs/");

  assert.equal((await mark("2026-11-16T12:10:00+00:00")).status, 200);
  assert.equal(readSeen(ws), "2026-11-16T12:10:00+00:00");
  // An older tab marking what it shows does not move the mark back.
  const back = await mark("2026-11-16T12:00:00+00:00");
  assert.deepEqual([back.status, (await back.json()).seen], [200, "2026-11-16T12:10:00+00:00"]);
  assert.equal(readSeen(ws), "2026-11-16T12:10:00+00:00");

  // Only the t of a lead message in the log: not the human's own, not one that is not there, not a non-time.
  for (const bad of ["2026-11-16T12:05:00+00:00", "2026-11-16T13:00:00+00:00", "soon", 42, null]) {
    const r = await mark(bad);
    assert.equal(r.status, 400, `refused: ${String(bad)}`);
  }
  // Same-site only, as posting a message is.
  assert.equal((await mark("2026-11-16T12:10:00+00:00", { "Content-Type": "text/plain;charset=UTF-8", "Origin": "https://elsewhere.example" })).status, 403);
  assert.equal((await mark("2026-11-16T12:10:00+00:00", { "Content-Type": "application/json", "Origin": "https://elsewhere.example" })).status, 403);
  assert.equal(readSeen(ws), "2026-11-16T12:10:00+00:00");
});

// /messages as the page runs it: GET /api/messages answers `data`, and every POST to
// /api/messages/seen is recorded and answered with `status`.
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));
function messagesPage() {
  const ids = ["theme", "pulse", "at", "list", "lead", "doing", "words", "t", "b", "err", "f", "preview"];
  const dom = new JSDOM(ids.map((id) => (id === "t" ? `<textarea id="t"></textarea>` : id === "f" ? `<input id="f" type="file">` : `<div id="${id}"></div>`)).join(""),
    { runScripts: "outside-only", url: "http://board.test/messages" });
  windows.push(dom);
  const w = dom.window;
  const lead = (t: string, text = "hi") => ({ t, kind: "note", text, from: "lead", age_min: 1, receipt: null });
  const s = {
    data: { at: "12:00", human: "Alex", lead: "niilo", lead_avatar: null, status: "idle", seen: null as string | null, messages: [] as object[] },
    posts: [] as string[],
    status: 200,
    visible: true,
    lead,
  };
  Object.defineProperty(w.document, "visibilityState", { get: () => (s.visible ? "visible" : "hidden") });
  Object.assign(w, {
    fetch: async (url: string, o?: { method?: string; body?: string }) => {
      if (o?.method === "POST") {
        s.posts.push((JSON.parse(o.body ?? "{}") as { t: string }).t);
        return { ok: s.status < 300, status: s.status, json: async () => ({}) };
      }
      assert.equal(url, "/api/messages");
      return { ok: true, status: 200, json: async () => structuredClone(s.data) };
    },
  });
  const ctx = dom.getInternalVMContext();
  for (const f of ["common.js", "marked.umd.js", "purify.min.js", "markdown.js", "messages.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(ctx);
  const tick = new vm.Script("tick").runInContext(ctx) as () => Promise<void>;
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { s, w, poll: async () => { await tick(); await settle(); }, settle };
}

test("the message page marks the newest lead message only while visible, once each", async () => {
  const { s, w, poll, settle } = messagesPage();
  s.data.messages = [{ t: "2026-11-16T12:06:00+00:00", kind: "human", text: "q", from: "human", age_min: 1, receipt: "seen" }, s.lead("2026-11-16T12:05:00+00:00")];
  await poll();
  assert.deepEqual(s.posts, ["2026-11-16T12:05:00+00:00"], "the newest lead row, not the human's newer one");
  await poll();
  assert.deepEqual(s.posts, ["2026-11-16T12:05:00+00:00"], "posted once");

  // A hidden tab marks nothing; coming back marks at once.
  s.visible = false;
  s.data.messages.unshift(s.lead("2026-11-16T12:10:00+00:00"));
  await poll();
  assert.equal(s.posts.length, 1, "hidden: nothing marked");
  s.visible = true;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  await settle();
  assert.deepEqual(s.posts.at(-1), "2026-11-16T12:10:00+00:00");

  // The board already holds a newer mark (another tab): nothing to post.
  const n = s.posts.length;
  s.data.seen = "2026-11-16T12:20:00+00:00";
  s.data.messages.unshift(s.lead("2026-11-16T12:15:00+00:00"));
  await poll();
  assert.equal(s.posts.length, n);
});

test("the message page tries a mark again after a 5xx, not after a refusal", async () => {
  const { s, poll } = messagesPage();
  s.data.messages = [s.lead("2026-11-16T12:05:00+00:00")];
  s.status = 503;
  await poll();
  await poll();
  assert.equal(s.posts.length, 2, "a 5xx is tried again");
  s.status = 400;
  await poll();
  await poll();
  assert.equal(s.posts.length, 3, "a refusal is not");
});
