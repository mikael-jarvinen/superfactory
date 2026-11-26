import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { attachmentsDir, inboxHeld, leaveNote, MAX_CHARS, pageText, postMessage } from "../src/board/inbox.js";
import { serve } from "../src/board/server.js";
import { transition } from "../src/state.js";
import { readTail } from "../src/messages.js";
import { pyDumps } from "../src/util.js";
import { openWorkspace } from "../src/workspace.js";
import { CLI, GROUPED, tempWorkspace } from "./helpers.js";

const noInboxLock = process.platform !== "darwin" && process.platform !== "linux" && "the inbox lock is built for macOS and Linux only";

// `board --inbox` in dir, with extra args, its stdout and stderr collected.
function inbox(dir: string, ...extra: string[]) {
  const mon = spawn(process.execPath, [CLI, "--workspace", dir, "board", "--inbox", ...extra], { env: { ...process.env, SF_NOTIFY: "0" } });
  const m = { mon, out: "", err: "" };
  mon.stdout.on("data", (b: Buffer) => (m.out += b));
  mon.stderr.on("data", (b: Buffer) => (m.err += b));
  after(() => mon.kill());
  return m;
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !ok();) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// One holder at a time: it has the inbox and prints the human's messages and the watchers' notes.
// Nothing else takes it, and a holder that ends hands on its cursors to the next.
test("the inbox: held detection, the holder, the watchers' notes, and the next holder", { skip: noInboxLock }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir);
  const arm = () => inbox(dir);

  postMessage(ws, "before any inbox");
  leaveNote(ws, "[round]\nleft before any monitor");
  assert.equal(inboxHeld(ws), false);
  const a = arm();
  await until("the monitor to hold the inbox", () => inboxHeld(ws));
  await until("the early note", () => a.out.includes("left before any monitor"));
  assert.match(a.out, /^\[m:[0-9a-f]{6}\] \[round\]\nleft before any monitor\n$/, "a note is news whenever it was left; page history is not");

  postMessage(ws, "hello");
  appendFileSync(ws.messages, pyDumps({ t: "x", text: "the lead's own", ticket: null, kind: "note", link: null }) + "\n");
  await until("the message on stdout", () => a.out.includes("hello"));
  assert.match(a.out, /\[from the message page\] \[m:[0-9a-f]{6}\] hello\n$/, "the lead's rows are not printed");

  // Unarmed, both wait; the next monitor prints each once, from where the last one stopped.
  a.mon.kill();
  await until("the lock to die with the monitor", () => !inboxHeld(ws));
  postMessage(ws, "while unarmed");
  leaveNote(ws, "[queue watcher]\nnoted while unarmed");
  // `say` rotates the message log to .1. The new file is found by its inode, not by being shorter.
  renameSync(ws.messages, ws.messages + ".1");
  writeFileSync(ws.messages, "x".repeat(4096) + "\n");
  postMessage(ws, "in the new log");
  const b = arm();
  await until("both waiting lines and the rotated one", () => b.out.includes("noted while unarmed") && b.out.includes("in the new log"));
  assert.ok(!b.out.includes("hello") && !b.out.includes("left before"), `nothing printed twice:\n${b.out}`);
  assert.equal(b.out.split("] while unarmed").length - 1, 1, "the rolled log is read to its end once");
  assert.equal(inboxHeld(ws), true);
  const c = arm();
  await until("the second monitor to stop", () => c.mon.exitCode !== null);
  assert.match(c.out, /already held by another `board --inbox`; this one stops/);
  assert.equal(c.mon.exitCode, 0, "without --once, a second holder stops quietly as before");
  // With --once it is an error, so the lead is not invited to run it again.
  const d = inbox(dir, "--once");
  await until("the --once that found it held to stop", () => d.mon.exitCode !== null);
  assert.equal(d.mon.exitCode, 3);
  assert.equal(d.out, "", "nothing on stdout that reads as a message");
  assert.match(d.err, /already held by another `board --inbox`; this one stops\. Do not start another/);
});

