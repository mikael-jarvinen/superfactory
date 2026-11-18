import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, ROLES, roster } from "../src/config.js";
import { factory, GROUPED, TOML, tempWorkspace } from "./helpers.js";

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

test("a stack's label is its capitalised key unless it names one", () => {
  const label = (toml: string) => {
    const ws = tempWorkspace(toml);
    try {
      return loadConfig(join(ws, "factory.toml"), {}).stacks.app?.label;
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  };
  assert.equal(label(TOML), "App");
  assert.equal(label(TOML.replace("[stacks.app]\n", "[stacks.app]\nlabel = \"Lyyti Event\"\n")), "Lyyti Event");
});

test("one message per bad key, naming the key", () => {
  assert.deepEqual(problems(`
[human]
nmae = "Alex"

[github]
own_repos = ["alex/factory", "factory"]

[paths]
repos = "$NOT_SET/src"

[repos.web]
remote = "not a slug"
gate_checks = "test"

[stacks.app]
repos = ["web", "nope"]
slots = 0
pin = { zed = 1 }
env = { PATH = "/opt/java/bin", JAVA_HOME = 21 }

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
    "github.own_repos: must name repos as owner/repo, got \"factory\"",
    "paths.repos: $NOT_SET is not set",
    "repos.web.remote: must look like owner/repo, got \"not a slug\"",
    "repos.web.gate_checks: must be an array of non-empty strings, got \"test\"",
    "stacks.app.repos: no repo \"nope\"; repos: web",
    "stacks.app.slots: must be a whole number from 1 up, got 0",
    "stacks.app.env.PATH: give path_prepend instead; a session's PATH is built from it",
    "stacks.app.env.JAVA_HOME: must be a string, got 21",
    "roles.lead.cwd: missing",
    "roles.builder.cwd: a builder starts in its worktree, so it takes no cwd",
    "roles.boss: unknown role; roles are lead, builder, reviewer, assistant, designer",
    "agents[0].name: must be lower case letters, digits and dashes, got \"Ada\"",
    "agents[1].stack: no stack \"ap\"; stacks: app",
    "agents[2].name: \"bea\" is used by another agent",
    "agents[2].remote_control: must be true or false, got \"yes\"",
    "roles.reviewer: missing, and agent \"bea\" has that role",
    "stacks.app.pin.zed: no builder \"zed\" on stack \"app\"",
    "tracker.key_pattern: not a valid regular expression: Invalid regular expression: /([/: Unterminated character class",
    "tracker.status.shipping: unknown state; states: queued, designing, design-review, building, pr-open, agent-review, fixing, gate, your-review, colleague-review, done, blocked",
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
    `  agents[0].role: must be one of lead, builder, reviewer, assistant, designer, got "boss"\n` +
    `  agents: exactly one agent needs role = "lead", found 0\n`);
  writeFileSync(join(ws, "factory.toml"), "[human\n");
  assert.match(factory(ws, ["status"]).stderr, /has 1 problem:\n {2}not valid TOML: /);
});

test("an agent's own cwd, model, effort, permission_mode and autocompact; a builder's cwd is refused", () => {
  const ws = tempWorkspace(TOML.replace(`name = "rae"
role = "reviewer"`, `name = "rae"
role = "reviewer"
cwd = "rae"
model = "sonnet"
effort = "low"
permission_mode = "default"
autocompact = "400k"`));
  after(() => rmSync(ws, { recursive: true, force: true }));
  const c = loadConfig(join(ws, "factory.toml"), {});
  const rae = c.agents.find((a) => a.name === "rae");
  assert.deepEqual([rae?.cwd, rae?.model, rae?.effort, rae?.permissionMode, rae?.autocompact], [join(ws, "rae"), "sonnet", "low", "default", "400k"]);
  const ada = c.agents.find((a) => a.name === "ada");
  assert.deepEqual([ada?.cwd, ada?.model, ada?.effort, ada?.permissionMode, ada?.autocompact], [undefined, undefined, undefined, undefined, undefined]);

  assert.deepEqual(problems(TOML.replace(`name = "cal"
role = "builder"`, `name = "cal"
role = "builder"
cwd = "cal"`)), ["agents[2].cwd: a builder starts in its worktree, so it takes no cwd"]);
});

test("an agent's group: trimmed, optional, never the lead's, one role to a group", () => {
  const ws = tempWorkspace(GROUPED);
  after(() => rmSync(ws, { recursive: true, force: true }));
  const c = loadConfig(join(ws, "factory.toml"), {});
  assert.deepEqual(Object.fromEntries(c.agents.map((a) => [a.name, a.group])),
    { ada: undefined, bea: "Product", cal: "Product", rae: undefined, otto: "Servers", nap: undefined });

  assert.deepEqual(problems(GROUPED.replace('group = " Servers "', 'group = "  "')), ["agents[4].group: must not be empty"]);
  assert.deepEqual(problems(GROUPED.replace(`name = "ada"
role = "lead"`, `name = "ada"
role = "lead"
group = "Top"`)), ["agents[0].group: the lead has its own place on the board"]);
  assert.deepEqual(problems(GROUPED.replace('group = " Servers "', 'group = "Product"')),
    ['agents: group "Product" has "bea" (builder) and "otto" (assistant); a group holds one role']);
  // A group may not take the title of a roster the board draws for agents without one.
  for (const [g, who] of [[" Reviewers ", "rae"], ["assistants", "nap"]] as const)
    assert.deepEqual(problems(GROUPED.replace('group = " Servers "', `group = "${g}"`)),
      [`agents: group "${g.trim()}" has the title of "${who}"'s roster on the board; pick another`]);
  const ungroup = (name: string) => GROUPED.replace(`name = "${name}"\nrole = "builder"\ngroup = "Product"`, `name = "${name}"\nrole = "builder"`);
  assert.deepEqual(problems(ungroup("cal").replace('group = " Servers "', 'group = "API"')),
    ['agents: group "API" has the title of "cal"\'s roster on the board; pick another']);
  assert.deepEqual(problems(ungroup("bea").replace('group = " Servers "', 'group = "app"')),
    ['agents: group "app" has the title of "bea"\'s roster on the board; pick another']);
  // Only what the board draws: a relabelled stack frees its key, and a repo no ungrouped builder
  // lists alone is free.
  const shop = ungroup("bea").replace("[stacks.app]", '[stacks.app]\nlabel = "Shop"');
  assert.deepEqual(problems(shop.replace('group = " Servers "', 'group = "App"')), []);
  assert.deepEqual(problems(shop.replace('group = " Servers "', 'group = "shop"')),
    ['agents: group "shop" has the title of "bea"\'s roster on the board; pick another']);
  assert.deepEqual(problems(GROUPED.replace('group = " Servers "', 'group = "API"')), []);
  assert.deepEqual(problems(GROUPED.replace(`name = "cal"
role = "builder"
group = "Product"`, `name = "cal"
role = "builder"
group = "product"`)), ['agents: group "Product" is also spelled "product"; spell it one way']);
  assert.deepEqual(problems(GROUPED.replace(/group = "Product"/g, 'group = "Product Team"').replace(`name = "cal"
role = "builder"
group = "Product Team"`, `name = "cal"
role = "builder"
group = "Product  Team"`)), ['agents: group "Product Team" is also spelled "Product  Team"; spell it one way']);
});

test("roster: every role but the builder has a roster of its own, and builders split by stack and repos", () => {
  const of = (role: (typeof ROLES)[number], stack?: string, repos: string[] = []) => roster({ role, stack, repos }, {});
  assert.deepEqual(ROLES.filter((r) => r !== "builder").map((r) => of(r)),
    [{ key: "lead", title: "Lead" }, { key: "reviewers", title: "Reviewers" }, { key: "assistants", title: "Assistants" },
     { key: "designers", title: "Designers" }]);
  assert.deepEqual(of("builder", "app", ["web"]), { key: "stack:app", title: "App" });
  assert.deepEqual(of("builder", undefined, ["api"]), { key: "repos:api", title: "Api" });
  assert.deepEqual(of("builder", undefined, ["api", "web"]), { key: "repos:api,web", title: "Builders" });
});

test("a repo: appendix item is a builder's only: no other role has a checkout to read it from", () => {
  assert.deepEqual(problems(TOML.replace('name = "rae"\nrole = "reviewer"', 'name = "rae"\nrole = "reviewer"\nappendix = ["repo:AGENTS.md"]')),
    ["agents[3].appendix: repo:AGENTS.md is read from the agent's checkout, and only a builder has one"]);
});

test("an unknown role with a repo: appendix item gets only the role's problem", () => {
  const got = problems(TOML.replace('name = "rae"\nrole = "reviewer"', 'name = "rae"\nrole = "reviwer"\nappendix = ["repo:AGENTS.md"]'));
  assert.deepEqual(got.filter((p) => p.startsWith("agents[3]")).map((p) => p.split(":")[0]), ["agents[3].role"]);
});
