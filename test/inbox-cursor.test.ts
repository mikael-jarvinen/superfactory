import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Cursor, leaveNote, Receipts, notesLog, postMessage, readCursor, unsent, unsentNotes, writeCursor } from "../src/board/inbox.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { tempWorkspace } from "./helpers.js";

// One pass of the monitor over the message log: what it prints, and the cursor it leaves.
function pass(ws: Workspace, cursor: Cursor | null): { printed: string[]; cursor: Cursor | null } {
  const printed: string[] = [];
  for (const u of unsent(ws, cursor)) {
    if (u.row) printed.push(String(u.row.text));
    cursor = u.cursor;
  }
  return { printed, cursor };
}

function notesPass(ws: Workspace, cursor: Cursor | null): { printed: string[]; cursor: Cursor | null } {
  const printed: string[] = [];
  for (const u of unsentNotes(ws, cursor)) {
    if (u.text) printed.push(u.text.replace(/^\[m:[0-9a-f]+\] /, ""));
    cursor = u.cursor;
  }
  return { printed, cursor };
}

// A cleanup's rewrite: the log replaced by rename, so a new inode, and not rolled to .1.
function replace(path: string, content: string): void {
  const before = statSync(path).ino;
  writeFileSync(path + ".new", content);
  renameSync(path + ".new", path);
  assert.notEqual(statSync(path).ino, before, "the rewrite gave the log a new inode");
}

function setup(): Workspace {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  return openWorkspace(dir);
}

test("a message log replaced other than by rotation is read on past the last printed row, not from the top", () => {
  const ws = setup();
  postMessage(ws, "zero, history");
  let c = pass(ws, null).cursor;
  postMessage(ws, "one");
  postMessage(ws, "two");
  const first = pass(ws, c);
  assert.deepEqual(first.printed, ["one", "two"]);
  c = first.cursor;
  assert.match(c?.last ?? "", /^[0-9a-f]{6}$/, "the cursor keeps the last printed id");

  // The same rows plus one the rewrite carried in, then one appended after it.
  replace(ws.messages, readFileSync(ws.messages, "utf8"));
  postMessage(ws, "three");
  const second = pass(ws, c);
  assert.deepEqual(second.printed, ["three"], "the offset holds, so one and two are not printed again");
  assert.notEqual(second.cursor?.last, c?.last, "and three is now the last printed");
});

test("a replaced log without the last printed row is read from the top: repeated rather than lost", () => {
  const ws = setup();
  let c = pass(ws, null).cursor;
  postMessage(ws, "one");
  c = pass(ws, c).cursor;
  const kept = readFileSync(ws.messages, "utf8");
  postMessage(ws, "two");
  c = pass(ws, c).cursor;
  // The rewrite dropped two, the last printed row.
  replace(ws.messages, kept);
  postMessage(ws, "three");
  assert.deepEqual(pass(ws, c).printed, ["one", "three"]);
});

test("a log cut short in place is read on past the last printed row", () => {
  const ws = setup();
  let c = pass(ws, null).cursor;
  postMessage(ws, "one");
  postMessage(ws, "two");
  postMessage(ws, "three");
  c = pass(ws, c).cursor;
  const ino = statSync(ws.messages).ino;
  // Same inode, and shorter than the offset even with four appended: one and two are gone, three,
  // the last printed, is not.
  writeFileSync(ws.messages, readFileSync(ws.messages, "utf8").split("\n").slice(2).join("\n"));
  assert.equal(statSync(ws.messages).ino, ino);
  postMessage(ws, "four");
  assert.deepEqual(pass(ws, c).printed, ["four"]);
});

test("the cursor file keeps the last printed id, and an old two-field file still reads", () => {
  const ws = setup();
  writeCursor(ws, { ino: 7, offset: 42, last: "abc123" });
  assert.deepEqual(readCursor(ws), { ino: 7, offset: 42, last: "abc123" });
  writeCursor(ws, { ino: 7, offset: 43 });
  assert.deepEqual(readCursor(ws), { ino: 7, offset: 43 });
});

test("the watchers' notes log replaced other than by rotation is read on past the last printed note", () => {
  const ws = setup();
  leaveNote(ws, "one");
  leaveNote(ws, "two");
  const first = notesPass(ws, null);
  assert.deepEqual(first.printed, ["one", "two"]);
  replace(notesLog(ws), readFileSync(notesLog(ws), "utf8"));
  leaveNote(ws, "three");
  assert.deepEqual(notesPass(ws, first.cursor).printed, ["three"]);
});

// The lead reads its messages with `board --inbox --once` run from Bash, so a message reaches it in
// the tool_result of a user entry with array content: delivered there, seen at the next reply.
test("a message read through a Bash tool_result is delivered, then seen at the next assistant entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "receipts-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const t = join(dir, "lead.jsonl");
  const put = (d: unknown) => appendFileSync(t, JSON.stringify(d) + "\n");
  put({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "factory board --inbox --once" } }] } });
  put({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "[m:abc123] are we on?" }] } });
  put({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: "[m:def456] and this" }] }] } });
  const r = new Receipts();
  r.read(t);
  assert.deepEqual([r.receipt("abc123"), r.receipt("def456"), r.receipt("0f0f0f")], ["delivered", "delivered", "sent"]);
  put({ type: "assistant", message: { content: [{ type: "text", text: "yes" }] } });
  r.read(t);
  assert.deepEqual([r.receipt("abc123"), r.receipt("def456")], ["seen", "seen"]);
});

// Only what `board --inbox` printed counts in a tool's output, in each shape it reaches the lead:
// the command's stdout, BashOutput's, a Read of the background command's output file, a note. A
// log line that names an id, the watchdog's own alert above all, is not the message reaching it.
test("in a tool_result only board --inbox's own lines count; the watchdog's log line marks nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "receipts-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const t = join(dir, "lead.jsonl");
  const put = (d: unknown) => appendFileSync(t, JSON.stringify(d) + "\n");
  const result = (content: unknown) => put({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu", content }] } });
  result("2026-11-26T10:00:00.000Z watchdog: ALERT, [m:aaaaaa] unseen by niilo for 14 min\n" +
    "2026-11-26T10:05:00.000Z watchdog: niilo has seen [m:bbbbbb] or a later message, episode over");
  result([{ type: "text", text: 'grep: {"id":"cccccc","text":"[m:cccccc] quoted"}' }]);
  result("     1→[from the message page] [m:dddddd] from the output file\n     2→[m:eeeeee] a note");
  result("<stdout>[from the message page] [m:ffffff] via BashOutput\n</stdout>");
  result("[from the message page] [m:121212] on stdout");
  put({ type: "assistant", message: { content: [{ type: "text", text: "on it" }] } });
  const r = new Receipts();
  r.read(t);
  assert.deepEqual(["aaaaaa", "bbbbbb", "cccccc"].map((id) => r.receipt(id)), ["sent", "sent", "sent"]);
  assert.deepEqual(["dddddd", "eeeeee", "ffffff", "121212"].map((id) => r.receipt(id)), ["seen", "seen", "seen", "seen"]);
});
