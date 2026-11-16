import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// /tickets as the page runs it, in a window of its own, with rows laid out 40px apart by their
// place in the list, since jsdom has no layout. Every GET waits for `read` and is answered with the
// same six tickets; every POST is answered by `reply`. A wait the page aborts ends, as fetch does.
type Reply = { ok: true } | { ok: false; error: string };
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));
const hang = () => new Promise<never>(() => {});
function board(opts: { reply?: () => Promise<Reply>; read?: () => Promise<void>; url?: string } = {}) {
  const reply = opts.reply ?? (async () => ({ ok: true }) as Reply);
  const dom = new JSDOM('<button id="theme"></button><div id="pulse"></div><span id="at"></span><div id="root"></div>', { runScripts: "outside-only", url: opts.url ?? "http://board.test/tickets?state=all" });
  windows.push(dom);
  const w = dom.window;
  const tickets = [["RPE-1", "Todo"], ["RPE-2", "Todo"], ["RPE-3", "Todo"], ["RPE-4", "Todo"], ["RPE-5", "Done"], ["RPE-6", "Cancelled"]]
    .map(([key, state]) => ({ key, state, title: key, labels: [], comments: 0, updated: "2026-01-01T00:00:00Z", project: "RPE" }));
  const posts: unknown[] = [];
  let lists = 0;
  const aborted = (signal?: AbortSignal) => new Promise<never>((_, no) => signal?.addEventListener("abort", () => no(new Error("aborted"))));
  Object.assign(w, {
    fetch: async (url: string, o?: { method?: string; body?: string; signal?: AbortSignal }) => {
      if (o?.method === "POST") {
        posts.push(JSON.parse(o.body ?? "null"));
        const r = await Promise.race([reply(), aborted(o.signal)]);
        return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => (r.ok ? { ok: true } : { ok: false, error: r.error }) };
      }
      await Promise.race([(opts.read ?? (async () => {}))(), aborted(o?.signal)]);
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
  const ev = (el: Element, type: string, clientY: number) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 }));
  // press a row's grip, make one move to y, and report the row as drawn there
  const press = (key: string, y: number) => {
    const g = grip(key), row = g.closest(".row") as HTMLElement;
    const taken = !ev(g, "pointerdown", [...(row.parentNode as Element).children].indexOf(row) * 40 + 20);
    ev(g, "pointermove", y);
    return { order: order(), transform: row.style.transform, dragging: row.classList.contains("dragging"), taken, up: () => ev(g, "pointerup", y) };
  };
  const run = (code: string) => new vm.Script(code).runInContext(page);
  return { w, doc, run, order, press, posts, lists: () => lists, busy: () => doc.body.classList.contains("ranking"), err: () => doc.getElementById("err")?.textContent ?? "" };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
// waits for what a timer in the page brings about, without guessing how long the runner takes
async function until(cond: () => boolean, what: string) {
  for (const end = Date.now() + 5000; !cond(); await settle()) if (Date.now() > end) assert.fail(`never: ${what}`);
}
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

test("drag: a row dragged past the end of the list is drawn no lower than the end", async () => {
  const b = board({ url: "http://board.test/tickets" });
  await settle();
  const d = b.press("RPE-2", 400);
  assert.deepEqual(d.order, ["RPE-1", "RPE-3", "RPE-4", "RPE-2"]);
  assert.equal(d.transform, "translateY(0px)");
  d.up();
  await settle();
});

test("drag: a refused drop shows its error after the list is drawn again", async () => {
  const b = board({ reply: async () => ({ ok: false, error: "refused" }) });
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  assert.equal(b.err(), "refused");
  assert.deepEqual(b.order(), ["RPE-1", "RPE-2", "RPE-3", "RPE-4", "RPE-5", "RPE-6"]);
});

test("drag: a ticket opened while the drop is sent is not redrawn, nor given its refusal", async () => {
  const s = deferred();
  const b = board({ reply: s.reply });
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
  // the lock is off again, and the refusal is not kept for a later list
  b.w.history.pushState(null, "", "/tickets?state=all");
  await b.run("route()");
  await settle();
  assert.equal(b.err(), "");
  b.press("RPE-4", 5).up();
  await settle();
  assert.equal(b.posts.length, 2);
});

test("drag: a filter changed while the drop is sent still gets the list again, and the refusal", async () => {
  const s = deferred();
  const b = board({ reply: s.reply });
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

test("drag: a filter's list that answers after the drop's reload does not cover the refusal", async () => {
  const s = deferred();
  let slow = false;
  const b = board({ reply: s.reply, read: () => (slow ? ((slow = false), new Promise<void>((r) => setTimeout(r, 80))) : Promise.resolve()) });
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  // the filter's read is slow; the drop's reload, started after it, answers first
  slow = true;
  b.run("go({state: 'open'})");
  s.release({ ok: false, error: "refused" });
  await settle();
  assert.equal(b.err(), "refused");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(b.err(), "refused", "still shown once the filter's read is in");
  assert.equal(b.order().length, 4, "the open list");
});

test("drag: no second drag starts while a drop is being sent", async () => {
  const s = deferred();
  const b = board({ reply: s.reply });
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  assert.ok(b.busy(), "the grips show the lock");
  const second = b.press("RPE-4", 45);
  assert.equal(second.dragging, false);
  assert.ok(second.taken, "the press is the page's, not the row link's");
  second.up();
  await settle();
  assert.equal(b.posts.length, 1);
  s.release({ ok: true });
  await settle();
  assert.ok(!b.busy());
  const third = b.press("RPE-4", 5);
  assert.equal(third.dragging, true, "the redrawn list drags again");
  third.up();
  await settle();
  assert.equal(b.posts.length, 2);
});

test("drag: a drop the board never answers is given up, and dragging works again", async () => {
  let posting: () => Promise<Reply> = hang;
  const b = board({ reply: () => posting() });
  b.run("RANK_MS = 200");
  await settle();
  b.press("RPE-3", 5).up();
  await settle();
  assert.equal(b.press("RPE-4", 5).dragging, false, "locked until the timeout");
  await until(() => b.err() !== "", "the timeout is shown");
  assert.equal(b.err(), "the board did not answer in 0.2 s; the drop may still land, so check the order");
  posting = async () => ({ ok: true });
  b.press("RPE-4", 5).up();
  await settle();
  assert.equal(b.posts.length, 2);
});

test("drag: when the reload after a timed-out drop hangs too, the next drag still posts", async () => {
  let posting: () => Promise<Reply> = hang, reading: () => Promise<void> = async () => {};
  const b = board({ reply: () => posting(), read: () => reading() });
  b.run("RANK_MS = 100");
  await settle();
  reading = hang;
  b.press("RPE-3", 5).up();
  await settle();
  assert.ok(b.busy());
  await until(() => !b.busy(), "the lock clears when the drop times out");
  // the reload is still waiting, and the moved list is still shown
  posting = async () => ({ ok: true });
  reading = async () => {};
  const next = b.press("RPE-1", 125);
  assert.equal(next.dragging, true);
  next.up();
  await settle();
  assert.equal(b.posts.length, 2);
  // the stale reload gives up later and draws nothing over the newer list, which shows the timeout
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.order().length, 6);
  assert.match(b.err(), /did not answer in 0\.1 s/);
});
