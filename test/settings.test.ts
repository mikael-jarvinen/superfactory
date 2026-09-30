import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentOrDie } from "../src/fleet.js";
import { inboxPidFile, statusFile } from "../src/hooks/status.js";
import { settingsFile } from "../src/launch.js";
import { TEMPLATES_DIR } from "../src/settings.js";
import { openWorkspace } from "../src/workspace.js";
import { CLI, tempWorkspace } from "./helpers.js";

interface Rendered {
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
  const tracker = (r: Rendered) => r.hooks.PreToolUse?.some((e) => e.matcher?.startsWith("mcp__claude_ai_Atlassian__"));

  // the lead moves tickets and holds the inbox; nobody else does either
  assert.equal(tracker(lead), false);
  assert.equal(tracker(builder), true);
  assert.equal(tracker(reviewer), true);
  assert.match(commandFor(lead, "Stop", undefined), / hook status --agent ada --inbox$/);
  assert.equal(builder.hooks.Stop, undefined);

  assert.match(commandFor(lead, "PreToolUse", "Bash"), / hook guard --role lead --policy protect$/);
  assert.match(commandFor(builder, "PreToolUse", "Bash"), / hook guard --role builder --policy protect$/);
  assert.match(commandFor(reviewer, "PreToolUse", "Bash"), / hook guard --role reviewer --policy readonly$/);
  assert.equal(lead.permissions?.defaultMode, "bypassPermissions");
  assert.equal(reviewer.permissions?.defaultMode, "auto");

  // readonly Edit rules come from the workspace, and a rule naming the org goes when there is none
  assert.ok(reviewer.permissions?.deny?.includes(`Edit(/${dir}/**)`));
  assert.ok(reviewer.permissions?.allow?.includes("Edit(//tmp/**)"));
  assert.ok(!reviewer.permissions?.allow?.some((r) => r.includes("gh api repos/")));
  assert.equal(builder.permissions?.deny, undefined);
});

// The old guard took its mode from the wrapper script's name, so the lead's session ran as a
// builder. The role now travels in the rendered command, and a command without one refuses.
test("the rendered guard runs, labelled with the role it was rendered for", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = commandFor(render(dir, "ada"), "PreToolUse", "Bash");
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

  const push = runHook(guard, bash("timeout 60 git push origin main"));
  assert.equal(push.status, 2);
  assert.match(push.stderr, /^guard\[lead\]: refused\. pushing to a protected branch \(main\) is not allowed\n/);
  assert.equal(runHook(guard, bash("timeout 5 ls")).status, 0);

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
  writeFileSync(inboxPidFile(ws), `${process.pid}\n`);
  assert.equal(stop(false).stdout, "");
});
