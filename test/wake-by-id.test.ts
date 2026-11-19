// Niilo, 2026-11-18: Travis's `factory stop` then `factory wake` respawned 91c86061, his two-day-old
// thread, and the respawned session had no --append-system-prompt-file. Stop removed the row it had
// just stopped, so wake respawned the newest row left: an older conversation, on its older command
// line. A stop now keeps the row and records its id, and wake resumes that one or none.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { freshCommand, lastStopped, noteStopped, replaceStopped, resumable } from "../src/stopped.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, fakeDaemon, TOML, tempWorkspace } from "./helpers.js";

// A claude whose sessions live in db.json and keep the command line they were launched with: a
// respawn reruns that line, as the real one does, and the calls log says which line it reran.
const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const D = path.dirname(path.dirname(process.argv[1]));
const db = path.join(D, "db.json"), log = path.join(D, "calls");
const rows = JSON.parse(fs.readFileSync(db, "utf8"));
const save = () => fs.writeFileSync(db, JSON.stringify(rows));
const [cmd, id] = process.argv.slice(2);
const row = rows.find((r) => r.id === id);
const shown = (r) => { const { args, ...rest } = r; return rest; };
fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
if (cmd === "agents") {
  const all = process.argv.includes("--all");
  console.log(JSON.stringify(rows.filter((r) => all || r.state !== "stopped").map(shown)));
} else if (cmd === "stop" && row) { row.state = "stopped"; row.pid = null; save(); }
else if (cmd === "rm" && row) { rows.splice(rows.indexOf(row), 1); save(); }
else if (cmd === "respawn") {
  if (!row) { console.error("no session " + id); process.exit(1); }
  row.state = "idle"; row.status = "idle"; row.pid = ${process.pid}; save();
  fs.appendFileSync(log, "reran " + id + ": " + row.args.join(" ") + "\\n");
  console.log("respawned " + id);
} else process.exit(1);
`;

function fleet() {
  const ws = tempWorkspace(TOML);
  after(() => rmSync(ws, { recursive: true, force: true }));
  const claude = join(ws, "bin", "claude");
  writeFileSync(claude, FAKE);
  chmodSync(claude, 0o755);
  const cfg = join(ws, "claude-config");
  fakeDaemon(cfg);
  const row = (id: string, startedAt: number, live: boolean, args: string[]) => ({
    id, name: "rae", kind: "background", state: live ? "idle" : "stopped", status: "idle", pid: live ? process.pid : null,
    startedAt, cwd: "/w/rae", sessionId: `${id}-uuid`, args,
  });
  // 91c86061 is the thread from two days ago, on the command line of its day; 5e7a0b12 is today's, live.
  writeFileSync(join(ws, "db.json"), JSON.stringify([
    row("91c86061", Date.now() - 2 * 86_400_000, false, ["--bg", "--name", "rae", "old prompt"]),
    row("5e7a0b12", Date.now() - 3_600_000, true, ["--bg", "--name", "rae", "--append-system-prompt-file", "/w/logs/run/appendix-rae-1.md", "prompt"]),
  ]));
  const env = { CLAUDE_CONFIG_DIR: cfg };
  const run = (...a: string[]) => factory(ws, a, { env });
  const calls = () => readFileSync(join(ws, "calls"), "utf8").trim().split("\n");
  const rows = () => JSON.parse(readFileSync(join(ws, "db.json"), "utf8")) as { id: string; state: string }[];
  const hook = (to: string) => factory(undefined, ["--workspace", ws, "hook", "wake"],
    { env: { ...env, CLAUDE_BIN: claude }, input: JSON.stringify({ tool_name: "SendMessage", tool_input: { to, message: "hi" } }) });
  return { ws, run, calls, rows, hook };
}

test("stop then wake resumes the session just stopped, by id, on its own command line", () => {
  const { run, calls, rows } = fleet();
  let r = run("stop", "rae");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopped rae \(5e7a0b12\)/);
  assert.ok(rows().some((x) => x.id === "5e7a0b12"), "the stopped row stays listed, so its conversation can come back");
  assert.ok(!calls().some((c) => c.startsWith("rm ")), "stop removes nothing");

  r = run("wake", "rae");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rae woke: 5e7a0b12 respawned/);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn 5e7a0b12"], "not 91c86061, the older thread");
  const reran = calls().find((c) => c.startsWith("reran ")) ?? "";
  assert.match(reran, /^reran 5e7a0b12: .*--append-system-prompt-file \/w\/logs\/run\/appendix-rae-1\.md/, "the brief comes back with it");
});

test("a wake whose stopped session is gone says so, and respawns no older one", () => {
  const { ws, run, calls, hook } = fleet();
  assert.equal(run("stop", "rae").status, 0);
  // the row goes some other way: a hand-run `claude rm`, say
  const db = join(ws, "db.json");
  writeFileSync(db, JSON.stringify((JSON.parse(readFileSync(db, "utf8")) as { id: string }[]).filter((x) => x.id !== "5e7a0b12")));
  const r = run("wake", "rae");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rae did not wake: 5e7a0b12, the session stopped last, is no longer listed, and an older one is another conversation/);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn") || c.startsWith("--bg")), [], "neither 91c86061 nor a fresh one");
  // the way out is named, and the hook does not send people back to the wake that failed (Marie on #130)
  assert.match(r.stderr, /`factory review --name rae --force` starts it fresh/);
  const h = hook("rae");
  assert.equal(h.status, 2);
  assert.match(h.stderr, /rae is off and cannot wake: .*Tell the lead, who starts it fresh with `factory review --name rae --force`/);
  assert.doesNotMatch(h.stderr, /Try `factory wake/);
});

