// Teammates sitting idle while there is work they could pick up, as one actionable line each.
//
// The failure this catches is recurring: reviewers free while PRs sit at agent-review with nobody
// reviewing, or a working state with no session. Waiting work lives in the backlog, which the lead
// reads, so a free builder is not flagged here. The lead's Stop hook reads this and
// refuses to go idle once while any line stands, the same way it refuses while the inbox is unarmed.
//
// `idleWork` is pure, with no IO of its own, so a test needs no workspace. `idleWorkFor` is the glue
// that gathers its inputs.
import type { Agent } from "./config.js";
import { fleetLines, owedNote } from "./fleet.js";
import { allRecs, type Rec } from "./state.js";
import type { Workspace } from "./workspace.js";

export function idleWork(recs: Rec[], agents: Agent[], live: ReadonlySet<string>, unknown: ReadonlyMap<string, string> = new Map()): string[] {
  const out: string[] = [];

  // 1. PRs waiting at agent-review with fewer reviewer sessions running than PRs to cover.
  const atReview = recs.filter((r) => r.state === "agent-review").length;
  const reviewersLive = agents.filter((a) => a.role === "reviewer" && live.has(a.name)).length;
  const reviewersUnknown = agents.filter((a) => a.role === "reviewer" && unknown.has(a.name)).map((a) => a.name);
  if (atReview > reviewersLive + reviewersUnknown.length) {
    const asked = reviewersUnknown.length ? `, ${reviewersUnknown.join(", ")} unknown` : "";
    out.push(`review: ${atReview} PR(s) at agent-review, ${reviewersLive} reviewer(s) running${asked} -- run factory review`);
  }

  // 2. A working state whose builder has no live session: a dropped delegation.
  for (const r of recs) {
    const note = owedNote(r, live, unknown);
    if (note) out.push(`${note.label.idle}: ${note.says}`);
  }

  return out;
}

export function idleWorkFor(ws: Workspace): string[] {
  const f = fleetLines(ws);
  return idleWork(allRecs(ws), ws.config.agents, new Set(f.live.keys()), f.unknown);
}
