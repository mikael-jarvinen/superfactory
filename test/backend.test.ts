import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { claudeBackend } from "../src/backends/claude.js";
import { backend, backendFor } from "../src/backends/index.js";
import { BACKENDS, ConfigError, loadConfig } from "../src/config.js";
import { agentOrDie } from "../src/fleet.js";
import { launchArgs, launchSpec } from "../src/launch.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace } from "./helpers.js";

const load = (toml: string) => {
  const ws = tempWorkspace(toml);
  after(() => rmSync(ws, { recursive: true, force: true }));
  return loadConfig(join(ws, "factory.toml"), {});
};

test("an agent with no backend field runs under ClaudeBackend", () => {
  assert.doesNotMatch(TOML, /^backend\s*=/m, "the test config names no backend");
  const c = load(TOML);
  assert.ok(c.agents.length > 1);
  for (const a of c.agents) {
    assert.equal(a.backend, "claude", a.name);
    assert.equal(backendFor(a), claudeBackend, a.name);
  }
});

test("backend = \"claude\" is the same as no backend field", () => {
  const c = load(TOML.replace('name = "ada"\nrole = "lead"\n', 'name = "ada"\nrole = "lead"\nbackend = "claude"\n'));
  assert.equal(c.agents.find((a) => a.name === "ada")?.backend, "claude");
});

test("an unknown backend fails at config load, naming the agent's field and the known backends", () => {
  const ws = tempWorkspace(TOML.replace('name = "ada"\nrole = "lead"\n', 'name = "ada"\nrole = "lead"\nbackend = "gemini"\n'));
  after(() => rmSync(ws, { recursive: true, force: true }));
  assert.throws(
    () => loadConfig(join(ws, "factory.toml"), {}),
    (e: unknown) => e instanceof ConfigError && e.problems.some((p) => /^agents\[0\]\.backend: must be one of claude, got "gemini"/.test(p)),
  );
  const ws2 = tempWorkspace(TOML.replace('name = "ada"\nrole = "lead"\n', 'name = "ada"\nrole = "lead"\nbackend = 3\n'));
  after(() => rmSync(ws2, { recursive: true, force: true }));
  assert.throws(() => loadConfig(join(ws2, "factory.toml"), {}), (e: unknown) => e instanceof ConfigError && e.problems.some((p) => /^agents\[0\]\.backend: /.test(p)));
});

test("every backend name has a backend, and each backend carries its own name", () => {
  for (const n of BACKENDS) assert.equal(backend(n).name, n);
});

test("a launch's arguments are the backend's rendering of its spec, remote control included", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  const ada = agentOrDie(ws, "ada");
  const spec = launchSpec(ws, ada, "P", "/tmp/a.md", undefined);
  assert.equal(spec.remoteControl, "ada", "remote_control = true names the session after the agent");
  assert.deepEqual(launchArgs(ws, ada, "P", "/tmp/a.md", undefined), claudeBackend.launchArgs(spec));
  const tail = claudeBackend.launchArgs({ ...spec, remoteControl: undefined });
  assert.ok(!tail.includes("--remote-control"));
});

test("ClaudeBackend: busy is a turn in progress, messages go by SendMessage, transcripts by cwd", () => {
  assert.equal(claudeBackend.messageTool, "SendMessage");
  assert.equal(claudeBackend.midTurn({ kind: "background", state: "working" } as never), true);
  assert.equal(claudeBackend.midTurn({ kind: "background", state: "done" } as never), false);
  assert.equal(claudeBackend.projectDir("/a/b.c"), join(claudeBackend.transcriptsDir(), "-a-b-c"));
});
