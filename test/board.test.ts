import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { inboxHeld, postMessage, sweep } from "../src/board/inbox.js";
import { serve } from "../src/board/server.js";
import { transition } from "../src/state.js";
import { pyDumps } from "../src/util.js";
import { openWorkspace } from "../src/workspace.js";
import { CLI, tempWorkspace } from "./helpers.js";

const macOnly = process.platform !== "darwin" && "the inbox lock is macOS-only";

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !ok();) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// One owner at a time: while a monitor holds the inbox it prints the human's messages and the
// board's sweep stands aside; once the monitor dies the sweep takes over from the same cursor.
test("the inbox: held detection, the monitor, and the relay hook", { skip: macOnly }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir);
  const relayed: string[] = [];
  const relay = (_: unknown, text: string) => void relayed.push(text);

  postMessage(ws, "before any inbox");
  assert.equal(inboxHeld(ws), false);
  const mon = spawn(process.execPath, [CLI, "--workspace", dir, "board", "--inbox"], { env: { ...process.env, SF_NOTIFY: "0" } });
  let out = "";
  mon.stdout.on("data", (b: Buffer) => (out += b));
  after(() => mon.kill());
  await until("the monitor to hold the inbox", () => inboxHeld(ws));
  assert.equal(sweep(ws, relay), false, "the sweep stands aside while a monitor holds the inbox");

  postMessage(ws, "hello");
  appendFileSync(ws.messages, pyDumps({ t: "x", text: "the lead's own", ticket: null, kind: "note", link: null }) + "\n");
  await until("the message on stdout", () => out.includes("hello"));
  assert.match(out, /^\[from the message page\] \[m:[0-9a-f]{6}\] hello\n$/, "history before the first cursor is not news, and the lead's rows are not printed");

  mon.kill();
  await until("the lock to die with the monitor", () => !inboxHeld(ws));
  postMessage(ws, "after the monitor");
  assert.equal(sweep(ws, relay), true);
  assert.equal(sweep(ws, relay), true);
  assert.deepEqual(relayed.map((t) => t.replace(/\[m:\w+\] /, "")), ["[from the message page] after the monitor"]);

  // `say` rotates the log to .1. The new file is found by its inode, not by being shorter.
  renameSync(ws.messages, ws.messages + ".1");
  writeFileSync(ws.messages, "x".repeat(4096) + "\n");
  postMessage(ws, "in the new log");
  sweep(ws, relay);
  assert.equal(relayed.length, 2);
  assert.match(relayed[1] as string, /in the new log$/);
});

test("the server: pages, the snapshot, posting, and only the tail of the log", { skip: macOnly }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  const quiet = () => {};
  transition(ws, "WEB-1", "building", { agent: "bea", title: "Fix the redirect" }, quiet);
  transition(ws, "WEB-2", "building", {}, quiet);
  transition(ws, "WEB-2", "blocked", { note: "asked about the header row" }, quiet);
  // A first row longer than the tail window: reading it would mean reading the file from the start.
  appendFileSync(ws.messages, pyDumps({ t: "x", text: "y".repeat(300 * 1024), kind: "note" }) + "\n");
  appendFileSync(ws.messages, pyDumps({ t: "x", id: "abc123", text: "from the old kind", kind: "alex" }) + "\n");

  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const get = async (p: string) => fetch(board.url + p);

  assert.match(await (await get("/")).text(), /<script src="\/static\/board.js">/);
  assert.equal((await get("/static/common.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await get("/static/..%2Fserver.js")).status, 404);

  const snap = await (await get("/api")).json();
  assert.deepEqual(snap.tickets.map((t: { ticket: string; state: string }) => `${t.ticket} ${t.state}`), ["WEB-1 building", "WEB-2 blocked"]);
  assert.equal(snap.tickets[1].question, "asked about the header row");
  assert.equal(snap.stacks.present, false, "no export from the stack engine, no stacks");
  assert.match(snap.descriptions["your-review"], /^Alex's\./);

  const post = await fetch(board.url + "/api/messages", { method: "POST", body: JSON.stringify({ text: "  typed on the page " }) });
  assert.deepEqual(await post.json(), { ok: true, error: null });
  const m = await (await get("/api/messages")).json();
  assert.equal(m.human, "Alex");
  assert.deepEqual(m.messages.map((r: { text: string; from: string; receipt: string }) => [r.text, r.from, r.receipt]),
    [["typed on the page", "human", "sent"], ["from the old kind", "human", "sent"]]);
  const bad = await fetch(board.url + "/api/messages", { method: "POST", body: JSON.stringify({ text: "x".repeat(4001) }) });
  assert.equal(bad.status, 400);
});
