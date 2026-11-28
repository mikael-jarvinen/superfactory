import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { agyHook, agyHookMissing, agyHooksFile, check, claudeCall, ensureAgyHook, HOOK_LOG_ENV, hookDecisions, loadRules, MCP_ENV, PROJECT_ENV, ruling, RULES_ENV } from "../src/backends/agy-guard.js";
import { MARKER } from "../src/gate/comment.js";
import { launchSpec } from "../src/launch.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace } from "./helpers.js";

// The rendered settings of an antigravity agent of the given role, and its workspace. A builder's
// MCP servers (settings/mcp.json) are a browser and GitHub, given in its build phase only.
function rendered(who: string, role: string, phase?: "build") {
  const ws = tempWorkspace(TOML.replace(`name = "${who}"\nrole = "${role}"\n`, `name = "${who}"\nrole = "${role}"\nbackend = "antigravity"\n`));
  after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(join(ws, "settings"), { recursive: true });
  writeFileSync(join(ws, "settings/mcp.json"), JSON.stringify({ mcpServers: { "playwright": { command: "npx" }, "github": { command: "gh-mcp" } } }));
  const w = openWorkspace(ws, {});
  const spec = launchSpec(w, w.config.agents.find((a) => a.name === who)!, "hi", null, phase);
  return { ws, spec, rules: loadRules(spec.settings!, spec.mcpConfig) };
}
const run = (CommandLine: string) => ({ name: "run_command", args: { CommandLine, WaitMsBeforeAsync: 0 } });

