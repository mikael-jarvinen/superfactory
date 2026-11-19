// SessionStart hook for a resumed session, run as `factory hook appendix --file <path>`. claude keeps
// the system prompt a session started with when it is resumed or respawned, and reads no
// --append-system-prompt(-file) given then (Otto on Claude Code 2.1.327). So a brief edited since the
// session started would never reach it. The factory keeps each agent's current appendix at <path>
// (transport.ts's currentAppendixPath), written at every start and before every resume and wake, and
// this hook hands it to the resumed session as context. No file, no context: the agent has no
// appendix, or none was written yet.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";

export const RESUMED_BRIEF_HEAD =
  "Your brief as it stands now, given again because this session was resumed: a resumed session keeps the appendix it started with and reads no new one. Where the two differ, this one holds.";

export function hook(argv: string[], input: string): HookResult {
  const file = parseArgs({ args: argv, options: { file: { type: "string" } }, strict: false }).values.file;
  let source: unknown = "resume";
  try {
    source = (JSON.parse(input || "{}") as { source?: unknown }).source ?? "resume";
  } catch {
    // no event to read: the matcher already said it is a resume
  }
  if (source !== "resume" || typeof file !== "string" || !file || !existsSync(file)) return { code: 0 };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { code: 0 };
  const out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${RESUMED_BRIEF_HEAD}\n\n${text}` } };
  return { code: 0, stdout: JSON.stringify(out) + "\n" };
}
