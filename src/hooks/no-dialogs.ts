// PreToolUse hook for EnterPlanMode, ExitPlanMode and AskUserQuestion, run as
// `factory hook no-dialogs --lead <name>`. The first two open an approval dialog and the third
// waits for a keyboard; in a background session nobody is there, and the session blocks until
// someone attaches. Refused with a reason.
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";

export const leadArg = (argv: string[]) => {
  const v = parseArgs({ args: argv, options: { lead: { type: "string" } }, strict: false }).values.lead;
  return typeof v === "string" && v ? v : "the lead";
};

export function hook(argv: string[]): HookResult {
  return {
    code: 2,
    stderr: "unattended session: this tool waits for a human at the keyboard and would block the session. " +
      `State your assumption and continue, or SendMessage ${leadArg(argv)}.\n`,
  };
}