// --once, for a background command in the lead's session: it holds the inbox while it waits, exits
// with what came on the first pass that printed anything, and hands its cursor to the next.
test("the inbox --once: holds while waiting, exits on the first message, prints nothing twice", { skip: noInboxLock }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir);
  const once = () => inbox(dir, "--once");
  const a = once();
  await until("the wait to hold the inbox", () => inboxHeld(ws));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(a.mon.exitCode, null, "nothing came, so it still waits");
  postMessage(ws, "wake up");
  await until("the wait to exit", () => a.mon.exitCode !== null);
  assert.equal(a.mon.exitCode, 0);
  assert.match(a.out, /\[from the message page\] \[m:[0-9a-f]{6}\] wake up\n$/);
  await until("the lock to go with it", () => !inboxHeld(ws));
  leaveNote(ws, "[round]\nafter the first wait");
  const b = once();
  await until("the second wait to exit", () => b.mon.exitCode !== null);
  assert.ok(!b.out.includes("wake up"), `nothing printed twice:\n${b.out}`);
  assert.match(b.out, /after the first wait/);
  const u = spawn(process.execPath, [CLI, "--workspace", dir, "board", "--once"], { env: { ...process.env, SF_NOTIFY: "0" } });
  let uerr = "";
  u.stderr.on("data", (x: Buffer) => (uerr += x));
  await new Promise((r) => u.on("close", r));
  assert.notEqual(u.exitCode, 0);
  assert.match(uerr, /--once goes with --inbox/);
});

test("the server: pages, the snapshot, posting, and only the tail of the log", { skip: noInboxLock }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  const quiet = () => {};
  transition(ws, "WEB-1", "building", { agent: "bea", title: "Fix the redirect" }, quiet);
  transition(ws, "WEB-2", "building", {}, quiet);
  transition(ws, "WEB-2", "blocked", { note: "asked about the header row" }, quiet);
  // cal's only item is in review, which frees cal
  transition(ws, "API-1", "building", { agent: "cal" }, quiet);
  transition(ws, "API-1", "pr-open", { pr: "acme/api#3", head: "abc1234" }, quiet);
  for (const s of ["agent-review", "gate"]) transition(ws, "API-1", s, { evidence: "x" }, quiet);
  transition(ws, "API-1", "your-review", { reviewed: "abc1234" }, quiet);
  // A PR opened and its review not yet started: the state is pr-open, the board shows agent-review.
  transition(ws, "API-2", "building", {}, quiet);
  transition(ws, "API-2", "pr-open", { pr: "acme/api#4", head: "def5678" }, quiet);
  // A first row longer than the tail window: reading it would mean reading the file from the start.
  appendFileSync(ws.messages, pyDumps({ t: "x", text: "y".repeat(300 * 1024), kind: "note" }) + "\n");
  appendFileSync(ws.messages, pyDumps({ t: "x", id: "abc123", text: "from the old kind", kind: "alex" }) + "\n");

  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const get = async (p: string) => fetch(board.url + p);

  assert.match(await (await get("/")).text(), /<script src="\/static\/board.js">/);
  assert.equal((await get("/static/common.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await get("/static/..%2Fserver.js")).status, 404);

  const snap = await (await get("/api")).json();
  assert.deepEqual(snap.tickets.map((t: { ticket: string; state: string; column: string }) => `${t.ticket} ${t.state} ${t.column}`),
    ["WEB-1 building building", "API-2 pr-open agent-review", "API-1 your-review your-review", "WEB-2 blocked blocked"]);
  assert.deepEqual(snap.columns, ["designing", "design-review", "building", "agent-review", "fixing", "gate", "your-review", "colleague-review", "blocked"],
    "no pr-open column: a pr-open item shows in agent-review");
  assert.equal(snap.descriptions["pr-open"], undefined);
  assert.equal(snap.descriptions["queued"], undefined, "no queued column: waiting work lives in the backlog");
  for (const col of ["designing", "building"]) assert.match(snap.descriptions[col], /work nobody is doing yet waits in the backlog/, col);
  assert.equal(snap.tickets[3].question, "asked about the header row");
  type Member = { name: string; ticket: string | null; in_review: string[] };
  const member = (n: string) => snap.teams.flatMap((g: { members: Member[] }) => g.members).find((m: Member) => m.name === n) as Member;
  assert.deepEqual([member("cal").ticket, member("cal").in_review], [null, ["API-1"]], "a builder with only an item in review is free");
  assert.deepEqual([member("bea").ticket, member("bea").in_review], ["WEB-1", []]);
  assert.equal(snap.stacks.present, false, "no export from the stack engine, no stacks");
  assert.match(snap.descriptions["your-review"], /^Alex's\./);

  const page = { "Content-Type": "application/json", "Origin": board.url };
  const post = await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ text: "  typed on the page " }) });
  assert.deepEqual(await post.json(), { ok: true, error: null });
  const m = await (await get("/api/messages")).json();
  assert.equal(m.human, "Alex");
  assert.deepEqual(m.messages.map((r: { text: string; from: string; receipt: string }) => [r.text, r.from, r.receipt]),
    [["typed on the page", "human", "sent"], ["from the old kind", "human", "sent"]]);
  const full = await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ text: "x".repeat(MAX_CHARS) }) });
  assert.equal(full.status, 200);
  const bad = await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ text: "x".repeat(MAX_CHARS + 1) }) });
  assert.equal(bad.status, 400);

  // Several pasted screenshots in one message: each is stored, and the row and the inbox line name
  // every one in the order pasted. A page from before still posts a single `image`.
  const png = (s: string) => "data:image/png;base64," + Buffer.from(s).toString("base64");
  const three = await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ text: "look", images: ["one", "two", "three"].map(png) }) });
  assert.equal(three.status, 200);
  const one = await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ image: png("solo") }) });
  assert.equal(one.status, 200);
  const [look, solo] = readTail(ws.messages).slice(-2);
  assert.deepEqual(look?.images?.map((f) => readFileSync(join(attachmentsDir(ws), f), "utf8")), ["one", "two", "three"]);
  assert.deepEqual(pageText(ws, look!).split("\n").slice(1), look?.images?.map((f) => `[image saved at: ${join(attachmentsDir(ws), f)}]`));
  assert.equal(readFileSync(join(attachmentsDir(ws), solo!.images![0]!), "utf8"), "solo");
  const broken = await fetch(board.url + "/api/messages", { method: "POST", headers: page, body: JSON.stringify({ images: [png("ok"), "not an image"] }) });
  assert.equal(broken.status, 400);
  assert.equal(readdirSync(attachmentsDir(ws)).length, 4, "a message refused leaves none of its images behind");
});