test("each role's way to start fresh is the command that starts it", () => {
  const cmd = (name: string, role: string) => freshCommand({ name, role } as Parameters<typeof freshCommand>[0]);
  assert.equal(cmd("ada", "lead"), "factory up --fresh");
  assert.equal(cmd("rae", "reviewer"), "factory review --name rae --force");
  assert.equal(cmd("winston", "assistant"), "factory assistant winston --force");
  assert.equal(cmd("bea", "builder"), "factory dispatch bea <KEY> --force");
  assert.equal(cmd("dora", "designer"), "factory dispatch dora <KEY> --force");
});

test("a stopped row with no name records nothing", () => {
  const { ws } = fleet();
  const w = openWorkspace(ws, {});
  noteStopped(w, "", { id: "x1", name: undefined });
  assert.ok(!existsSync(join(w.runDir, "stopped-.json")), "down wrote stopped-.json for a nameless row (Marie on #130)");
});

test("a fresh launch removes the stopped row it replaces, and a record older than a launch elsewhere is not resumed", () => {
  const { ws, run, rows } = fleet();
  assert.equal(run("stop", "rae").status, 0);
  const w = openWorkspace(ws, {});
  // another box launched rae since: a newer row that this box's record knows nothing of
  const db = join(ws, "db.json");
  const all = JSON.parse(readFileSync(db, "utf8")) as Record<string, unknown>[];
  all.push({ id: "c0ffee00", name: "rae", kind: "background", state: "stopped", status: "idle", pid: null,
    startedAt: Date.now() + 60_000, cwd: "/w/rae", sessionId: "c0ffee00-uuid", args: ["--bg", "--name", "rae", "launched elsewhere"] });
  writeFileSync(db, JSON.stringify(all));
  const which = resumable(w, "rae", rows() as never, (r) => r.reduce((a, b) => ((b.startedAt as number) > (a.startedAt as number) ? b : a)));
  assert.ok("s" in which && which.s?.id === "c0ffee00", JSON.stringify(which));

  // a fresh launch here: the stopped row it replaces goes, and the record with it
  const t = { sessions: () => rows() as never, alive: (s: unknown): s is never => (s as { state?: string } | null)?.state !== "stopped" && !!s, stop: (_n: string, id: string, remove: boolean) => { if (remove) writeFileSync(db, JSON.stringify((JSON.parse(readFileSync(db, "utf8")) as { id: string }[]).filter((x) => x.id !== id))); } };
  replaceStopped(w, "rae", t as never, "new1");
  assert.ok(!rows().some((x) => x.id === "5e7a0b12"), "the stopped row is removed");
  assert.equal(lastStopped(w, "rae"), null);
});

