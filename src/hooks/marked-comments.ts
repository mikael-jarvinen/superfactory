// PreToolUse hook for Bash and the GitHub MCP tools, run as `factory hook marked-comments`. The
// factory's sessions post under the human's token login, so the review watcher tells a comment of
// theirs from the human's own only by the marker it starts with (superfactory#119, L2). The protect
// guard holds the lead and builders to it; this holds every other role: an assistant runs no guard,
// and a reviewer's readonly guard does not see the MCP tools. A body must start with the marker or
// be a bot trigger, and be in the call itself.
import type { HookResult } from "../settings.js";
import { commentVerdict, mcpCommentVerdict } from "./guard.js";

export function hook(_argv: string[], input: string): HookResult {
  let call: { tool_name?: unknown; tool_input?: Record<string, unknown> };
  try {
    call = JSON.parse(input) as typeof call;
  } catch {
    return { code: 2, stderr: "marked-comments: refused. hook input was not the expected JSON\n" };
  }
  const tool = typeof call.tool_name === "string" ? call.tool_name : "";
  const tin = call.tool_input ?? {};
  const why = tool === "Bash"
    ? commentVerdict(typeof tin.command === "string" ? tin.command : "")
    : mcpCommentVerdict(tool, tin.body);
  return why ? { code: 2, stderr: `marked-comments: refused. ${why}\n` } : { code: 0 };
}
