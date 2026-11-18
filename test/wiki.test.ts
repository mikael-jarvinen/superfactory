import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { serve } from "../src/board/server.js";
import { ConfigError, loadConfig } from "../src/config.js";
import * as T from "../src/tickets/store.js";
import * as W from "../src/wiki/store.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempDir, tempWorkspace } from "./helpers.js";

// The wiki beside any tracker: TOML's tracker is Jira, and stays Jira.
const WIKI = `${TOML}
[wiki]

[[wiki.projects]]
key = "AGENTIC"
name = "Agentic development pipeline"
`;
const NO_TRACKER = TOML.replace(/\[tracker\][\s\S]*?done = "Done"\n/, "");
const LOCAL = `${NO_TRACKER}
[tracker]
kind = "local"

[[tracker.projects]]
key = "RPE"
name = "RPE Training App"

[[tracker.projects]]
key = "WEB"
name = "Website"
`;

const problems = (toml: string): string[] => {
  const dir = tempDir();
  writeFileSync(join(dir, "factory.toml"), toml);
  try {
    loadConfig(join(dir, "factory.toml"));
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
};

test("config: [wiki] beside Jira or no tracker, and a local tracker's own wiki where it always was", () => {
  assert.deepEqual(problems(WIKI), []);
  assert.deepEqual(problems(`${NO_TRACKER}\n[wiki]\n\n[[wiki.projects]]\nkey = "AGENTIC"\n`), []);
  assert.deepEqual(problems(`${TOML}\n[wiki]\n`), ["wiki.projects: missing; a wiki needs at least one [[wiki.projects]]"]);
  assert.deepEqual(problems(`${TOML}
[wiki]
colour = "red"

[[wiki.projects]]
key = "agentic"

[[wiki.projects]]
key = "OPS"

[[wiki.projects]]
key = "OPS"
`), [
    "wiki.projects[0].key: must be 2 to 10 capital letters or digits, starting with a letter, got \"agentic\"",
    "wiki.projects[2].key: \"OPS\" is already a project",
    "wiki.colour: unknown key",
  ]);
  assert.deepEqual(problems(`${LOCAL}\n[wiki]\n\n[[wiki.projects]]\nkey = "AGENTIC"\n`),
    ["wiki: a local tracker's projects already have a wiki; drop [wiki], or use [tracker] kind \"jira\" or \"none\""]);

  const jira = openWorkspace(tempWorkspace(WIKI));
  assert.equal(W.wikiDir(jira, "AGENTIC"), join(jira.stateDir, "wiki", "AGENTIC"), "durable state, by default");
  const custom = openWorkspace(tempWorkspace(WIKI.replace("[wiki]\n", '[wiki]\ndir = "notes"\n')));
  assert.equal(W.wikiDir(custom, "AGENTIC"), join(custom.config.dir, "notes", "AGENTIC"));
  const local = openWorkspace(tempWorkspace(LOCAL));
  assert.equal(W.wikiDir(local, "RPE"), join(T.trackerDir(local), "wiki", "RPE"), "a local tracker's wiki has not moved");
  assert.deepEqual(W.projects(local), [{ key: "RPE", name: "RPE Training App" }, { key: "WEB", name: "Website" }]);
  const none = openWorkspace(tempWorkspace(TOML));
  assert.equal(W.enabled(none), false);
  assert.throws(() => W.wikiDir(none, "AGENTIC"), /no wiki/);
});

test("a wiki beside Jira: the CLI, the /wiki page and its API, and no tickets anywhere", async () => {
  const dir = tempWorkspace(WIKI);
  const ws = openWorkspace(dir);
  assert.equal(T.enabled(ws), false);
  assert.equal(W.enabled(ws), true);

  const f = join(tempDir(), "page.md");
  writeFileSync(f, "What the pipeline is.\n");
  const run = (args: string[]) => factory(dir, args);
  let r = run(["wiki", "edit", "overview", "--file", f, "--title", "Overview"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(ws.stateDir, "wiki", "AGENTIC", "overview.md")));
  assert.match(run(["wiki", "list"]).stdout, /AGENTIC\/overview +Overview/);
  assert.match(run(["wiki", "show", "AGENTIC/overview"]).stdout, /What the pipeline is/);
  r = run(["wiki", "show", "RPE/overview"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no wiki project "RPE"/);
  r = run(["ticket", "list"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no local tracker/);

  const board = await serve(ws, { port: 0, host: "127.0.0.1", reviews: async () => "{}" });
  after(() => board.close());
  const status = async (p: string) => (await fetch(board.url + p)).status;
  const json = async (p: string) => (await fetch(board.url + p)).json();
  const post = (p: string, b: unknown) => fetch(board.url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  assert.equal(await status("/wiki"), 200);
  for (const p of ["/tickets", "/api/tickets", "/api/tickets/RPE-1"]) assert.equal(await status(p), 404, p);
  assert.deepEqual(await json("/api/tickets?summary=1"), { wiki: true }, "the header's links: the wiki only");
  assert.deepEqual(((await json("/api")) as { tracker: unknown }).tracker, { wiki: true });
  const list = (await json("/api/wiki")) as { projects: { key: string }[]; pages: { path: string }[] };
  assert.deepEqual(list.projects.map((p) => p.key), ["AGENTIC"]);
  assert.deepEqual(list.pages.map((p) => p.path), ["overview"]);

  const w = await post("/api/wiki/AGENTIC/learnings", { title: "Learnings", body: "x", base: null });
  assert.equal(w.status, 200);
  const page = ((await w.json()) as { page: W.Page }).page;
  assert.equal(page.project, "AGENTIC");
  assert.equal(W.history(ws, "AGENTIC", "learnings")[0]?.by, "Alex", "the board writes as the human");
  assert.equal((await post("/api/wiki/AGENTIC/learnings", { title: "Learnings", body: "y", base: "0000000000000000" })).status, 409);
  assert.equal((await post("/api/tickets", { project: "RPE", title: "x" })).status, 404, "no tickets to write to");
});

test("wiki remove: needs the sha it saw, keeps the last version in history, and drops the page from the list", () => {
  const dir = tempWorkspace(WIKI);
  const ws = openWorkspace(dir);
  const run = (args: string[]) => factory(dir, args);
  const f = join(tempDir(), "page.md");
  writeFileSync(f, "Thread one.\n");
  assert.equal(run(["wiki", "edit", "feedback", "--file", f, "--title", "Feedback"]).status, 0);
  assert.equal(run(["wiki", "edit", "feedback/slack-01", "--file", f, "--title", "Slack 01"]).status, 0);
  const first = W.read(ws, "AGENTIC", "feedback");
  writeFileSync(f, "Thread one, and a note.\n");
  assert.equal(run(["wiki", "edit", "feedback", "--file", f, "--base", first.sha]).status, 0);
  const last = W.read(ws, "AGENTIC", "feedback");

  let r = run(["wiki", "remove", "AGENTIC/feedback"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pass --base <sha>/);
  r = run(["wiki", "remove", "AGENTIC/feedback", "--base", first.sha]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /changed since it was opened; nothing was saved/);
  assert.ok(W.pageExists(ws, "AGENTIC", "feedback"), "a refused removal leaves the page");

  r = run(["wiki", "remove", "AGENTIC/feedback", "--base", last.sha, "--as", "ada"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AGENTIC\/feedback removed/);
  assert.equal(W.pageExists(ws, "AGENTIC", "feedback"), false);
  assert.deepEqual(W.list(ws, "AGENTIC").map((p) => p.path), ["feedback/slack-01"], "a child page is its own page and stays");
  const lines = readFileSync(join(ws.stateDir, "wiki", "AGENTIC", ".history", "feedback.jsonl"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { by: string; sha: string; title: string; body: string; removed?: boolean });
  assert.equal(lines.length, 3, "two saves and the removal");
  assert.deepEqual({ ...lines[2], t: undefined }, { t: undefined, by: "ada", sha: last.sha, title: "Feedback", body: last.body, removed: true });
  r = run(["wiki", "show", "AGENTIC/feedback"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no page AGENTIC\/feedback/);
  r = run(["wiki", "remove", "AGENTIC/feedback", "--base", last.sha]);
  assert.notEqual(r.status, 0, "nothing left to remove");
});

// The header as common.js draws it: what the snapshot's `tracker` says decides the links.
test("the header: a local tracker links its backlog and wiki, a wiki alone links only the wiki", () => {
  const nav = (t: unknown) => {
    const dom = new JSDOM('<header><nav><a href="/">board</a><a href="/messages">messages</a></nav></header><button id="theme"></button>',
      { runScripts: "outside-only", url: "http://board.test/wiki" });
    after(() => dom.window.close());
    Object.assign(dom.window, { fetch: async () => ({ ok: false, status: 404, json: async () => null }) });
    new vm.Script(readFileSync(new URL("../src/board/static/common.js", import.meta.url), "utf8"), { filename: "common.js" }).runInContext(dom.getInternalVMContext());
    (dom.window as unknown as { trackerNav: (t: unknown) => void }).trackerNav(t);
    return [...dom.window.document.querySelectorAll("header nav a")].map((a) => `${a.getAttribute("href")}${a.classList.contains("on") ? "*" : ""}`);
  };
  assert.deepEqual(nav({ wiki: true }), ["/", "/messages", "/wiki*"]);
  assert.deepEqual(nav({ backlog: 2 }), ["/", "/messages", "/tickets", "/wiki*"]);
  assert.deepEqual(nav(null), ["/", "/messages"]);
});