test("agy's calls take the shape of the Claude tool that does the same", () => {
  assert.deepEqual(claudeCall("run_command", { CommandLine: "ls" }), { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(claudeCall("write_file", { Path: "a", Content: "x" }), { tool_name: "Write", tool_input: { file_path: "a", content: "x" } });
  assert.deepEqual(claudeCall("edit_file", { Path: "a", Target: "x", Replacement: "y" }), { tool_name: "Edit", tool_input: { file_path: "a" } });
  assert.deepEqual(claudeCall("read_file", { Path: "a" }), { tool_name: "Read", tool_input: { file_path: "a" } });
  assert.deepEqual(claudeCall("grep_search", { SearchPath: "src", Includes: "*.ts" }), { tool_name: "Grep", tool_input: { path: "src", glob: "*.ts", output_mode: "content" } });
  assert.deepEqual(claudeCall("ask_question", { q: 1 }), { tool_name: "AskUserQuestion", tool_input: { q: 1 } });
  assert.deepEqual(claudeCall("search_web", { query: "q" }), { tool_name: "WebSearch", tool_input: { query: "q" } });
  assert.deepEqual(claudeCall("read_url_content", { Url: "https://x" }), { tool_name: "WebFetch", tool_input: { url: "https://x", prompt: "" } });
  // an MCP tool as Claude names it, without agy's toolSummary; the longest server name that fits
  assert.deepEqual(claudeCall("mcp_echo_add_issue_comment", { body: "hi", issue: 1, toolSummary: "x" }, ["echo"]), { tool_name: "mcp__echo__add_issue_comment", tool_input: { body: "hi", issue: 1 } });
  assert.equal((claudeCall("mcp_gh_x_pr_read", {}, ["gh", "gh-x"]) as { tool_name: string }).tool_name, "mcp__gh-x__pr_read");
  assert.deepEqual(claudeCall("read_resource", { ServerName: "echo", Uri: "u" }, ["echo"]), { tool_name: "ReadMcpResourceTool", tool_input: { server: "echo", uri: "u" } });
  // refused: a server the session is not given, a fetch with no URL, any move or rename
  assert.match((claudeCall("mcp_slack_post", {}, ["echo"]) as { refused: string }).refused, /not a tool of an MCP server this role is given \(echo\)/);
  assert.match((claudeCall("list_resources", { ServerName: "slack" }, []) as { refused: string }).refused, /it is given none/);
  assert.match((claudeCall("read_url_content", {}) as { refused: string }).refused, /names no URL/);
  for (const n of ["rename_file", "move_file"])
    assert.match((claudeCall(n, { Source: "a", Destination: "b" }) as { refused: string }).refused, /destination cannot be named/, n);
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
  assert.match(ruling(rules, "edit", { name: "write_file", args: {} }, ws)!, /^an edit call that names nothing the rules can check/);
  assert.match(ruling(rules, "execute", { name: "run_command", args: {} }, ws)!, /execute call that names nothing/);
  assert.match(ruling(rules, "delete", undefined, ws)!, /names nothing/);
  for (const k of ["switch_mode", undefined])
    assert.match(ruling(rules, k, { name: "read_url", args: { Url: "http://x" } }, ws)!, /the rules have nothing for/, String(k));
  // a call whose tool does not fit its kind, and a kind that names nothing
  assert.match(ruling(rules, "edit", run("ls"), ws)!, /agy names run_command, which the rules have nothing for/);
  assert.match(ruling(rules, "fetch", undefined, ws)!, /names nothing/);
  assert.match(ruling(rules, "other", { name: "update_steps", args: {} }, ws)!, /names nothing/);
  // a delete is judged by its path, as an Edit; a move by both paths, which agy has no tool to name
  assert.equal(ruling(rules, "delete", { name: "delete_file", args: { Path: "a.txt" } }, ws), null);
  assert.match(ruling(rules, "move", { name: "rename_file", args: { Source: "a.txt", Destination: "/etc/x" } }, ws)!, /destination/);
  assert.match(ruling(rules, "move", run("mv a.txt b.txt"), ws)!, /destination/);
  // a move by command is the guard's, which judges the destination as a Claude builder's mv
  assert.match(ruling(rules, "execute", run("mv .env notes.txt"), ws)!, /copying \.env out/);
  assert.equal(ruling(rules, "execute", run("mv a.txt b.txt"), ws), null);
  // fetch and web search, as a Claude builder has them
  assert.equal(ruling(rules, "search", { name: "search_web", args: { query: "q" } }, ws), null);
  assert.equal(ruling(rules, "fetch", { name: "read_url_content", args: { Url: "https://example.com" } }, ws), null);
});

test("MCP calls are judged by the role's servers and the hooks a Claude session of the role runs", () => {
  const { ws, spec, rules } = rendered("bea", "builder", "build");
  assert.deepEqual(rules.mcp, ["playwright", "github"]);
  assert.equal(spec.mcpConfig, join(ws, "settings/mcp.json"));
  const mcp = (name: string, args: Record<string, unknown>) => ({ name, args: { ...args, toolSummary: "s" } });
  assert.equal(ruling(rules, "other", mcp("mcp_playwright_browser_navigate", { url: "http://localhost:3000" }), ws), null);
  assert.match(ruling(rules, "other", mcp("mcp_github_add_issue_comment", { owner: "acme", repo: "web", issue_number: 1, body: "hi" }), ws)!, /read as the human's own/);
  assert.match(ruling(rules, "other", mcp("mcp_github_merge_pull_request", { owner: "acme", repo: "web", pullNumber: 1 }), ws)!, /guard/);
  assert.match(ruling(rules, "other", mcp("mcp_claude_ai_Slack_send_message", { text: "x" }), ws)!, /not a tool of an MCP server/);
  // outside its build phase a builder is given no browser, as launchSpec gives a Claude one none
  const plain = rendered("bea", "builder");
  assert.deepEqual(plain.rules.mcp, []);
  assert.match(ruling(plain.rules, "other", mcp("mcp_playwright_browser_navigate", { url: "x" }), plain.ws)!, /it is given none/);
  // a reviewer's readonly guard refuses every GitHub write
  const r = rendered("rae", "reviewer");
  const rr = { ...r.rules, mcp: ["github"] };
  assert.match(ruling(rr, "other", mcp("mcp_github_add_issue_comment", { owner: "acme", repo: "web", issue_number: 1, body: `${MARKER} hi` }), r.ws)!, /writes to GitHub, and this session may only read/);
  assert.equal(ruling(rr, "read", mcp("mcp_github_get_file_contents", { owner: "acme", repo: "web", path: "a" }), r.ws), null);
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
  assert.match(ruling(rules, "delete", { name: "delete_file", args: { Path: "/etc/hosts" } }, ws)!, /Edit\(\/\/etc\/\*\*\)/);
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
    assert.deepEqual(agyHook([], ev("update_steps", {})), { code: 0 }, "a call with no Claude counterpart is left to the supervisor");
    assert.match(JSON.parse(agyHook([], ev("mcp_slack_post", { text: "x" })).stdout!).reason, /not a tool of an MCP server this role is given: it is given none/);
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

// A PreToolUse event agy 1.5.19 sent its hook, recorded from a live session: the MCP call that
// started as mcp_echo_add_issue_comment in ACP's tool_call with the same id.
const RECORDED = readFileSync(fileURLToPath(new URL("../../test/fixtures/agy-pretooluse-mcp.json", import.meta.url)), "utf8");

test("agy's hook judges a recorded real event, and logs its decision by the call's id", () => {
  const { ws, rules } = rendered("bea", "builder");
  const ev = JSON.parse(RECORDED);
  assert.equal(ev.hookEventName, "PreToolUse");
  const mcpFile = join(ws, "echo-mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { echo: { command: "node" } } }));
  const log = join(ws, "hook.jsonl");
  const env = { [RULES_ENV]: rules.file, [PROJECT_ENV]: ws, [MCP_ENV]: mcpFile, [HOOK_LOG_ENV]: log };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, env);
    const input = JSON.stringify({ ...ev, cwd: ws, workspacePaths: [ws] });
    const out = JSON.parse(agyHook([], input).stdout!);
    assert.equal(out.decision, "deny");
    assert.match(out.reason, /^superfactory: guard\[builder\]: refused\. this comment would read as the human's own/);
    const marked = JSON.parse(input);
    marked.toolCall.args.body = `${MARKER} hi`;
    agyHook([], JSON.stringify(marked));
    const d = hookDecisions(log);
    assert.equal(d.get(ev.toolCall.id)?.decision, "pass", "the later decision for an id is the one kept");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
    process.env[MCP_ENV] = "";
    assert.match(JSON.parse(agyHook([], input).stdout!).reason, /mcp_echo_add_issue_comment is not a tool of an MCP server this role is given: it is given none/);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
