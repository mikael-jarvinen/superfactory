import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// /tickets as the page runs it, in a window of its own, with rows laid out 40px apart by their
// place in the list, since jsdom has no layout. Every GET is answered with the same six tickets, and
// every POST by `reply`.
type Reply = { ok: true } | { ok: false; error: string };
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));
function board(reply: () => Promise<Reply> = async () => ({ ok: true })) {
  const dom = new JSDOM('<button id="theme"></button><div id="pulse"></div><span id="at"></span><div id="root"></div>', { runScripts: "outside-only", url: "http://board.test/tickets?state=all" });
  windows.push(dom);
  const w = dom.window;
  const tickets = [["RPE-1", "Todo"], ["RPE-2", "Todo"], ["RPE-3", "Todo"], ["RPE-4", "Todo"], ["RPE-5", "Done"], ["RPE-6", "Cancelled"]]
    .map(([key, state]) => ({ key, state, title: key, labels: [], comments: 0, updated: "2026-01-01T00:00:00Z", project: "RPE" }));
  const posts: unknown[] = [];
  let lists = 0;
  Object.assign(w, {
    fetch: async (url: string, o?: { method?: string; body?: string; signal?: AbortSignal }) => {
      if (o?.method === "POST") {
        posts.push(JSON.parse(o.body ?? "null"));
        // a hung reply is given up when the page aborts it, as fetch does
        const r = await Promise.race([reply(), new Promise<never>((_, no) => o.signal?.addEventListener("abort", () => no(new Error("aborted"))))]);
        return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => (r.ok ? { ok: true } : { ok: false, error: r.error }) };
      }
      if (url.split("?")[0] === "/api/tickets") lists++;
      return { ok: true, status: 200, json: async () => ({ tickets, projects: [{ key: "RPE", name: "R" }], states: ["Todo", "Done", "Cancelled"] }) };
    },
  });
  w.Element.prototype.getBoundingClientRect = function (this: Element) {
    const i = [...(this.parentNode as Element).children].indexOf(this);
    return { top: i * 40, height: 40, bottom: i * 40 + 40, left: 0, right: 100, width: 100, x: 0, y: i * 40, toJSON: () => ({}) };
  };
  w.Element.prototype.setPointerCapture = () => {};
  w.scrollBy = () => {};
  const page = dom.getInternalVMContext();
  for (const f of ["common.js", "tracker.js", "tickets.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(page);
  const doc = w.document;
  const order = () => [...doc.querySelectorAll<HTMLElement>(".row")].map((r) => r.dataset.key);
  const grip = (key: string) => doc.querySelector(`.row[data-key="${key}"] .grip`) as Element;
  const ev = (el: Element, type: string, clientY: number) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientY, button: 0 }));
  // press a row's grip, make one move to y, and report the row as drawn there
  const press = (key: string, y: number) => {
    const g = grip(key), row = g.closest(".row") as HTMLElement;
    ev(g, "pointerdown", [...(row.parentNode as Element).children].indexOf(row) * 40 + 20);
    ev(g, "pointermove", y);
    return { order: order(), transform: row.style.transform, dragging: row.classList.contains("dragging"), up: () => ev(g, "pointerup", y) };
  };
  const run = (code: string) => new vm.Script(code).runInContext(page);
  return { w, doc, run, order, press, posts, lists: () => lists, err: () => doc.getElementById("err")?.textContent ?? "" };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const deferred = () => {
  let release!: (r: Reply) => void;
  const p = new Promise<Reply>((r) => (release = r));
  return { reply: () => p, release };
};

test("drag: one move across several rows drops the row where it is drawn", async () => {
  const b = board();
  await settle();
  const d = b.press("RPE-4", 5);
  assert.deepEqual(d.order, ["RPE-4", "RPE-1", "RPE-2", "RPE-3", "RPE-5", "RPE-6"]);
  d.up();
  await settle();
  assert.deepEqual(b.posts, [{ op: "rank", after: null, before: "RPE-1" }]);
});

test("drag: an open row stops above the closed ones, and is drawn no lower", async () => {
  const b = board();
  await settle();
  const d = b.press("RPE-1", 235);
  assert.deepEqual(d.order, ["RPE-2", "RPE-3", "RPE-4", "RPE-1", "RPE-5", "RPE-6"]);
  assert.equal(d.transform, "translateY(0px)");
  d.up();
  await settle();
  assert.deepEqual(b.posts, [{ op: "rank", after: "RPE-4", before: "RPE-5" }]);
});

test("drag: a refused drop shows its error after the list is drawn again", async () => {
  const b = board(async () => ({ ok: false, error: "refused" }));
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  assert.equal(b.err(), "refused");
  assert.deepEqual(b.order(), ["RPE-1", "RPE-2", "RPE-3", "RPE-4", "RPE-5", "RPE-6"]);
});

test("drag: a ticket opened while the drop is sent is not redrawn, nor given its refusal", async () => {
  const s = deferred();
  const b = board(s.reply);
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  // the ticket's address without its view, so only a list drawn by the drop could change the page
  b.w.history.pushState(null, "", "/tickets?key=RPE-2");
  const lists = b.lists(), page = b.doc.body.innerHTML;
  s.release({ ok: false, error: "refused" });
  await settle();
  assert.equal(b.lists(), lists, "no reload of the list");
  assert.equal(b.doc.body.innerHTML, page, "nothing drawn or flashed");
  // the lock is off again
  b.w.history.pushState(null, "", "/tickets?state=all");
  await b.run("route()");
  await settle();
  b.press("RPE-4", 5).up();
  await settle();
  assert.equal(b.posts.length, 2);
});

test("drag: a filter changed while the drop is sent still gets the list again, and the refusal", async () => {
  const s = deferred();
  const b = board(s.reply);
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  b.run("go({state: 'open'})");
  await settle();
  const lists = b.lists();
  s.release({ ok: false, error: "refused" });
  await settle();
  assert.equal(b.lists(), lists + 1, "the list is read again");
  assert.equal(b.err(), "refused");
  assert.equal(new URL(b.w.location.href).search, "?state=open");
});

test("drag: a drop the board never answers is given up, and dragging works again", async () => {
  let hang = true;
  const b = board(() => (hang ? new Promise<Reply>(() => {}) : Promise.resolve({ ok: true })));
  b.run("RANK_MS = 50");
  await settle();
  b.press("RPE-3", 5).up();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.err(), "the board did not answer in 0.05 s");
  hang = false;
  b.press("RPE-4", 5).up();
  await settle();
  assert.equal(b.posts.length, 2);
});

test("drag: no second drag starts while a drop is being sent", async () => {
  const s = deferred();
  const b = board(s.reply);
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  const second = b.press("RPE-4", 45);
  assert.equal(second.dragging, false);
  second.up();
  await settle();
  assert.equal(b.posts.length, 1);
  s.release({ ok: true });
  await settle();
  const third = b.press("RPE-4", 5);
  assert.equal(third.dragging, true, "the redrawn list drags again");
  third.up();
  await settle();
  assert.equal(b.posts.length, 2);
});
