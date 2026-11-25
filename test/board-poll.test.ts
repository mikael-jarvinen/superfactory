import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// common.js's poll, as every page that polls the board runs it. What the board answers decides the
// header: its snapshot's time, the board's own error, its HTTP status, or no reason when the board
// cannot be reached at all.
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));

async function polled(answer: () => Promise<unknown>) {
  const dom = new JSDOM('<button id="theme"></button><div id="pulse"></div><span id="at"></span>', { runScripts: "outside-only", url: "http://board.test/" });
  windows.push(dom);
  const w = dom.window;
  const rendered: unknown[] = [];
  Object.assign(w, { fetch: answer, matchMedia: () => ({ matches: false }), setInterval: () => 0, rendered });
  const page = dom.getInternalVMContext();
  new vm.Script(readFileSync(new URL("../src/board/static/common.js", import.meta.url), "utf8"), { filename: "common.js" }).runInContext(page);
  new vm.Script("poll('/api', (d) => rendered.push(d))").runInContext(page);
  await new Promise((r) => setTimeout(r, 50));
  const doc = w.document;
  return { at: doc.getElementById("at")!.textContent, stale: doc.getElementById("pulse")!.classList.contains("stale"), rendered };
}

test("a page's poll renders a snapshot, and says why the board is not answering when it can", async () => {
  const ok = await polled(async () => ({ ok: true, status: 200, json: async () => ({ at: "12:00:00" }) }));
  assert.deepEqual(ok, { at: "12:00:00", stale: false, rendered: [{ at: "12:00:00" }] });

  const refused = await polled(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
  assert.deepEqual(refused, { at: "not answering: boom", stale: true, rendered: [] }, "the board's own error, and its body is not rendered");

  const bare = await polled(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  assert.deepEqual(bare, { at: "not answering: HTTP 502", stale: true, rendered: [] }, "a refusal with no JSON body says its status");

  const unreachable = await polled(async () => { throw new TypeError("Failed to fetch"); });
  assert.deepEqual(unreachable, { at: "not answering", stale: true, rendered: [] }, "a board that cannot be reached has no why to say");
});
