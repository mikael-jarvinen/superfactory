import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { agyHook, agyHookMissing, agyHooksFile, check, claudeCall, ensureAgyHook, loadRules, PROJECT_ENV, ruling, RULES_ENV } from "../src/backends/agy-guard.js";
import { launchSpec } from "../src/launch.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace } from "./helpers.js";

// The rendered settings of an antigravity agent of the given role, and its workspace.
function rendered(who: string, role: string) {
  const ws = tempWorkspace(TOML.replace(`name = "${who}"\nrole = "${role}"\n`, `name = "${who}"\nrole = "${role}"\nbackend = "antigravity"\n`));
  after(() => rmSync(ws, { recursive: true, force: true }));
  const w = openWorkspace(ws, {});
  const spec = launchSpec(w, w.config.agents.find((a) => a.name === who)!, "hi", null, undefined);
  return { ws, rules: loadRules(spec.settings!) };
}
const run = (CommandLine: string) => ({ name: "run_command", args: { CommandLine, WaitMsBeforeAsync: 0 } });

test("agy's calls take the shape of the Claude tool that does the same", () => {
  assert.deepEqual(claudeCall("run_command", { CommandLine: "ls" }), { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(claudeCall("write_file", { Path: "a", Content: "x" }), { tool_name: "Write", tool_input: { file_path: "a", content: "x" } });
  assert.deepEqual(claudeCall("edit_file", { Path: "a", Target: "x", Replacement: "y" }), { tool_name: "Edit", tool_input: { file_path: "a" } });
  assert.deepEqual(claudeCall("read_file", { Path: "a" }), { tool_name: "Read", tool_input: { file_path: "a" } });
  assert.equal(claudeCall("grep_search", { SearchPath: "src", Includes: "*.ts" })!.tool_name, "Grep");
  assert.equal(claudeCall("ask_question", { q: 1 })!.tool_name, "AskUserQuestion");
  // nothing to check: no path, or a tool with no Claude counterpart
  assert.equal(claudeCall("write_file", {}), null);
  assert.equal(claudeCall("browser_click", { Path: "x" }), null);
});

test("a builder's agy calls are held to the guard, as a Claude builder's are", () => {
  const { ws, rules } = rendered("bea", "builder");
  assert.match(ruling(rules, "execute", run("git push origin main"), ws)!, /protected branch \(main\)/);
  assert.match(ruling(rules, "execute", run("ls && git push --force origin x"), ws)!, /--force-with-lease/);
  assert.equal(ruling(rules, "execute", run("ls -la && git status"), ws), null);
  assert.equal(ruling(rules, "edit", { name: "write_file", args: { Path: "a.txt", Content: "x" } }, ws), null);
  assert.equal(ruling(rules, "edit", { name: "edit_file", args: { Path: join(ws, "b.txt") } }, ws), null);
  assert.match(ruling(rules, "read", { name: "read_file", args: { Path: ".env" } }, ws)!, /\.env holds secrets/);
  assert.equal(ruling(rules, "read", { name: "read_file", args: { Path: "README.md" } }, ws), null);
  // a read that names nothing is read-only and allowed; a write or command that names nothing,
  // and every kind the rules have nothing for, is refused
  assert.equal(ruling(rules, "read", undefined, ws), null);
  assert.match(ruling(rules, "edit", { name: "write_file", args: {} }, ws)!, /^an edit call that names no file/);
  assert.match(ruling(rules, "execute", { name: "run_command", args: {} }, ws)!, /no command line/);
  assert.match(ruling(rules, "delete", undefined, ws)!, /names no file/);
  for (const k of ["fetch", "other", "switch_mode", undefined])
    assert.match(ruling(rules, k, { name: "read_url", args: { Url: "http://x" } }, ws)!, /the rules have nothing for/, String(k));
  assert.match(ruling(rules, "other", { name: "ask_question", args: {} }, ws)!, /nothing for/);
});

test("a reviewer's deny rules hold agy's commands and writes", () => {
  const { ws, rules } = rendered("rae", "reviewer");
  assert.match(ruling(rules, "execute", run("git push origin main"), ws)!, /denies it: Bash\(git push \*\)/);
  // each command of a line, and a command alone that a `x *` rule names
  assert.match(ruling(rules, "execute", run("echo hi; rm -rf build"), ws)!, /Bash\(rm \*\)/);
  assert.match(ruling(rules, "execute", run("ls | (npm)"), ws)!, /Bash\(npm \*\)/);
  // inside quotes is not a command
  assert.equal(ruling(rules, "execute", run("echo 'a; rm -rf b'"), ws), null);
  assert.equal(ruling(rules, "execute", run("git log --oneline"), ws), null);
  assert.match(ruling(rules, "edit", { name: "write_file", args: { Path: "a.txt", Content: "x" } }, ws)!, /denies it: Edit\(\/\//);
  assert.match(ruling(rules, "edit", { name: "edit_file", args: { Path: "/etc/hosts" } }, ws)!, /Edit\(\/\/etc\/\*\*\)/);
});

test("a hook that fails refuses the call, and the cwd and project dir are put back", () => {
  const { ws, rules } = rendered("bea", "builder");
  const broken = { ...rules, hooks: rules.hooks.map((h) => ({ ...h, argv: ["--role"] })) };
  const here = process.cwd();
  const before = process.env.CLAUDE_PROJECT_DIR;
  assert.notEqual(check(broken, { tool_name: "Bash", tool_input: { command: "ls" } }, ws, ws), null);
  assert.equal(process.cwd(), here);
  assert.equal(process.env.CLAUDE_PROJECT_DIR, before);
});

test("agy's hook denies what the rules refuse, and is neutral otherwise or outside superfactory", () => {
  const { ws, rules } = rendered("bea", "builder");
  const ev = (name: string, args: unknown) => JSON.stringify({ toolCall: { id: "1", name, args }, cwd: ws, conversationId: "c" });
  const saved = { r: process.env[RULES_ENV], p: process.env[PROJECT_ENV] };
  try {
    delete process.env[RULES_ENV];
    assert.deepEqual(agyHook([], ev("read_file", { Path: ".env" })), { code: 0 });
    process.env[RULES_ENV] = rules.file;
    process.env[PROJECT_ENV] = ws;
    const r = agyHook([], ev("read_file", { Path: ".env" }));
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout!);
    assert.equal(out.decision, "deny");
    assert.match(out.reason, /^superfactory: guard\[builder\]: refused\. \.env holds secrets/);
    assert.deepEqual(agyHook([], ev("read_file", { Path: "README.md" })), { code: 0 });
    assert.deepEqual(agyHook([], ev("browser_click", {})), { code: 0 }, "a call with no Claude counterpart is left to the supervisor");
    assert.equal(JSON.parse(agyHook([], "not json").stdout!).decision, "deny");
    process.env[RULES_ENV] = join(ws, "missing.json");
    assert.match(JSON.parse(agyHook([], ev("read_file", { Path: "README.md" })).stdout!).reason, /could not be read/);
  } finally {
    for (const [k, v] of [[RULES_ENV, saved.r], [PROJECT_ENV, saved.p]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test("the hook entry is written beside agy's other hooks, and any factory's entry will do", () => {
  const file = agyHooksFile();
  assert.ok(file.startsWith(process.env.SF_AGY_HOOKS!), "the tests never touch ~/.gemini");
  rmSync(file, { force: true });
  assert.match(agyHookMissing()!, /cannot be read/);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ mine: { PreToolUse: [{ matcher: "x", hooks: [] }] } }));
  ensureAgyHook();
  const v = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(v.mine, "other hooks are kept");
  assert.match(v["superfactory-guard"].PreToolUse[0].hooks[0].command, /^\[ -z "\$SF_AGY_RULES" \] \|\| exec .* hook agy$/);
  assert.equal(agyHookMissing(), null);
  v["superfactory-guard"].PreToolUse[0].hooks[0].command = `[ -z "$SF_AGY_RULES" ] || exec /other/factory hook agy`;
  writeFileSync(file, JSON.stringify(v));
  assert.equal(agyHookMissing(), null, "another factory's entry");
  v["superfactory-guard"].enabled = false;
  writeFileSync(file, JSON.stringify(v));
  assert.match(agyHookMissing()!, /no enabled/);
  v["superfactory-guard"] = { PreToolUse: [{ matcher: "run_command", hooks: [{ command: "x hook agy" }] }] };
  writeFileSync(file, JSON.stringify(v));
  assert.match(agyHookMissing()!, /not one that runs/);
  writeFileSync(file, "[]");
  assert.throws(() => ensureAgyHook(), /is not a JSON object/);
  rmSync(file, { force: true });
});
