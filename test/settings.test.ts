import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { inboxLock } from "../src/board/inbox.js";
import { tryLock } from "../src/tickets/lock.js";
import { agentOrDie } from "../src/fleet.js";
import { hook as markedComments } from "../src/hooks/marked-comments.js";
import { statusFile } from "../src/hooks/status.js";
import { sessionEnv, settingsFile } from "../src/launch.js";
import { TEMPLATES_DIR } from "../src/settings.js";
import { openWorkspace } from "../src/workspace.js";
import { CLI, TOML, tempWorkspace } from "./helpers.js";

interface Rendered {
  env?: Record<string, string>;
  permissions?: { deny?: string[]; allow?: string[]; defaultMode?: string };
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
}

const render = (dir: string, name: string): Rendered => {
  const ws = openWorkspace(dir, {});
  return JSON.parse(readFileSync(settingsFile(ws, agentOrDie(ws, name)), "utf8")) as Rendered;
};

const commandFor = (r: Rendered, event: string, matcher: string | undefined) =>
  r.hooks[event]?.find((e) => e.matcher === matcher)?.hooks[0]?.command as string;

// A hook command runs through a shell with the hook event on stdin, which is how Claude Code calls it.
const runHook = (command: string, event: unknown) => {
  const r = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(event), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

test("no template carries an absolute path", () => {
  for (const f of readdirSync(TEMPLATES_DIR)) {
    const text = readFileSync(join(TEMPLATES_DIR, f), "utf8");
    assert.doesNotMatch(text, /(["(\s])\/{1,2}[A-Za-z]/, f);
  }
});

test("each role renders its own hooks and rules into logs/run/", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const lead = render(dir, "ada");
  const builder = render(dir, "bea");
  const reviewer = render(dir, "rae");
  const tracker = (r: Rendered) => r.hooks.PreToolUse?.some((e) => e.matcher?.startsWith("mcp__claude_ai_Atlassian"));

  // the lead moves tickets and holds the inbox; nobody else does either
  assert.equal(tracker(lead), false);
  assert.equal(tracker(builder), true);
  assert.equal(tracker(reviewer), true);
  assert.match(commandFor(lead, "Stop", undefined), / hook status --agent ada --inbox$/);
  assert.equal(builder.hooks.Stop, undefined);

  assert.match(commandFor(lead, "PreToolUse", "Bash|Read|Grep|mcp__.*"), / hook guard --role lead --policy protect --allow-close \S+\/allow-close\.jsonl$/);
  assert.match(commandFor(builder, "PreToolUse", "Bash|Read|Grep|mcp__.*"), / hook guard --role builder --policy protect$/);
  assert.match(commandFor(reviewer, "PreToolUse", "Bash|Read|Grep|mcp__.*"), / hook guard --role reviewer --policy readonly$/);
  assert.equal(lead.permissions?.defaultMode, "bypassPermissions");
  assert.equal(reviewer.permissions?.defaultMode, "auto");

  // readonly Edit rules come from the workspace, and a rule naming the org goes when there is none
  assert.ok(reviewer.permissions?.deny?.includes(`Edit(/${dir}/**)`));
  assert.ok(reviewer.permissions?.allow?.includes("Edit(//tmp/**)"));
  assert.ok(!reviewer.permissions?.allow?.some((r) => r.includes("gh api repos/")));
  assert.equal(builder.permissions?.deny, undefined);
});

test("[peers] isolate_machines sets isolatePeerMachines for every session, true unless set", () => {
  const on = tempWorkspace();
  const off = tempWorkspace(TOML + "\n[peers]\nisolate_machines = false\n");
  after(() => { rmSync(on, { recursive: true, force: true }); rmSync(off, { recursive: true, force: true }); });
  const peer = (r: Rendered) => (r as unknown as { isolatePeerMachines?: boolean }).isolatePeerMachines;
  for (const name of ["ada", "bea", "rae"]) {
    assert.equal(peer(render(on, name)), true, name);
    assert.equal(peer(render(off, name)), false, name);
  }
});

// [github] lead_merges reaches only the lead's guard: a builder's guard never hears of those repos.
test("[github] lead_merges is rendered into the lead's guard and nobody else's", () => {
  const dir = tempWorkspace(TOML + '\n[github]\nlead_merges = ["acme/web"]\n');
  after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(commandFor(render(dir, "ada"), "PreToolUse", "Bash|Read|Grep|mcp__.*"), / --lead-merge acme\/web$/);
  for (const name of ["bea", "rae"]) assert.doesNotMatch(commandFor(render(dir, name), "PreToolUse", "Bash|Read|Grep|mcp__.*"), /--lead-merge/, name);
});

// Jira moved to the "claude.ai Atlassian MCP" connector, and a matcher written for the old one let
// a builder transition a ticket. Claude Code tests a regex matcher against the tool name unanchored.
test("a builder's tracker hook catches Jira writes on the new connector and the old, and no reads", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const builder = render(dir, "bea");
  const entry = builder.hooks.PreToolUse?.find((e) => e.matcher?.startsWith("mcp__claude_ai_Atlassian"));
  assert.ok(entry, "the builder has a tracker hook");
  assert.match(entry.hooks[0]?.command ?? "", / hook no-side-channels --lead ada$/);
  const matches = (tool: string) => new RegExp(entry.matcher as string).test(tool);

  const writes = ["transitionJiraIssue", "editJiraIssue", "createJiraIssue", "addOrEditJiraIssueComment",
    "createConfluenceContent", "updateConfluenceContent", "executeWrite", "executeDestructive", "addGraphContext"];
  for (const w of writes) assert.ok(matches(`mcp__claude_ai_Atlassian_MCP__${w}`), w);
  for (const w of ["transitionJiraIssue", "addCommentToJiraIssue", "createConfluencePage"])
    assert.ok(matches(`mcp__claude_ai_Atlassian__${w}`), `old connector: ${w}`);

  const reads = ["searchJiraIssuesUsingJql", "getJiraIssue", "listJiraIssueComments", "getConfluenceContent",
    "searchConfluence", "executeRead", "discover", "search", "atlassianUserInfo", "getAccessibleAtlassianResources"];
  for (const r of reads) assert.ok(!matches(`mcp__claude_ai_Atlassian_MCP__${r}`), r);
});

// Nomura could not run the functions tests: the Firebase emulators need java, and a builder's
// PATH had none. A stack's env and path_prepend reach every builder session on it, and no other.
test("a builder on a stack gets the stack's env, with its directories first on PATH", () => {
  const toml = TOML.replace("pin = { bea = 1 }\n", 'pin = { bea = 1 }\nenv = { JAVA_HOME = "/opt/java" }\npath_prepend = ["/opt/java/bin"]\n');
  const dir = tempWorkspace(toml);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});

  assert.deepEqual(sessionEnv(ws, agentOrDie(ws, "bea"), "/usr/bin:/opt/java/bin:/bin", ""),
    { JAVA_HOME: "/opt/java", PATH: "/opt/java/bin:/usr/bin:/opt/java/bin:/bin", SF_PATH_PREPEND: "/opt/java/bin" });
  const bea = render(dir, "bea");
  assert.equal(bea.env?.JAVA_HOME, "/opt/java");
  assert.equal(bea.env?.PATH, sessionEnv(ws, agentOrDie(ws, "bea"))?.PATH);
  assert.ok(bea.env?.PATH?.startsWith("/opt/java/bin:"));
  assert.equal(bea.env?.SF_PATH_PREPEND, "/opt/java/bin");
  // cal builds without a stack; the lead and the reviewer have none
  for (const name of ["cal", "ada", "rae"]) assert.equal(render(dir, name).env, undefined, name);
});

