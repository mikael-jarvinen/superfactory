// `factory hook appendix`: a SessionStart hook that once handed a resumed session its current
// brief. Nothing resumes a session now, and no settings render it, but a session listed from before
// still names it in its settings, so it answers, and does nothing.
import type { HookResult } from "../settings.js";

export function hook(): HookResult {
  return { code: 0 };
}
