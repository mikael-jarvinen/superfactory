import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// The message page's scripts run here as the page runs them: one after another in a window of their
// own, sharing its globals. The build copies the static files next to the compiled tests.
const dom = new JSDOM('<button id="theme"></button>', { runScripts: "outside-only" });
const page = dom.getInternalVMContext();
for (const f of ["common.js", "marked.umd.js", "purify.min.js", "markdown.js"])
  new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(page);
const run = <T>(code: string): T => new vm.Script(code).runInContext(page) as T;
const md = run<(text: string) => string>("md");
// The rendered message as the page holds it, to ask what is in it.
const body = (text: string) => {
  const div = dom.window.document.createElement("div");
  div.innerHTML = md(text);
  return div;
};
const a = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

test("links go to http and https only, in a new tab; any other scheme stays the text that was written", () => {
  assert.equal(md("see [PR 61](https://github.com/acme/web/pull/61) now"), `<p>see ${a("https://github.com/acme/web/pull/61", "PR 61")} now</p>\n`);
  for (const bad of ["[x](javascript:alert(1))", "[x](JavaScript:alert(1))", "[x](file:///etc/passwd)", "[x](data:text/html,hi)"])
    assert.equal(md(bad), `<p>${bad}</p>\n`);
  assert.equal(body('[x](https://x.test/"onmouseover="alert(1))').querySelector("a")?.getAttributeNames().join(), "href,target,rel");
  // Bare URLs are links too, as GitHub makes them.
  assert.equal(md("see https://x.test/pull/61"), `<p>see ${a("https://x.test/pull/61", "https://x.test/pull/61")}</p>\n`);
});

test("raw HTML in a message is shown as text, never rendered", () => {
  assert.equal(md('<script>alert("x")</script>'), '<p>&lt;script&gt;alert("x")&lt;/script&gt;</p>');
  assert.equal(md("hi <img src=x onerror=alert(1)> there"), "<p>hi &lt;img src=x onerror=alert(1)&gt; there</p>\n");
  assert.equal(body('<a href="javascript:x">a</a> <b>b</b>').querySelectorAll("a, b, img, script").length, 0);
  // Whatever marked emits, the sanitiser keeps every href and src to http and https.
  assert.equal(run<string>(`DOMPurify.sanitize('<a href="javascript:x">a</a><img src="data:x">', {ADD_ATTR: ['target']})`), "<a>a</a><img>");
});

test("images render from http and https only", () => {
  const b = body("![shot](https://x.test/i.png) ![bad](javascript:x) ![f](file:///x.png)");
  assert.deepEqual([...b.querySelectorAll("img")].map((i) => [i.getAttribute("src"), i.getAttribute("alt")]), [["https://x.test/i.png", "shot"]]);
  assert.match(b.textContent ?? "", /!\[bad\]\(javascript:x\) !\[f\]\(file:\/\/\/x\.png\)/);
});

test("inline forms and line breaks", () => {
  assert.equal(md("**bold** ~~gone~~ `a < b` *it*"), "<p><strong>bold</strong> <del>gone</del> <code>a &lt; b</code> <em>it</em></p>\n");
  assert.equal(md("line one\nline two\n\nnew para"), "<p>line one<br>line two</p>\n<p>new para</p>\n");
});

test("blocks: lists, task lists, a table, fenced code, a heading and a quote", () => {
  const lists = body("- one\n- [x] done\n- [ ] todo\n\n1. a\n2. b");
  assert.deepEqual([...lists.querySelectorAll("ul > li")].map((li) => li.textContent?.trim()), ["one", "done", "todo"]);
  assert.deepEqual([...lists.querySelectorAll("input")].map((i) => [i.getAttribute("type"), i.hasAttribute("checked"), i.hasAttribute("disabled")]),
    [["checkbox", true, true], ["checkbox", false, true]]);
  assert.equal(lists.querySelectorAll("ol > li").length, 2);

  const table = body("| a | b |\n|---|:-:|\n| 1 | 2 |");
  assert.deepEqual([...table.querySelectorAll("th, td")].map((c) => c.textContent), ["a", "b", "1", "2"]);

  assert.equal(md("```js\nif (a < b) { x(\"<b>\") }\n```"), '<pre><code class="language-js">if (a &lt; b) { x("&lt;b&gt;") }\n</code></pre>\n');
  assert.equal(md("# Heading\n> quoted\n> more"), "<h1>Heading</h1>\n<blockquote>\n<p>quoted<br>more</p>\n</blockquote>\n");
});