// A wake renders the recipient's settings in the sender's hook, whose PATH has the sender's stack
// first: what the sender's stack prepended comes out of it, and the recipient's own goes first
// (CodeRabbit on #127). Only that: a directory the sender's stack shares with the system PATH keeps
// its place there, for every other stack (Marie's gate of #127). The sender's PATH is its own render's.
test("a stack's PATH takes the sender's prepended directories out, and only those", () => {
  const toml = TOML.replace("pin = { bea = 1 }\n", 'pin = { bea = 1 }\npath_prepend = ["/opt/java/bin"]\n')
    .replace("[roles.lead]", '[repos.tools]\nremote = "acme/tools"\n\n[stacks.tools]\nrepos = ["tools"]\nslots = 1\npath_prepend = ["/usr/local/bin", "/opt/tools/bin"]\n\n[stacks.docs]\nrepos = ["tools"]\nslots = 1\nenv = { DOCS = "1" }\n\n[roles.lead]')
    .replace("[[agents]]\nname = \"cal\"", '[[agents]]\nname = "tia"\nrole = "builder"\nstack = "tools"\n\n[[agents]]\nname = "dot"\nrole = "builder"\nstack = "docs"\n\n[[agents]]\nname = "cal"');
  const dir = tempWorkspace(toml);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  const bea = agentOrDie(ws, "bea");
  const system = "/usr/local/bin:/usr/bin:/bin";
  // tia on tools sends: its session's env is its own render's, from the system PATH
  const tia = sessionEnv(ws, agentOrDie(ws, "tia"), system, "")!;
  assert.deepEqual(tia, { PATH: "/usr/local/bin:/opt/tools/bin:/usr/local/bin:/usr/bin:/bin", SF_PATH_PREPEND: "/usr/local/bin:/opt/tools/bin" });
  // bea's render in tia's hook keeps the system's /usr/local/bin
  const woken = sessionEnv(ws, bea, tia.PATH, tia.SF_PATH_PREPEND)!;
  assert.deepEqual(woken, { PATH: "/opt/java/bin:/usr/local/bin:/usr/bin:/bin", SF_PATH_PREPEND: "/opt/java/bin" });
  // and tia woken back from bea's session gets its own PATH again
  assert.deepEqual(sessionEnv(ws, agentOrDie(ws, "tia"), woken.PATH, woken.SF_PATH_PREPEND), tia);
  // a recipient that prepends nothing loses tia's run too: on a stack with env only, or on none
  // (Marie and Niilo on #127)
  assert.deepEqual(sessionEnv(ws, agentOrDie(ws, "dot"), tia.PATH, tia.SF_PATH_PREPEND), { DOCS: "1", PATH: system, SF_PATH_PREPEND: "" });
  for (const name of ["cal", "ada", "rae"])
    assert.deepEqual(sessionEnv(ws, agentOrDie(ws, name), tia.PATH, tia.SF_PATH_PREPEND), { PATH: system, SF_PATH_PREPEND: "" }, name);
  // and with no sender's run to take out, they keep the launcher's PATH, as before
  assert.equal(sessionEnv(ws, agentOrDie(ws, "cal"), system, ""), undefined);
  assert.deepEqual(sessionEnv(ws, agentOrDie(ws, "dot"), system, ""), { DOCS: "1" });
  // a sender with no stack prepended nothing, so nothing comes out: the system PATH stays whole behind bea's own
  assert.deepEqual(sessionEnv(ws, bea, "/usr/local/bin:/usr/bin:/opt/java/bin:/bin", ""),
    { PATH: "/opt/java/bin:/usr/local/bin:/usr/bin:/opt/java/bin:/bin", SF_PATH_PREPEND: "/opt/java/bin" });
});

