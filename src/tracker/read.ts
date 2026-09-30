// What a watcher asks of the tracker, and how its answer is read. The factory holds no tracker API
// token: the tracker is reached through Claude's own connector inside a `claude -p`, so a tracker
// here is the instructions for that session and a parser for what it prints. Nothing in this
// directory calls an API.
import type { Workspace } from "../workspace.js";
import { jira } from "./jira.js";
import { none } from "./none.js";

export interface Tracker {
  kind: string;
  // Whether a watcher reads this tracker at all. A tracker that is not read has no queue watcher,
  // and the round skips its questions.
  reads: boolean;
  // The tools a watcher session may call to read it, beyond ToolSearch.
  tools: string[];
  // How to read the queue, ending in the reply contract below.
  instructions(ws: Workspace): string;
}

export const trackerOf = (ws: Workspace): Tracker => (ws.config.tracker.kind === "jira" ? jira : none);

export const UNAVAILABLE = "TRACKER-UNAVAILABLE";

// The same for every tracker, so the parser has one format to read whoever wrote the query.
export const CONTRACT = `When the search returns, print one line per ticket it found:
TICKET: <key> <summary>
and then one line with every key it found, space separated, and nothing after the colon when it
found none:
QUEUE: <key> <key> ...
A program reads those lines, so print each at the start of a line with no formatting around it.

Only if the tool cannot be found, or the call errors, is the tracker unavailable. Then print no
QUEUE line, and make the last line of your reply the single word ${UNAVAILABLE}. Use that word in
no other case.`;

export type Read =
  | { outcome: "read"; keys: string[]; summaries: Record<string, string> }
  | { outcome: "unavailable" }
  | { outcome: "off-contract" };

export const lastLine = (reply: string) => reply.split("\n").filter((l) => l.trim()).pop()?.replace(/\s/g, "") ?? "";

// A read needs positive evidence, not the absence of the sentinel. The sentinel is a word the model
// has to remember to print, and a run that goes off contract, reporting an outage in prose, would
// otherwise count as a read that found nothing. The sentinel counts only as the whole last line,
// and it wins over a QUEUE line printed before it.
export function parseRead(ws: Workspace, reply: string): Read {
  if (lastLine(reply) === UNAVAILABLE) return { outcome: "unavailable" };
  const lines = reply.split("\n").map((l) => l.trim());
  const queue = lines.filter((l) => l.startsWith("QUEUE:")).pop();
  if (queue === undefined) return { outcome: "off-contract" };
  const pattern = ws.config.tracker.keyPattern;
  const valid = (k: string) => pattern?.test(k) ?? false;
  const keys = [...new Set(queue.slice("QUEUE:".length).split(/\s+/).filter(valid))];
  const summaries: Record<string, string> = {};
  for (const l of lines) {
    const m = /^TICKET:\s+(\S+)\s*(.*)$/.exec(l);
    if (m && valid(m[1] as string)) summaries[m[1] as string] = (m[2] as string).trim();
  }
  return { outcome: "read", keys, summaries };
}
