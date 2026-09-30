import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { pyDumps } from "../src/util.js";
import { factory, tempWorkspace } from "./helpers.js";

// The store is shared with the old writer, so what is written here must be what it writes.
test("records, events and messages are written as Python's json.dumps writes them", () => {
  assert.equal(pyDumps({ b: [1, { d: null, c: true }], a: "ä€😀\n\"", e: [], f: {} }, { sortKeys: true }),
    '{"a": "\\u00e4\\u20ac\\ud83d\\ude00\\n\\"", "b": [1, {"c": true, "d": null}], "e": [], "f": {}}');
  assert.equal(pyDumps({ pr: { number: 1 }, prs: [] }, { indent: 2 }), '{\n  "pr": {\n    "number": 1\n  },\n  "prs": []\n}');
});

test("say appends one row, refuses over 1200 characters, and prints the push line", () => {
  const ws = tempWorkspace();
  after(() => rmSync(ws, { recursive: true, force: true }));
  const log = join(ws, "state", "messages.jsonl");
  const r = factory(ws, ["say", "WEB-1", "is", "ready", "--ticket", "WEB-1", "--kind", "ready", "--link", "https://example.com/1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "posted to http://localhost:8787/messages\nPUSH NOW: WEB-1 WEB-1 is ready\n");
  assert.match(readFileSync(log, "utf8"),
    /^\{"t": "[^"]+", "text": "WEB-1 is ready", "ticket": "WEB-1", "kind": "ready", "link": "https:\/\/example.com\/1"\}\n$/);
  assert.equal(factory(ws, ["say", "é".repeat(1200)]).status, 0);
  assert.match(factory(ws, ["say", "é".repeat(1201)]).stderr, /1201 characters/);
  assert.equal(factory(ws, ["say", "x", "--kind", "chat"]).status, 2);
});

test("the log rotates past a megabyte, and messages reads only the tail", () => {
  const ws = tempWorkspace();
  after(() => rmSync(ws, { recursive: true, force: true }));
  const log = join(ws, "state", "messages.jsonl");
  factory(ws, ["say", "first"]);
  appendFileSync(log, ("x".repeat(99) + "\n").repeat(10_100));
  factory(ws, ["say", "second"]);
  assert.ok(existsSync(log + ".1"));
  assert.equal(readFileSync(log, "utf8").split("\n").length, 2);

  writeFileSync(log, "");
  const row = (text: string, kind: string) => JSON.stringify({ t: "2026-01-02T03:04:05+00:00", text, ticket: null, kind, link: null });
  appendFileSync(log, row("old " + "y".repeat(300 * 1024), "note") + "\n");
  appendFileSync(log, [row("from the human", "human"), row("before the rename", "alex"), row("two\nlines\n", "answer")].join("\n") + "\n");
  const out = factory(ws, ["messages", "-n", "5"]).stdout;
  assert.equal(out,
    "2026-01-02T03:04  alex      human\n    from the human\n" +
    "2026-01-02T03:04  alex      alex\n    before the rename\n" +
    "2026-01-02T03:04  ada       answer\n    two\n    lines\n");
});