// The old guard took its mode from the wrapper script's name, so the lead's session ran as a
// builder. The role now travels in the rendered command, and a command without one refuses.
test("the rendered guard runs, labelled with the role it was rendered for", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = commandFor(render(dir, "ada"), "PreToolUse", "Bash|Read|Grep|mcp__.*");
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

  const push = runHook(guard, bash("timeout 60 git push origin main"));
  assert.equal(push.status, 2);
  assert.match(push.stderr, /^guard\[lead\]: refused\. pushing to a protected branch \(main\) is not allowed\n/);
  assert.equal(runHook(guard, bash("timeout 5 ls")).status, 0);

  // the guard also sees Read and Grep, which can print a secret file without any Bash
  const read = runHook(guard, { tool_name: "Read", tool_input: { file_path: "/w/lyyti-classic/lyyti-config.php" } });
  assert.equal(read.status, 2);
  assert.match(read.stderr, /lyyti-config\.php holds secrets/);
  assert.equal(runHook(guard, { tool_name: "Read", tool_input: { file_path: "/w/web/.env.example" } }).status, 0);
  const grep = (output_mode: string) => runHook(guard, { tool_name: "Grep", tool_input: { pattern: "KEY", path: "/w/api/.env", output_mode } }).status;
  assert.deepEqual([grep("content"), grep("files_with_matches"), grep("count")], [2, 0, 0]);

  const unlabelled = runHook(guard.replace(/ --role lead/, ""), bash("ls"));
  assert.equal(unlabelled.status, 2);
  assert.match(unlabelled.stderr, /^guard: refused\. --role is missing\./);
  assert.equal(spawnSync(process.execPath, [CLI, "hook", "nope"], { input: "{}" }).status, 2);
});

