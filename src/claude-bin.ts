import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// $CLAUDE_BIN, else claude on PATH, else ~/.local/bin/claude.
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  for (const d of (env.PATH ?? "").split(delimiter)) if (d && executable(join(d, "claude"))) return join(d, "claude");
  return join(homedir(), ".local", "bin", "claude");
}
