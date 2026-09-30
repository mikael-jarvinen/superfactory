import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../src/config.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

const problems = (toml: string): string[] => {
  const ws = tempWorkspace(toml);
  try {
    loadConfig(join(ws, "factory.toml"), {});
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
};

test("the example config and the test config are valid", () => {
  const example = fileURLToPath(new URL("../../examples/factory.toml", import.meta.url));
  const c = loadConfig(example, {});
  assert.equal(c.agents.find((a) => a.role === "lead")?.name, "lee");
  assert.deepEqual(problems(TOML), []);
});

test("one message per bad key, naming the key", () => {
  assert.deepEqual(problems(`
[human]
nmae = "Alex"

[paths]
repos = "$NOT_SET/src"

[repos.web]
remote = "not a slug"
gate_checks = "test"

[stacks.app]
repos = ["web", "nope"]
slots = 0
pin = { zed = 1 }

[roles.lead]
settings = "lead"

[roles.builder]
cwd = "somewhere"
settings = "builder"

[roles.boss]

[[agents]]
name = "Ada"
role = "lead"

[[agents]]
name = "bea"
role = "builder"
stack = "ap"

[[agents]]
name = "bea"
role = "reviewer"
remote_control = "yes"

[tracker]
kind = "jira"
key_pattern = "(["

[tracker.status]
building = "In Progress"
shipping = "Out"

[board]
port = 99999

[colours]
`), [
    "human.name: missing",
    "human.nmae: unknown key",
    "paths.repos: $NOT_SET is not set",
    "repos.web.remote: must look like owner/repo, got \"not a slug\"",
    "repos.web.gate_checks: must be an array of non-empty strings, got \"test\"",
    "stacks.app.repos: no repo \"nope\"; repos: web",
    "stacks.app.slots: must be a whole number from 1 up, got 0",
    "roles.lead.cwd: missing",
    "roles.builder.cwd: a builder starts in its worktree, so it takes no cwd",
    "roles.boss: unknown role; roles are lead, builder, reviewer",
    "agents[0].name: must be lower case letters, digits and dashes, got \"Ada\"",
    "agents[1].stack: no stack \"ap\"; stacks: app",
    "agents[2].name: \"bea\" is used by another agent",
    "agents[2].remote_control: must be true or false, got \"yes\"",
    "roles.reviewer: missing, and agent \"bea\" has that role",
    "stacks.app.pin.zed: no builder \"zed\" on stack \"app\"",
    "tracker.key_pattern: not a valid regular expression: Invalid regular expression: /([/: Unterminated character class",
    "tracker.status.shipping: unknown state; states: queued, building, pr-open, agent-review, fixing, gate, your-review, colleague-review, done, blocked",
    "tracker.status.queued: missing; the tracker needs a status for it",
    "tracker.status.colleague-review: missing; the tracker needs a status for it",
    "tracker.status.done: missing; the tracker needs a status for it",
    "board.port: must be a whole number from 1 to 65535, got 99999",
    "colours: unknown key",
  ]);
});

test("the CLI prints every problem at once and exits 1", () => {
  const ws = tempWorkspace(TOML.replace('role = "lead"', 'role = "boss"'));
  after(() => rmSync(ws, { recursive: true, force: true }));
  const r = factory(ws, ["state", "--list"]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `factory: ${join(ws, "factory.toml")} has 2 problems:\n` +
    `  agents[0].role: must be one of lead, builder, reviewer, got "boss"\n` +
    `  agents: exactly one agent needs role = "lead", found 0\n`);
  writeFileSync(join(ws, "factory.toml"), "[human\n");
  assert.match(factory(ws, ["status"]).stderr, /has 1 problem:\n {2}not valid TOML: /);
});
