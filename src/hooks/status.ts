// Every hook event in one session, as 1-3 plain words for the board, run as
// `factory --workspace W hook status --agent A [--inbox]`.
//
// Registered for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact and
// SessionEnd. Writes logs/run/status-<agent>.json, which the board reads, with the transcript path
// the board reads receipts from.
//
// With --inbox, which only the lead gets, a Stop also checks the message page inbox. If nothing
// holds it, the stop is blocked once with the instruction to arm it, so an expired monitor is
// re-armed at the next stop at the latest.
//
// A hook that fails must not cost the session anything, so every error ends in exit 0.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { inboxHeld } from "../board/inbox.js";
import { idleWorkFor } from "../idle.js";
import { factoryCommand, type HookResult, shq } from "../settings.js";
import { capitalize } from "../util.js";
import { openWorkspace, resolveWorkspace, type Workspace } from "../workspace.js";

export const statusFile = (ws: Workspace, agent: string) => join(ws.runDir, `status-${agent}.json`);

const armText = (ws: Workspace) =>
  `The message page inbox is not armed, so ${ws.config.human.name}'s messages are going by the slow courier. ` +
  `Arm it now: Monitor with command \`${factoryCommand()} --workspace ${shq(ws.dir)} board --inbox\`, timeout_ms 1800000, ` +
  `description "message page" (load Monitor with ToolSearch first if it is deferred). ` +
  `Re-arm it on every expiry notice. Then carry on with whatever you were doing.`;

const idleText = (work: string[]) =>
  `There is work waiting while you go idle:\n` +
  work.map((w) => `  - ${w}`).join("\n") +
  `\nDispatch it, run the review, or record why it must wait (\`factory state <TICKET> blocked\`), then stop again.`;

const EVENT_WORDS: Record<string, string> = {
  SessionStart: "starting", UserPromptSubmit: "reading", PostToolUse: "thinking",
  Stop: "idle", PreCompact: "compacting", SessionEnd: "offline",
};

const TOOL_WORDS: Record<string, string> = {
  Read: "reading", Grep: "reading", Glob: "reading", LS: "reading",
  Edit: "editing", Write: "editing", MultiEdit: "editing", NotebookEdit: "editing",
  Agent: "delegating", Task: "delegating",
  WebFetch: "researching", WebSearch: "researching",
  ListAgents: "checking the team", Monitor: "listening", TaskStop: "stopping a job",
  ToolSearch: "thinking", Skill: "working", Artifact: "publishing",
};

// First match wins, so the specific factory commands come before the bare one.
const BASH_WORDS: [RegExp, string][] = [
  [/phpunit|vitest|pytest|yarn (run )?test|npm test|make test/, "running tests"],
  [/\bfactory say\b/, "writing to you"],
  [/\bfactory (pr-|delta-range)/, "checking a PR"],
  [/\bfactory stack\b/, "minding stacks"],
  [/\bfactory\b/, "updating the board"],
  [/\bgh pr\b/, "checking a PR"],
  [/\bgh\b/, "checking GitHub"],
  [/\bgit push\b/, "pushing"],
  [/\bgit\b/, "checking git"],
  [/docker/, "minding stacks"],
  [/jira/, "checking Jira"],
];

const MCP_WORDS: [string, string][] = [
  ["atlassian", "checking Jira"], ["slack", "checking Slack"], ["playwright", "using the browser"], ["chrome", "using the browser"],
];

function wordsForTool(ws: Workspace, name: string, input: Record<string, unknown>): string {
  if (name === "SendMessage") {
    const to = String(input.to ?? "").replace(/\s*\[.*$/, "").trim();
    return to && to !== "main" ? `messaging ${capitalize(to)}` : "messaging";
  }
  if (name === "PushNotification") return `notifying ${ws.config.human.name}`;
  if (name === "Bash") {
    const cmd = String(input.command ?? "");
    return BASH_WORDS.find(([re]) => re.test(cmd))?.[1] ?? "running a command";
  }
  if (name.startsWith("mcp__")) {
    const low = name.toLowerCase();
    return MCP_WORDS.find(([k]) => low.includes(k))?.[1] ?? "using a tool";
  }
  return TOOL_WORDS[name] ?? "working";
}

interface Event {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  transcript_path?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

function status(argv: string[], input: string, workspace: string | undefined): HookResult {
  const { values } = parseArgs({ args: argv, options: { agent: { type: "string" }, inbox: { type: "boolean" } }, strict: true });
  const agent = values.agent;
  if (!agent || !/^[a-z][a-z0-9-]*$/.test(agent)) return { code: 0 };
  const d = JSON.parse(input) as Event;
  const ev = d.hook_event_name ?? "";
  const ws = openWorkspace(resolveWorkspace({ flag: workspace }));
  const words = ev === "PreToolUse" ? wordsForTool(ws, d.tool_name ?? "", d.tool_input ?? {}) : EVENT_WORDS[ev];
  if (!words) return { code: 0 };
  mkdirSync(ws.runDir, { recursive: true });
  const file = statusFile(ws, agent);
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ t: Date.now() / 1000, words, event: ev, transcript: d.transcript_path ?? null, session: d.session_id ?? null }));
  renameSync(tmp, file);
  if (ev === "Stop" && values.inbox && !d.stop_hook_active) {
    const reasons: string[] = [];
    if (!inboxHeld(ws)) reasons.push(armText(ws));
    let work: string[] = [];
    try {
      work = idleWorkFor(ws);
    } catch {
      work = [];
    }
    if (work.length) reasons.push(idleText(work));
    if (reasons.length)
      return { code: 0, stdout: JSON.stringify({ decision: "block", reason: reasons.join("\n\n") }) + "\n" };
  }
  return { code: 0 };
}

export function hook(argv: string[], input: string, workspace?: string): HookResult {
  try {
    return status(argv, input, workspace);
  } catch {
    return { code: 0 };
  }
}
