import assert from "node:assert/strict";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { type Cursor, leaveNote, notesLog, postMessage, readCursor, unsent, unsentNotes, writeCursor } from "../src/board/inbox.js";
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
