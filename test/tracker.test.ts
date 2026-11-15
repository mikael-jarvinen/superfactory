import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { postMessage } from "../src/board/inbox.js";
import { serve } from "../src/board/server.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { checkMove, cliActor } from "../src/tickets/guard.js";
import * as T from "../src/tickets/store.js";
import * as W from "../src/wiki/store.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempDir, tempWorkspace } from "./helpers.js";

const NO_TRACKER = TOML.replace(/\[tracker\][\s\S]*?done = "Done"\n/, "");
const LOCAL = (extra = "") => `${NO_TRACKER}
[tracker]
kind = "local"
${extra}
[[tracker.projects]]
key = "RPE"
name = "RPE Training App"
labels = ["task", "story", "phase:mvp"]

[[tracker.projects]]
key = "WEB"
name = "Website"
`;
const ONE = `${NO_TRACKER}
[tracker]
kind = "local"

[[tracker.projects]]
key = "RPE"
name = "RPE"
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

test("config: a local tracker takes projects, and nothing else does", () => {
  assert.deepEqual(problems(LOCAL()), []);
  assert.deepEqual(problems(`${NO_TRACKER}\n[tracker]\nkind = "local"\n`), ["tracker.projects: missing; a local tracker needs at least one [[tracker.projects]]"]);
  assert.deepEqual(problems(`${NO_TRACKER}
[tracker]
kind = "local"

[[tracker.projects]]
key = "rpe"

[[tracker.projects]]
key = "WEB"
labels = ["Bad Label"]

[[tracker.projects]]
key = "OPS"

