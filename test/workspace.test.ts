import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { openWorkspace, resolveWorkspace } from "../src/workspace.js";
import { CLI, factory, tempDir, tempWorkspace } from "./helpers.js";

test("resolution order: --workspace, then FACTORY_WORKSPACE, then the nearest factory.toml", () => {
  const a = tempWorkspace();
  const b = tempWorkspace();
  after(() => [a, b].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const deep = join(a, "lead", "x", "y");
  mkdirSync(deep, { recursive: true });
  assert.equal(resolveWorkspace({ flag: b, env: { FACTORY_WORKSPACE: a }, cwd: deep }), b);
  assert.equal(resolveWorkspace({ env: { FACTORY_WORKSPACE: b }, cwd: deep }), b);
  assert.equal(resolveWorkspace({ env: {}, cwd: deep }), a);
  assert.equal(resolveWorkspace({ flag: "..", env: {}, cwd: join(b, "bin") }), b);
});

test("a symlink resolves to the real workspace", () => {
  const ws = tempWorkspace();
  const elsewhere = tempDir();
  after(() => [ws, elsewhere].forEach((d) => rmSync(d, { recursive: true, force: true })));
  mkdirSync(join(ws, "lead"));
  symlinkSync(ws, join(elsewhere, "ws"));
  symlinkSync(join(ws, "lead"), join(elsewhere, "lead"));
  assert.equal(resolveWorkspace({ flag: join(elsewhere, "ws"), env: {} }), ws);
  assert.equal(resolveWorkspace({ env: {}, cwd: join(elsewhere, "lead") }), ws);
});

test("no workspace, or a directory without factory.toml, is refused with the ways to name one", () => {
  const empty = tempDir();
  after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => resolveWorkspace({ env: {}, cwd: empty }), /no workspace: pass --workspace <dir>, set FACTORY_WORKSPACE/);
  assert.throws(() => resolveWorkspace({ flag: empty, env: {} }), /--workspace .*: no factory.toml in/);
  assert.throws(() => resolveWorkspace({ env: { FACTORY_WORKSPACE: join(empty, "missing") } }), /FACTORY_WORKSPACE .*: no such directory/);
});

test("state and logs default into the workspace, and [paths] moves them", () => {
  const ws = tempWorkspace();
  after(() => rmSync(ws, { recursive: true, force: true }));
  let w = openWorkspace(ws);
  assert.equal(w.stateDir, join(ws, "state"));
  assert.equal(w.logsDir, join(ws, "logs"));
  assert.equal(w.runDir, join(ws, "logs", "run"));
  writeFileSync(join(ws, "factory.toml"), `[human]\nname = "Alex"\n[paths]\nstate = "$SF_TEST_STORE/s"\nlogs = "~/l"\n[[agents]]\nname = "ada"\nrole = "lead"\n[roles.lead]\ncwd = "."\nsettings = "s.json"\n`);
  w = openWorkspace(ws, { SF_TEST_STORE: "/store" });
  assert.equal(w.stateDir, "/store/s");
  assert.equal(w.events, "/store/s/events.jsonl");
  assert.equal(w.logsDir, join(process.env.HOME as string, "l"));
});

test("the CLI finds its workspace when run through a symlinked bin, from a nested cwd", () => {
  const ws = tempWorkspace();
  const bin = tempDir();
  after(() => [ws, bin].forEach((d) => rmSync(d, { recursive: true, force: true })));
  symlinkSync(CLI, join(bin, "factory"));
  const nested = join(ws, "lead", "deep");
  mkdirSync(nested, { recursive: true });
  factory(ws, ["state", "LOCAL-found-it", "queued"]);
  const r = factory(undefined, ["state", "--list"], { cli: join(bin, "factory"), cwd: nested, env: { CLAUDE_BIN: join(ws, "bin", "claude") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LOCAL-found-it/);
  const viaEnv = factory(undefined, ["state", "--list"], { env: { FACTORY_WORKSPACE: ws } });
  assert.match(viaEnv.stdout, /LOCAL-found-it/);
});