test("down records the row that was live, not a dead duplicate listed after it (CodeRabbit on #130)", () => {
  const { ws, run } = fleet();
  // a row the listing still shows but whose pid is gone: listed by default, not alive, and last
  const db = join(ws, "db.json");
  const all = JSON.parse(readFileSync(db, "utf8")) as Record<string, unknown>[];
  all.push({ id: "deadbeef", name: "rae", kind: "background", state: "idle", status: "idle", pid: 2 ** 22 + 7,
    startedAt: Date.now() - 86_400_000, cwd: "/w/rae", sessionId: "deadbeef-uuid", args: ["--bg", "--name", "rae", "yesterday"] });
  writeFileSync(db, JSON.stringify(all));
  const r = run("down");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastStopped(openWorkspace(ws, {}), "rae")?.id, "5e7a0b12", "the live one, which wake should bring back");
});

// CodeRabbit on #130 at 2e89a7a4: a stop wrote its record without the marks of launches that never
// came up, so a dead launch whose host clock is ahead passed for newer than the stop.
for (const how of ["stop", "down"] as const)
  test(`a ${how} keeps the mark of a launch that never came up`, () => {
    const { ws, run, calls } = fleet();
    const w = openWorkspace(ws, {});
    mkdirSync(w.runDir, { recursive: true });
    writeFileSync(join(w.runDir, "stopped-rae.json"), JSON.stringify({ id: "91c86061", at: new Date(Date.now() - 7_200_000).toISOString(), failed: ["dead2"] }));
    const db = join(ws, "db.json");
    const all = JSON.parse(readFileSync(db, "utf8")) as Record<string, unknown>[];
    all.push({ id: "dead2", name: "rae", kind: "background", state: "failed", status: "idle", pid: null,
      startedAt: Date.now() + 7_200_000, cwd: "/w/rae", sessionId: "dead2-uuid", args: ["--bg", "--name", "rae", "never came up"] });
    writeFileSync(db, JSON.stringify(all));
    const r = how === "stop" ? run("stop", "rae") : run("down");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lastStopped(w, "rae")?.failed, ["dead2"]);
    assert.deepEqual(lastStopped(w, "rae")?.unrun, how === "down" ? ["dead2"] : undefined);
    assert.equal(run("wake", "rae").status, 0);
    assert.deepEqual(calls().filter((c) => c.startsWith("respawn")), ["respawn 5e7a0b12"], "not dead2, the launch that never came up");
    if (how === "stop") assert.ok(!calls().includes("stop dead2"), "a stop of rae is no stop of the launch that never came up");
    // down stops it too, so one up late does not outlive the down; it stays marked, and its
    // "stopped" is not read as having run (Marie on #130 at f62a6b10)
    else assert.ok(calls().includes("stop dead2"), calls().join("\n"));
  });

// CodeRabbit on #130 at f62a6b10: a listing that failed at the stop, or when a new conversation took
// the record, showed no rows, and every mark went with it.
for (const how of ["a stop", "a launch that came up"] as const)
  test(`${how} keeps every mark when the listing fails`, () => {
    const ws = tempWorkspace(TOML);
    after(() => rmSync(ws, { recursive: true, force: true }));
    const w = openWorkspace(ws, {});
    mkdirSync(w.runDir, { recursive: true });
    writeFileSync(join(w.runDir, "stopped-rae.json"), JSON.stringify({ id: "old1", at: new Date(Date.now() - 7_200_000).toISOString(), failed: ["dead2"] }));
    const failing = { sessions: () => { throw new Error("listing timed out"); }, alive: () => false, stop: () => assert.fail("nothing is removed without a listing") };
    if (how === "a stop") noteStopped(w, "rae", { id: "cur1", name: "rae" }, undefined);
    else replaceStopped(w, "rae", failing as never, "cur1");
    assert.deepEqual(lastStopped(w, "rae")?.failed, ["dead2"]);
    // the next wake: dead2, whose host clock is 2 h ahead, never came up; cur1 is the one to resume
    const rows = [
      { id: "cur1", name: "rae", kind: "background", state: "stopped", startedAt: Date.now() - 600_000 },
      { id: "dead2", name: "rae", kind: "background", state: "failed", startedAt: Date.now() + 7_200_000 },
    ];
    const which = resumable(w, "rae", rows as never, (r) => r.reduce((a, b) => ((b.startedAt as number) > (a.startedAt as number) ? b : a)));
    assert.equal("s" in which ? which.s?.id : "gone", "cur1");
  });