// An agent with a file in portraits/avatars/ gets its URL on both pages; the route serves only a plain
// avatar file name from that directory, cached, since the board redraws every two seconds.
test("the server: agent avatars from the workspace", { skip: noInboxLock }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  mkdirSync(join(dir, "portraits", "avatars"), { recursive: true });
  writeFileSync(join(dir, "portraits", "avatars", "ada.webp"), "RIFF-ada");
  writeFileSync(join(dir, "portraits", "avatars", "bea.png"), "PNG-bea");
  writeFileSync(join(dir, "portraits", "avatars", "notes.txt"), "not an avatar");

  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const get = async (p: string) => fetch(board.url + p);

  assert.deepEqual((await (await get("/api")).json()).avatars, { ada: "/avatars/ada.webp", bea: "/avatars/bea.png" });
  assert.equal((await (await get("/api/messages")).json()).lead_avatar, "/avatars/ada.webp");
  const img = await get("/avatars/ada.webp");
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/webp");
  assert.equal(img.headers.get("cache-control"), "max-age=3600");
  assert.equal(await img.text(), "RIFF-ada");
  for (const p of ["/avatars/notes.txt", "/avatars/cal.webp", "/avatars/..%2Fportraits%2Favatars%2Fada.webp", "/avatars/Ada.webp"])
    assert.equal((await get(p)).status, 404, p);
});

