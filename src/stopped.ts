// Sessions that ended. Nothing resumes one: every start is a new conversation, with the model,
// effort, window and brief the config gives now, and the agent's CLAUDE.md is the way back into its
// work. A stop leaves its row listed for `claude logs`; the agent's next start that comes up removes
// its rows that are no longer live, so they do not build up in the listing.
import type { Agent } from "./config.js";
import type { Session } from "./fleet.js";
import type { Transport } from "./transport.js";

// Stops and removes the agent's background rows that are not live, except keep (the start just up).
// A listing that fails leaves every row; a removal that fails leaves that one.
export function clearEnded(name: string, t: Pick<Transport, "sessions" | "alive" | "stop">, keep?: string): void {
  let rows: Session[];
  try {
    rows = t.sessions(true);
  } catch {
    return;
  }
  for (const r of rows) {
    const id = r.id;
    if (r.name !== name || r.kind !== "background" || !id || id === keep || t.alive(r)) continue;
    try {
      t.stop(name, id, true);
    } catch {
      // the rm failed: the row stays, for the next start
    }
  }
}

// The command that starts an agent that is off, for a caller that does not start it itself.
export const freshCommand = (a: Pick<Agent, "name" | "role">): string =>
  a.role === "lead" ? "factory up"
    : a.role === "reviewer" ? `factory review --name ${a.name}`
    : a.role === "assistant" ? `factory assistant ${a.name}`
    : `factory dispatch ${a.name} <KEY>`;
