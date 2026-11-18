// Niilo, 2026-11-18: Travis's `factory stop` then `factory wake` respawned 91c86061, his two-day-old
// thread, and the respawned session had no --append-system-prompt-file. Stop removed the row it had
// just stopped, so wake respawned the newest row left: an older conversation, on its older command
// line. A stop now keeps the row and records its id, and wake resumes that one or none.
import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
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
  return { ws, run, calls, rows };
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
  const { ws, run, calls } = fleet();
  assert.equal(run("stop", "rae").status, 0);
  // the row goes some other way: a hand-run `claude rm`, say
  const db = join(ws, "db.json");
  writeFileSync(db, JSON.stringify((JSON.parse(readFileSync(db, "utf8")) as { id: string }[]).filter((x) => x.id !== "5e7a0b12")));
  const r = run("wake", "rae");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rae did not wake: 5e7a0b12, the session stopped last, is no longer listed, and an older one is another conversation/);
  assert.deepEqual(calls().filter((c) => c.startsWith("respawn") || c.startsWith("--bg")), [], "neither 91c86061 nor a fresh one");
});
