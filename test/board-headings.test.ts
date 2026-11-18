import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// The board as the page runs it, given one snapshot with a team and stacks. The Team and Stacks
// headings open and shut their sections; each stays a heading by holding its button, not by sitting
// inside one, as an h2 inside a button is not a heading to a screen reader.
const snapshot = {
  at: "12:00:00", human: "Alex", avatars: {}, plumbing: [],
  teams: [{ key: "lead", title: "Lead", members: [{ name: "lead", alive: true }] }, { key: "a", title: "A", members: [{ name: "ann", alive: false }] }],
  stacks: { present: true, checked_s: 5, stacks: [{ label: "web", slot: 1, stack: "web", host: "h", up: 1, of: 1, sites: [{ name: "s", link: "http://s", up: true, owner: null }] }] },
  columns: [], tickets: [], waiting_on_you: [], descriptions: {},
};
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));
async function board() {
  const dom = new JSDOM('<header><nav></nav></header><button id="theme"></button><div id="pulse"></div><span id="at"></span><div id="root"></div>', { runScripts: "outside-only", url: "http://board.test/" });
  windows.push(dom);
  const w = dom.window;
  Object.assign(w, { fetch: async () => ({ ok: true, status: 200, json: async () => snapshot }), matchMedia: () => ({ matches: false }) });
  const page = dom.getInternalVMContext();
  for (const f of ["common.js", "board.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(page);
  for (const end = Date.now() + 5000; !w.document.querySelector(".teamsum");) {
    if (Date.now() > end) assert.fail("the board never rendered");
    await new Promise((r) => setTimeout(r, 20));
  }
  return w.document;
}

test("the Team and Stacks toggles sit inside their h2, and the h2 holds nothing else", async () => {
  const doc = await board();
  for (const [sel, title] of [[".teamsum", "Team"], [".stacksum", "Stacks"]] as const) {
    const b = doc.querySelector(sel) as HTMLElement;
    const h = b.parentElement as HTMLElement;
    assert.equal(h.tagName, "H2", `${sel}'s parent`);
    assert.equal(h.children.length, 1, `${sel}'s h2 holds only the button`);
    assert.equal(b.querySelector("h2, h3, div, section"), null, `${sel} holds phrasing content only`);
    assert.equal(b.querySelector(".ttl")?.textContent, title);
  }
  // the toggle still works from inside the heading
  const t = doc.querySelector(".teamsum") as HTMLElement;
  const open = t.getAttribute("aria-expanded");
  t.querySelector(".ttl")!.dispatchEvent(new doc.defaultView!.MouseEvent("click", { bubbles: true }));
  assert.notEqual(t.getAttribute("aria-expanded"), open);
  assert.equal(doc.querySelector(".team")!.classList.contains("shut"), open === "true");
  const s = doc.querySelector(".stacksum") as HTMLElement;
  s.dispatchEvent(new doc.defaultView!.MouseEvent("click", { bubbles: true }));
  assert.equal(s.getAttribute("aria-expanded"), "true");
  assert.ok(doc.querySelector(".side")!.classList.contains("open"));
});
