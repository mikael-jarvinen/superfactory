import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// common.js's poll, as every page that polls the board runs it, and the GitHub page, which fetches
// through the same getJSON. What the board answers decides the header: its snapshot's time, the
// board's own error, its HTTP status, or no reason when the board cannot be reached at all.
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));

type Answer = () => Promise<unknown>;
const script = (name: string) => readFileSync(new URL(`../src/board/static/${name}`, import.meta.url), "utf8");
const settle = () => new Promise((r) => setTimeout(r, 50));

// A page with common.js loaded, whose fetch answers with what `answers` holds now.
function page(body: string, answers: { now: Answer }) {
  const dom = new JSDOM(`<button id="theme"></button><div id="pulse"></div><span id="at"></span>${body}`, { runScripts: "outside-only", url: "http://board.test/" });
  windows.push(dom);
  const w = dom.window;
  const rendered: unknown[] = [];
  Object.assign(w, { fetch: () => answers.now(), matchMedia: () => ({ matches: false }), setInterval: () => 0, rendered });
  const ctx = dom.getInternalVMContext();
  const run = (src: string, filename: string) => new vm.Script(src, { filename }).runInContext(ctx);
  run(script("common.js"), "common.js");
  const header = () => ({ at: w.document.getElementById("at")!.textContent, stale: w.document.getElementById("pulse")!.classList.contains("stale") });
  return { w, run, rendered, header };
}

const ok = (d: unknown): Answer => async () => ({ ok: true, status: 200, json: async () => d });
const refused = (status: number, body: () => Promise<unknown>): Answer => async () => ({ ok: false, status, json: body });
const notJson = async () => { throw new SyntaxError("Unexpected token <"); };

async function polled(answer: Answer) {
  const p = page("", { now: answer });
  p.run("poll('/api', (d) => rendered.push(d))", "poll");
  await settle();
  return { ...p.header(), rendered: p.rendered };
}

test("a page's poll renders a snapshot, and says why the board is not answering when it can", async () => {
  assert.deepEqual(await polled(ok({ at: "12:00:00" })), { at: "12:00:00", stale: false, rendered: [{ at: "12:00:00" }] });
  assert.deepEqual(await polled(refused(500, async () => ({ error: "boom" }))), { at: "not answering: boom", stale: true, rendered: [] }, "the board's own error, and its body is not rendered");
  assert.deepEqual(await polled(refused(502, notJson)), { at: "not answering: HTTP 502", stale: true, rendered: [] }, "a refusal with no JSON body says its status");
  assert.deepEqual(await polled(refused(500, async () => null)), { at: "not answering: HTTP 500", stale: true, rendered: [] }, "a JSON null body says its status");
});

test("a success whose body is not JSON says so, and a board that cannot be reached has no why to say", async () => {
  assert.deepEqual(await polled(async () => ({ ok: true, status: 200, json: notJson })), { at: "not answering: its answer is not JSON", stale: true, rendered: [] });
  assert.deepEqual(await polled(async () => { throw new TypeError("Failed to fetch"); }), { at: "not answering", stale: true, rendered: [] });
});

test("a board that answers again after a refusal takes the pulse out of stale", async () => {
  const answers = { now: refused(500, async () => ({ error: "boom" })) };
  const p = page("", answers);
  const tick = p.run("poll('/api', (d) => rendered.push(d))", "poll") as () => Promise<void>;
  await settle();
  assert.deepEqual(p.header(), { at: "not answering: boom", stale: true });
  answers.now = ok({ at: "12:00:02" });
  await tick();
  assert.deepEqual(p.header(), { at: "12:00:02", stale: false }, "the pulse is live again");
  assert.deepEqual(p.rendered, [{ at: "12:00:02" }]);
});

test("the GitHub page fetches through getJSON: a refusal says why and keeps the view, and a recovery clears it", async () => {
  const answers = { now: refused(500, async () => ({ error: "boom" })) };
  const p = page('<main id="root">before</main><div id="tip"></div><select id="repos"></select><input id="bots" type="checkbox">', answers);
  p.run(script("github.js"), "github.js");
  await settle();
  assert.deepEqual(p.header(), { at: "not answering: boom", stale: true });
  assert.equal(p.w.document.getElementById("root")!.textContent, "before", "a refusal renders nothing");
  answers.now = ok({ at: "12:00:03", loading: true, repos: [{}, {}] });
  p.run("load()", "reload");
  await settle();
  assert.deepEqual(p.header(), { at: "12:00:03", stale: false });
  assert.match(p.w.document.getElementById("root")!.textContent!, /reading GitHub for the first time, 2 repos/);
});
