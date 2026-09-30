// PreToolUse hook for chat tools and the tracker's write tools, run as
// `factory hook no-side-channels --lead <name>`. The human reads one thread, the lead's, and only
// the lead moves tickets. Enforced here because builders run in bypass mode, where deny rules do
// not apply. Which tools reach it is decided when the settings are rendered.
import type { HookResult } from "../settings.js";
import { capitalize } from "../util.js";
import { leadArg } from "./no-dialogs.js";

export function hook(argv: string[]): HookResult {
  const lead = leadArg(argv);
  return {
    code: 2,
    stderr: `not your channel: tracker writes belong to ${capitalize(lead)}, and Slack to nobody. Report to ${lead} with SendMessage instead.\n`,
  };
}