// A message reaches the lead as the human's own instruction, so another site's page must not post one.
test("the message page refuses a cross-site post", { skip: noInboxLock }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const post = (headers: Record<string, string>) =>
    fetch(board.url + "/api/messages", { method: "POST", headers, body: JSON.stringify({ text: "do something" }) });
  // a simple request, no preflight: what fetch(..., {mode: 'no-cors'}) from another site sends
  assert.equal((await post({ "Content-Type": "text/plain;charset=UTF-8", "Origin": "https://elsewhere.example" })).status, 403);
  assert.equal((await post({ "Content-Type": "application/json", "Origin": "https://elsewhere.example" })).status, 403);
  assert.equal((await post({ "Content-Type": "application/json", "Origin": board.url })).status, 200);
  assert.deepEqual(readTail(ws.messages).map((r) => r.text), ["do something"]);
});

// A card carries the design's slides and canvas from design-review through the build.
test("the server: a card carries its design's slides and canvas once it has them", { skip: noInboxLock }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  const quiet = () => {};
  const slides = "https://claude.ai/artifact/slides1";
  const canvas = "https://claude.ai/artifact/canvas1";
  transition(ws, "WEB-5", "designing", { agent: "bea" }, quiet);
  transition(ws, "WEB-6", "designing", { agent: "bea" }, quiet);
  transition(ws, "WEB-6", "design-review", { canvas, slides }, quiet);
  transition(ws, "WEB-7", "designing", { agent: "bea" }, quiet);
  transition(ws, "WEB-7", "design-review", { canvas, slides }, quiet);
  transition(ws, "WEB-7", "off", { approved: "looks right" }, quiet);
  transition(ws, "WEB-7", "building", { agent: "cal" }, quiet);

  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  const snap = await (await fetch(board.url + "/api")).json();
  const design = (k: string) => snap.tickets.find((t: { ticket: string }) => t.ticket === k).design;
  assert.equal(design("WEB-5"), null, "still being drawn: nothing to link");
  assert.deepEqual(design("WEB-6"), { slides, canvas });
  assert.deepEqual(design("WEB-7"), { slides, canvas }, "kept while it is built");
  const js = await (await fetch(board.url + "/static/board.js")).text();
  assert.ok(js.includes('href="${esc(t.design.slides)}"') && js.includes('href="${esc(t.design.canvas)}"'), "the card links both");
  assert.ok(!js.includes("t.design.approved"), "no approved mark: on a card in the build it read as the PR's");
});

async function teamsOf(toml: string) {
  const dir = tempWorkspace(toml);
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const board = await serve(openWorkspace(dir), { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  return (await (await fetch(board.url + "/api")).json()).teams;
}

test("teams: a configured group titles its roster and keeps the role's place", { skip: noInboxLock }, async () => {
  const snap = { teams: await teamsOf(GROUPED) };
  // Within one place, rosters keep the order of their first member in the config. Only the ungrouped
  // assistants are staff, beside the lead; a group of assistants sits in the row with the builders.
  type Group = { key: string; title: string; scope: string; staff: boolean; members: { name: string }[] };
  assert.deepEqual(snap.teams.map((g: Group) => [g.key, g.title, g.staff, g.members.map((m) => m.name).join(" ")]), [
    ["lead", "Lead", false, "ada"],
    ["assistants", "Assistants", true, "nap"],
    ["group:Product", "Product", false, "bea cal"],
    ["group:Servers", "Servers", false, "otto"],
    ["reviewers", "Reviewers", false, "rae"],
  ]);
  assert.equal(snap.teams[2].scope, "web, api", "bea's stack, and cal's api already in it");

  // A member's repo that the first lacks is in the scope too, after the first's.
  const docs = GROUPED.replace("[stacks.app]", '[repos.docs]\nremote = "acme/docs"\n\n[stacks.app]')
    .replace('repos = ["api"]', 'repos = ["api", "docs"]');
  const product = (await teamsOf(docs)).find((g: { key: string }) => g.key === "group:Product");
  assert.equal(product.scope, "web, api, docs");

  // An entry is kept whole: "a, b" and "b" are two repos, and neither swallows the other.
  const odd = GROUPED.replace("[stacks.app]", '[repos."a, b"]\nremote = "acme/ab"\n\n[repos.b]\nremote = "acme/b"\n\n[stacks.app]')
    .replace('repos = ["api"]', 'repos = ["a, b", "b"]');
  const oddProduct = (await teamsOf(odd)).find((g: { key: string }) => g.key === "group:Product");
  assert.equal(oddProduct.scope, "web, api, a, b, b");
});
