// PreToolUse hook for chat tools and the tracker's write tools, run as
// `factory hook no-side-channels --lead <name> [--role <role>]`. The human reads one thread, the
// lead's, and only the lead moves tickets. Enforced here because builders run in bypass mode, where
// deny rules do not apply. Which tools reach it is decided when the settings are rendered.
//
// Slack is read-only, and only for the lead and the assistants. The guard keeps agents from sending
// messages on their own, not from reading. So the reads below
// pass for those two roles, by exact name: an allow-list, so a tool the connector adds later is
// refused until someone names it here. Every other Slack tool, posting above all, is refused for every
// role, and builders, reviewers and designers get no Slack at all.
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";
import { capitalize } from "../util.js";
import { leadArg } from "./no-dialogs.js";

const SLACK = "mcp__claude_ai_Slack__";
export const SLACK_READS: ReadonlySet<string> = new Set([
  "slack_list_user_channels", "slack_search_channels", "slack_read_channel", "slack_read_thread",
  "slack_search_public", "slack_search_public_and_private", "slack_search_users", "slack_read_user_profile",
  "slack_list_channel_members", "slack_get_reactions", "slack_read_canvas", "slack_read_file",
  "slack_read_list", "slack_read_list_comments", "slack_search_emojis",
]);
const READERS: ReadonlySet<string> = new Set(["lead", "assistant"]);

export function hook(argv: string[], input = ""): HookResult {
  const lead = leadArg(argv);
  const role = parseArgs({ args: argv, options: { role: { type: "string" } }, strict: false }).values.role;
  let tool = "";
  try {
    const call = JSON.parse(input) as { tool_name?: unknown } | null;
    if (call && typeof call === "object" && typeof call.tool_name === "string") tool = call.tool_name;
  } catch {
    // no readable call: refused below like anything else
  }
  if (tool.startsWith(SLACK)) {
    const name = tool.slice(SLACK.length);
    if (typeof role === "string" && READERS.has(role) && SLACK_READS.has(name)) return { code: 0 };
    const why = SLACK_READS.has(name)
      ? `Slack reads are for ${capitalize(lead)} and the assistants only`
      : "Slack is read-only: no agent posts, reacts, creates or edits there";
    return { code: 2, stderr: `not your channel: ${why}. Report to ${lead} with SendMessage instead.\n` };
  }
  return {
    code: 2,
    stderr: `not your channel: tracker writes belong to ${capitalize(lead)}, and Slack is read-only. Report to ${lead} with SendMessage instead.\n`,
  };
}