test("the lead's stop is held once while nothing holds the inbox", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  const status = commandFor(render(dir, "ada"), "Stop", undefined);
  const stop = (active: boolean) => runHook(status, { hook_event_name: "Stop", stop_hook_active: active, transcript_path: "/t.jsonl", session_id: "s1" });

  const held = stop(false);
  assert.equal(held.status, 0);
  const out = JSON.parse(held.stdout) as { decision: string; reason: string };
  assert.equal(out.decision, "block");
  assert.match(out.reason, /^The message page inbox is not armed, so Alex's messages /);
  const { t, ...rest } = JSON.parse(readFileSync(statusFile(ws, "ada"), "utf8")) as { t: number };
  assert.equal(typeof t, "number");
  assert.deepEqual(rest, { words: "idle", event: "Stop", transcript: "/t.jsonl", session: "s1" });
  assert.equal(stop(true).stdout, "");
  const fd = tryLock(inboxLock(ws));
  assert.notEqual(fd, null);
  after(() => closeSync(fd as number));
  assert.equal(stop(false).stdout, "");
});

// Mikko via Niilo on superfactory#119 (L2): every session's GitHub comments go out under the human's
// login, so each must carry the marker, not only the guarded lead's and builders'. A template that
// names marked-comments renders a hook on Bash and the GitHub MCP tools that holds them to it.
test("a template with marked-comments refuses an unmarked comment and passes a marked one or a trigger", () => {
  const dir = tempWorkspace(TOML.replace('settings = "builder"', 'settings = "settings/marked.json"'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "settings"), { recursive: true });
  writeFileSync(join(dir, "settings", "marked.json"), JSON.stringify({ hooks: ["no-dialogs", "marked-comments"] }));
  const r = render(dir, "bea");
  const entry = r.hooks.PreToolUse?.find((e) => / hook marked-comments$/.test(e.hooks[0]?.command ?? ""));
  assert.ok(entry, "the hook is rendered");
  const matches = (tool: string) => new RegExp(`^(${entry.matcher})$`).test(tool);
  for (const t of ["Bash", "mcp__github__add_issue_comment", "mcp__github__add_reply_to_pull_request_comment", "mcp__claude_ai_GitHub__add_issue_comment"])
    assert.ok(matches(t), t);
  assert.ok(!matches("Read"), "not the other tools");
  const cmd = entry.hooks[0]?.command as string;
  const bash = (command: string) => runHook(cmd, { tool_name: "Bash", tool_input: { command } }).status;
  const mcp = (tool: string, body: string) => runHook(cmd, { tool_name: tool, tool_input: { body } }).status;

  assert.equal(bash("gh pr comment 7 -R acme/web --body '> Written by agent.\n\nFixed in abc1234.'"), 0, "marked passes");
  assert.equal(bash("gh api repos/acme/web/pulls/7/comments/9/replies -f body='> Written by agent. Fixed'"), 0, "a marked reply passes");
  assert.equal(bash("gh pr comment 7 --body '@coderabbitai review'"), 0, "a trigger passes");
  assert.equal(bash("gh pr view 7 --comments"), 0, "a read passes");
  assert.equal(bash("gh pr comment 7 --body 'Fixed in abc1234.'"), 2, "unmarked is refused");
  assert.equal(bash("cd /x && gh api repos/acme/web/pulls/7/comments/9/replies -f body=Fixed"), 2, "an unmarked reply is refused");
  assert.equal(bash("bash -c \"gh issue comment 3 -b hi\""), 2, "inside a shell -c too");
  assert.equal(bash('gh pr comment 7 --body "$(cat note.md)"'), 2, "an unchecked body is refused");

  assert.equal(mcp("mcp__github__add_issue_comment", "> Written by agent.\n\nFixed."), 0, "marked passes");
  assert.equal(mcp("mcp__github__add_reply_to_pull_request_comment", "@coderabbitai resolve"), 0, "a trigger passes");
  assert.equal(mcp("mcp__github__add_issue_comment", "Fixed."), 2, "unmarked is refused");
  assert.equal(mcp("mcp__github__pull_request_review_write", "Looks good to me."), 2, "an unmarked review body is refused");
  assert.equal(mcp("mcp__github__get_file_contents", "anything"), 0, "a read passes");

  // superfactory#119 round 2. N1: the hook refuses only a comment write, never a command the
  // guard's policy would (xargs, sudo, exec, watch), nor one it cannot parse.
  for (const c of ["printf x | xargs echo", "find . -name '*.ts' | xargs grep -l x", "sudo ls", "exec ls", "watch ls", "echo 'unbalanced", "/opt/x/bin/tool"])
    assert.equal(bash(c), 0, c);
  assert.equal(bash("printf 7 | xargs -I{} gh pr comment {} -b hi"), 2, "a gh behind xargs is still checked");
  assert.equal(bash("sudo -u x gh pr comment 7 -b hi"), 2, "and behind sudo");
  assert.equal(bash("/usr/bin/gh pr comment 7 -b hi"), 2, "and by path");
  assert.equal(bash("gh pr review 7 --comment -bhi"), 2, "N3: an attached value");
  assert.equal(bash("gh api graphql -f query='mutation { addComment(input: {subjectId: \"X\", body: \"hi\"}) { clientMutationId } }'"), 2, "N4");
  assert.equal(bash("gh api repos/acme/web/pulls/7/reviews -f 'body=> Written by agent.' -f 'comments[][body]=nit'"), 2, "N5");
  const submit = "gh api graphql -f query='mutation($i: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $i) { clientMutationId } }' -f 'i[pullRequestReviewId]=R'";
  assert.equal(bash(`${submit} -f 'i[body]=hi'`), 2, "round 3: an input variable's body");
  assert.equal(bash(`${submit} -f 'i[body]=> Written by agent. ok'`), 0, "a marked one passes");
  // N6: every MCP tool reaches the hook, which matches GitHub's comment tools in any case.
  assert.ok(matches("mcp__claude_ai_github__add_issue_comment") && matches("mcp__claude_ai_Slack__send"));
  assert.equal(mcp("mcp__claude_ai_github__add_issue_comment", "Fixed."), 2, "lowercase github is held too");
  assert.equal(mcp("mcp__claude_ai_Slack__send", "hi"), 0, "another server's tool passes");
});

