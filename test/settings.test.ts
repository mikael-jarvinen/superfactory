import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { inboxLock } from "../src/board/inbox.js";
import { tryLock } from "../src/tickets/lock.js";
import { agentOrDie } from "../src/fleet.js";
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
