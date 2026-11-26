// How `factory up` brings the lead back: a running lead is left as it is, and one that is off
// starts a fresh session, with the model, effort, window and brief the config gives now. Its old
// conversation is never resumed: a resumed session keeps the command line and context it started
// with. The lead's CLAUDE.md and its first prompt (`factory status`, the records in state/) are the
// way back into its work.
import type { Agent } from "./config.js";
import { findSession } from "./fleet.js";
import { launch, leadPrompt, roleAppendix, roleOf } from "./launch.js";
import type { Transport } from "./transport.js";
import type { Workspace } from "./workspace.js";

export function bringUpLead(ws: Workspace, ld: Agent, t: Transport, out: (line: string) => void = console.log): void {
  const s = findSession(t, ld.name);
  if (t.alive(s)) {
    out(`${ld.name} already running (${s.id})`);
    return;
  }
  // Read before anything starts: a missing brief refuses here.
  const appendix = roleAppendix(ws, ld);
  const cwd = roleOf(ws, ld).cwd as string;
  const started = launch(ws, ld, cwd, leadPrompt(ws), appendix, undefined, t);
  out(`${ld.name} started (${started.id}) in ${cwd}${ld.remoteControl ? " with Remote Control" : ""}`);
}