// CodeRabbit on superfactory#128 (KJJU): valid JSON that is not an object (null, an array, a number,
// a string) is not a hook envelope. The hook refuses it with the invalid-input diagnostic, not a throw.
test("marked-comments refuses valid JSON that is not an object envelope", () => {
  for (const input of ["null", "[]", "3", '"s"']) {
    const r = markedComments([], input);
    assert.equal(r.code, 2, input);
    assert.match(r.stderr ?? "", /hook input was not the expected JSON/, input);
  }
});

// Mikael, 2026-11-25: "we should be able to read from slack. The guard was so that no agent send
// messages on their own." Slack reads pass for the lead and the assistants, by an exact list; every
// other Slack tool is refused for every role, and builders get no Slack at all.
test("Slack: the lead and assistants may read, nobody may write, and an unlisted tool is refused", () => {
  const dir = tempWorkspace(TOML.replace("[tracker]", `[[agents]]
name = "val"
role = "assistant"

[roles.assistant]
cwd = "assistants"
settings = "lead"

[tracker]`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const chat = "mcp__claude_ai_Slack__.*";
  const call = (agent: string, tool: string) => runHook(commandFor(render(dir, agent), "PreToolUse", chat), { tool_name: `mcp__claude_ai_Slack__${tool}`, tool_input: {} });
  for (const [agent, role] of [["ada", "lead"], ["val", "assistant"], ["bea", "builder"]] as const)
    assert.match(commandFor(render(dir, agent), "PreToolUse", chat), new RegExp(` hook no-side-channels --lead ada --role ${role}$`), agent);

  // a lead read and an assistant read pass
  for (const tool of ["slack_read_channel", "slack_search_public_and_private", "slack_read_thread"]) {
    assert.equal(call("ada", tool).status, 0, `lead: ${tool}`);
    assert.equal(call("val", tool).status, 0, `assistant: ${tool}`);
  }
  // a builder's read is refused
  const builder = call("bea", "slack_read_channel");
  assert.equal(builder.status, 2);
  assert.match(builder.stderr, /Slack reads are for Ada and the assistants only/);
  // writes are refused for the lead too
  for (const tool of ["slack_send_message", "slack_add_reaction", "slack_create_conversation"]) {
    const r = call("ada", tool);
    assert.equal(r.status, 2, tool);
    assert.match(r.stderr, /Slack is read-only: no agent posts, reacts, creates or edits there/, tool);
  }
  // a tool the connector adds later is refused until it is named
  assert.equal(call("ada", "slack_read_new_thing").status, 2);
  assert.equal(call("val", "slack_schedule_message").status, 2);
});