[[tracker.projects]]
key = "OPS"
`), [
    "tracker.projects[0].key: must be 2 to 10 capital letters or digits, starting with a letter, got \"rpe\"",
    "tracker.projects[1].labels: \"Bad Label\" is not a label: lower-case words, digits, ':' and '-'",
    "tracker.projects[3].key: \"OPS\" is already a project",
  ]);
  assert.deepEqual(problems(TOML.replace('kind = "jira"', 'kind = "jira"\ndir = "x"\nasked_from = ["y"]') + '\n[[tracker.projects]]\nkey = "RPE"\n'), [
    "tracker.projects: only a local tracker has projects; kind is \"jira\"",
    "tracker.dir: only a local tracker has a dir; kind is \"jira\"",
    "tracker.asked_from: only a local tracker reads it; kind is \"jira\"",
  ]);
});

// The rule Mikko set: issue tracking is off unless asked for. A Jira workspace, or one with no
// tracker, has no ticket or wiki command, no /tickets or /wiki page, no API and no header link.
for (const [name, toml] of [["jira", TOML], ["none", NO_TRACKER]] as const)
  test(`off by default: a ${name} workspace has no local tracker anywhere`, async () => {
    const dir = tempWorkspace(toml);
    for (const args of [["ticket", "list"], ["ticket", "create", "--title", "x"], ["wiki", "list"]]) {
      const r = factory(dir, args);
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, /no local tracker/, args.join(" "));
    }
    const ws = openWorkspace(dir);
    assert.equal(T.enabled(ws), false);
    const board = await serve(ws, { port: 0, host: "127.0.0.1", reviews: async () => "{}" });
    after(() => board.close());
    for (const p of ["/tickets", "/wiki", "/api/tickets", "/api/tickets?summary=1", "/api/tickets/RPE-1", "/api/wiki", "/api/wiki/RPE/x"])
      assert.equal((await fetch(board.url + p)).status, 404, p);
    const post = await fetch(board.url + "/api/tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: "RPE", title: "x" }) });
    assert.equal(post.status, 404);
    const snap = (await (await fetch(board.url + "/api")).json()) as { tracker: unknown };
    assert.equal(snap.tracker, null, "the board's header gets no tracker links");
  });

test("store: numbers per project, the floor, events folded, a bare number with one project", () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  const a = T.create(ws, { project: "RPE", title: "first", by: "ada" });
  const b = T.create(ws, { project: "WEB", title: "web first", by: "ada" });
  assert.equal(a.key, "RPE-1");
  assert.equal(b.key, "WEB-1");
  T.setFloor(ws, "RPE", 341);
  assert.equal(T.create(ws, { project: "RPE", title: "after the import", by: "ada" }).key, "RPE-341");
  T.setFloor(ws, "RPE", 10);
  assert.equal(T.create(ws, { project: "RPE", title: "a floor never goes down", by: "ada" }).key, "RPE-342");
  // an import keeps its number and time, and the next new one goes past it
  T.create(ws, { project: "WEB", number: 40, t: "2026-01-02T03:04:05Z", title: "imported", by: "Alex", state: "Done", source: { system: "plane" } });
  assert.equal(T.create(ws, { project: "WEB", title: "next", by: "ada" }).key, "WEB-41");
  assert.throws(() => T.create(ws, { project: "WEB", number: 40, title: "again", by: "ada" }), /EEXIST/);

  T.describe(ws, "RPE-1", "more", "ada");
  T.label(ws, "RPE-1", "add", "task", "ada");
  assert.throws(() => T.label(ws, "RPE-1", "add", "nope", "ada"), /not a label of RPE; labels: task, story, phase:mvp/);
  T.label(ws, "WEB-1", "add", "anything-goes", "ada");
  T.relate(ws, "RPE-1", "blocked_by", "WEB-1", "ada");
  T.link(ws, "RPE-1", "https://example.com/x", "x", "ada");
  T.comment(ws, "RPE-1", "a comment", "ada");
  T.move(ws, "RPE-1", "Todo", "Alex");
  const tk = T.load(ws, "RPE-1");
  assert.equal(tk.state, "Todo");
  assert.equal(tk.body, "more");
  assert.deepEqual(tk.labels, ["task"]);
  assert.deepEqual(tk.relations, [{ kind: "blocked_by", to: "WEB-1" }]);
  assert.equal(tk.comments.length, 1);
  T.relate(ws, "RPE-1", "blocked_by", "WEB-1", "ada", "unrelate");
  assert.deepEqual(T.load(ws, "RPE-1").relations, []);
  assert.deepEqual(T.list(ws, "WEB").map((t) => t.key), ["WEB-1", "WEB-40", "WEB-41"]);
  assert.equal(T.load(ws, "WEB-40").created, "2026-01-02T03:04:05Z");
  assert.throws(() => T.resolveKey(ws, "12"), /name the project/);
  assert.throws(() => T.resolveKey(ws, "OPS-1"), /no project "OPS"/);

  const one = openWorkspace(tempWorkspace(ONE));
  assert.equal(T.resolveKey(one, "12"), "RPE-12");
});

test("guard: Backlog needs the human's words, onward from In Review needs the merge, back is free", () => {
  const dir = tempWorkspace(LOCAL());
  const convo = join(dir, "conversation.md");
  writeFileSync(convo, "### Alex 10:02\nplease pick up the login rewrite today\n\n### Ada\nok\n");
  writeFileSync(join(dir, "factory.toml"), LOCAL(`asked_from = ["${convo}"]`));
  const ws = openWorkspace(dir);
  postMessage(ws, "ship the planner change once it is green");
  const agent = cliActor(ws, undefined);
  assert.deepEqual(agent, { human: false, name: "ada" }, "the CLI writes as the lead by default");
  assert.throws(() => cliActor(ws, "Alex"), /writes as an agent/);
  assert.throws(() => cliActor(ws, "zed"), /no such agent/);

  const tk = T.create(ws, { project: "RPE", title: "t", by: "ada" });
  assert.throws(() => checkMove(ws, tk, "Todo", agent), /REFUSED: RPE-1 is in Backlog/);
  assert.throws(() => checkMove(ws, tk, "Todo", agent, { asked: "short" }), /at least 12/);
  assert.throws(() => checkMove(ws, tk, "Todo", agent, { asked: "words nobody ever said" }), /not in any of Alex's messages/);
  assert.deepEqual(checkMove(ws, tk, "Todo", agent, { asked: "pick up the   login rewrite" }), { asked: "pick up the login rewrite" }, "from the conversation file");
  assert.deepEqual(checkMove(ws, tk, "Todo", agent, { asked: "the planner change" }), { asked: "the planner change" }, "from the message page");
  assert.throws(() => checkMove(ws, tk, "Todo", agent, { asked: "ok" + " ".repeat(20) }), /at least 12/);
  assert.deepEqual(checkMove(ws, tk, "Todo", { human: true, name: "Alex" }), {}, "the human is never refused");

  T.move(ws, "RPE-1", "In Review", "Alex");
  const rev = T.load(ws, "RPE-1");
  assert.throws(() => checkMove(ws, rev, "Done", agent), /Alex's merge/);
  assert.throws(() => checkMove(ws, rev, "Done", agent, { merged: "yes" }), /PR number/);
  assert.deepEqual(checkMove(ws, rev, "Done", agent, { merged: "#95" }), { merged: "#95" });
  assert.deepEqual(checkMove(ws, rev, "In Progress", agent), {}, "back to work is free");
});

test("the CLI: create, list by project, move with its guards, describe appends, wiki edit with a base", () => {
  const dir = tempWorkspace(LOCAL());
  const ok = (args: string[]) => {
    const r = factory(dir, args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const no = (args: string[], re: RegExp) => {
    const r = factory(dir, args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, re);
  };
  assert.match(ok(["ticket", "create", "--project", "RPE", "--title", "Plan view", "--body", "first words", "--label", "task"]), /RPE-1 filed in Backlog/);
  ok(["ticket", "create", "--project", "WEB", "--title", "Landing page", "--as", "bea"]);
  no(["ticket", "create", "--title", "which project"], /--project is needed/);
  assert.match(ok(["ticket", "list", "--project", "RPE"]), /RPE-1 +Backlog/);
  assert.doesNotMatch(ok(["ticket", "list", "--project", "RPE"]), /WEB-1/);
  assert.match(ok(["ticket", "list"]), /WEB-1/);
  no(["ticket", "move", "RPE-1", "Todo"], /REFUSED/);
  postMessage(openWorkspace(dir), "go ahead with the plan view please");
  assert.match(ok(["ticket", "move", "RPE-1", "Todo", "--asked", "go ahead with the plan view"]), /Backlog -> Todo/);
  ok(["ticket", "move", "RPE-1", "In Review"]);
  no(["ticket", "move", "RPE-1", "Done"], /--merged/);
  ok(["ticket", "move", "RPE-1", "Done", "--merged", "#12"]);
  const log = readFileSync(join(dir, "state", "tracker", "tickets", "RPE", "RPE-1.jsonl"), "utf8");
  assert.match(log, /"asked":"go ahead with the plan view"/);
  assert.match(log, /"merged":"#12"/);
  ok(["ticket", "describe", "RPE-1", "second words"]);
  ok(["ticket", "comment", "RPE-1", "a note", "--as", "cal"]);
  const shown = ok(["ticket", "show", "RPE-1"]);
  assert.match(shown, /first words\n\nsecond words/);
  assert.match(shown, /1 comment/);
  assert.match(ok(["ticket", "comments", "RPE-1"]), /--- cal, .*\na note/);
  no(["ticket", "label", "RPE-1", "add", "nope"], /not a label of RPE/);
  no(["ticket", "move", "RPE-1", "Shipped"], /unknown state/);

  const f = join(dir, "page.md");
  writeFileSync(f, "# Vision\n\nwords\n");
  ok(["wiki", "edit", "RPE/vision", "--file", f, "--title", "Vision"]);
  no(["wiki", "edit", "RPE/vision", "--file", f], /--base/);
  const sha = /sha ([0-9a-f]{16})/.exec(ok(["wiki", "show", "RPE/vision"]))?.[1] as string;
  no(["wiki", "edit", "RPE/vision", "--file", f, "--base", "0000000000000000"], /changed since/);
  ok(["wiki", "edit", "RPE/vision", "--file", f, "--base", sha]);
  assert.match(ok(["wiki", "list"]), /RPE\/vision +Vision/);
  assert.equal(ok(["wiki", "history", "RPE/vision"]).trim().split("\n").length, 2);
  no(["wiki", "show", "vision"], /name the project/);
});

test("wiki store: a save over a changed page is refused, and a new page must not exist", () => {
  const ws = openWorkspace(tempWorkspace(LOCAL()));
  const a = W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "one", by: "Alex", base: null });
  assert.throws(() => W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "x", by: "Alex", base: null }), W.Conflict);
  const b = W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "two", by: "Alex", base: a.sha });
  assert.throws(() => W.save(ws, { project: "RPE", path: "spec", title: "Spec", body: "three", by: "ada", base: a.sha }), W.Conflict);
  W.save(ws, { project: "RPE", path: "spec/child", title: "Child", body: "c", by: "Alex", base: null });
  assert.deepEqual(W.list(ws, "RPE").map((p) => p.path), ["spec", "spec/child"]);
  assert.equal(W.read(ws, "RPE", "spec").body, "two\n");
  assert.equal(b.title, "Spec");
  assert.throws(() => W.checkPath("../etc"), /not a page path/);
  assert.throws(() => W.checkPath("Spec"), /not a page path/);
  assert.equal(W.slug("Strength as one hidden number"), "strength-as-one-hidden-number");
  assert.equal(W.slug("How the planner thinks (RPE-217)"), "how-the-planner-thinks-rpe-217");
});

test("the board: tickets and wiki pages, the API writes as the human, a stale wiki save is 409", async () => {
  const dir = tempWorkspace(LOCAL());
  const ws = openWorkspace(dir);
  const board = await serve(ws, { port: 0, host: "127.0.0.1", reviews: async () => "{}" });
  after(() => board.close());
  const get = async (p: string) => {
    const r = await fetch(board.url + p);
    return { status: r.status, body: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as Record<string, unknown>) : await r.text() };
  };
  const post = async (p: string, b: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) => {
    const r = await fetch(board.url + p, { method: "POST", headers, body: JSON.stringify(b) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  assert.equal((await get("/tickets")).status, 200);
  assert.equal((await get("/wiki")).status, 200);
  assert.equal((await get("/static/tickets.js")).status, 200);

  const c = await post("/api/tickets", { project: "RPE", title: "From the phone", body: "b", labels: ["story"], state: "Todo" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((c.body.ticket as T.Ticket).key, "RPE-1");
  assert.equal((c.body.ticket as T.Ticket).by, "Alex");
  assert.equal((await post("/api/tickets", { project: "RPE", title: "x" }, { "Content-Type": "text/plain" })).status, 403, "only a same-site JSON post");
  assert.equal((await post("/api/tickets", { project: "RPE", title: "x" }, { "Content-Type": "application/json", Origin: "http://evil.example" })).status, 403);
  T.create(ws, { project: "RPE", title: "an agent's", by: "ada" });
  assert.equal((await get("/api")).status, 200);
  assert.deepEqual(((await get("/api")).body as { tracker: unknown }).tracker, { backlog: 1 });
  assert.deepEqual((await get("/api/tickets?summary=1")).body, { backlog: 1 });

  for (const op of [{ op: "move", to: "In Review" }, { op: "move", to: "Done" }, { op: "comment", body: "nice" }, { op: "label", name: "task", add: true },
    { op: "title", title: "Renamed" }, { op: "body", body: "replaced" }, { op: "relate", kind: "relates_to", to: "RPE-2" }, { op: "link", url: "https://x.example/1" }]) {
    const r = await post("/api/tickets/RPE-1", op);
    assert.equal(r.status, 200, `${JSON.stringify(op)}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await post("/api/tickets/RPE-1", { op: "label", name: "nope", add: true })).status, 400);
  assert.equal((await post("/api/tickets/RPE-1", { op: "move", to: "Shipped" })).status, 400);
  assert.equal((await post("/api/tickets/RPE-9", { op: "comment", body: "x" })).status, 404);
  const tk = (await get("/api/tickets/RPE-1")).body as unknown as T.Ticket;
  assert.equal(tk.state, "Done", "the human moves straight on from In Review");
  assert.equal(tk.title, "Renamed");
  assert.equal(tk.body, "replaced");
  assert.deepEqual(tk.labels, ["story", "task"]);
  assert.equal(tk.comments[0]?.by, "Alex");
  const list = (await get("/api/tickets?project=RPE")).body as { tickets: { key: string; comments: number }[] };
  assert.deepEqual(list.tickets.map((t) => [t.key, t.comments]), [["RPE-1", 1], ["RPE-2", 0]]);

  const w1 = await post("/api/wiki/RPE/vision", { title: "Vision", body: "v1", base: null });
  assert.equal(w1.status, 200);
  const sha = (w1.body.page as W.Page).sha;
  assert.equal((await post("/api/wiki/RPE/vision", { title: "Vision", body: "v2", base: sha })).status, 200);
  const stale = await post("/api/wiki/RPE/vision", { title: "Vision", body: "v3", base: sha });
  assert.equal(stale.status, 409);
  assert.equal((stale.body.current as W.Page).body, "v2\n", "the page as it now is, for the editor to show");
  assert.notEqual((await post("/api/wiki/RPE/..%2F..%2Fx", { title: "x", body: "x", base: null })).status, 200, "no path outside the wiki");
  assert.equal((await post("/api/wiki/RPE/Bad Path", { title: "x", body: "x", base: null })).status, 400);
  const pg = (await get("/api/wiki/RPE/vision")).body as unknown as W.Page & { history: unknown[] };
  assert.equal(pg.history.length, 2);
  assert.equal(((await get("/api/wiki")).body as { pages: unknown[] }).pages.length, 1);
});
