import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// The board as the page runs it: a card's PR link with its assignee beside it, and one without.
const prOf = (number: number, assignees: unknown[]) => ({ repo: "lyyti-classic", number, url: `https://github.com/lyytioy/lyyti-classic/pull/${number}`, review: null, assignees });
const snapshot = {
  at: "12:00:00", human: "Alex", avatars: {}, plumbing: [],
  teams: [{ key: "lead", title: "Lead", members: [{ name: "lead", alive: true }] }],
  stacks: { present: false, stacks: [] },
  columns: ["building"], waiting_on_you: [], descriptions: {},
  tickets: [{
    ticket: "CL-2342", title: "AI plan", column: "building", agent: null, local: false, age_min: 5, question: null, line: null, design: null,
    prs: [prOf(8763, [{ login: "Lundis", name: "Lundis <Lundqvist>", avatar: "https://avatars.githubusercontent.com/u/1?s=40&v=4" }]), prOf(8764, [])],
  }],
};
const windows: JSDOM[] = [];
after(() => windows.forEach((d) => d.window.close()));

test("a PR link shows its assignee's avatar and name, and a PR nobody is assigned shows nothing", async () => {
  const dom = new JSDOM('<header><nav></nav></header><button id="theme"></button><div id="pulse"></div><span id="at"></span><div id="root"></div>', { runScripts: "outside-only", url: "http://board.test/" });
  windows.push(dom);
  const w = dom.window;
  Object.assign(w, { fetch: async () => ({ ok: true, status: 200, json: async () => snapshot }), matchMedia: () => ({ matches: false }) });
  const page = dom.getInternalVMContext();
  for (const f of ["common.js", "board.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(page);
  for (const end = Date.now() + 5000; !w.document.querySelector(".card .prl");) {
    if (Date.now() > end) assert.fail("the board never rendered");
    await new Promise((r) => setTimeout(r, 20));
  }
  const [withOne, without] = [...w.document.querySelectorAll(".card .prl")] as HTMLElement[];
  const asg = withOne!.querySelector(".asg") as HTMLElement;
  assert.equal(asg.previousElementSibling?.tagName, "A", "right after the PR link");
  assert.equal(asg.textContent, "Lundis <Lundqvist>", "the name, as text");
  assert.equal(asg.getAttribute("title"), "assigned to Lundis");
  const img = asg.querySelector("img") as HTMLImageElement;
  assert.equal(img.getAttribute("src"), "https://avatars.githubusercontent.com/u/1?s=40&v=4");
  assert.equal(img.getAttribute("width"), "16");
  assert.equal(without!.querySelector(".asg"), null);
});
