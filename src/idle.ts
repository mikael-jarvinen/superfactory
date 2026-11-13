// Teammates sitting idle while there is work they could pick up, as one actionable line each.
//
// The failure this catches is recurring: builders not running, or reviewers free, while tickets sit
// queued or PRs sit at agent-review with nobody reviewing. The lead's Stop hook reads this and
// refuses to go idle once while any line stands, the same way it refuses while the inbox is unarmed.
//
// `idleWork` is pure, with no IO of its own, so a test needs no workspace. `idleWorkFor` is the glue
// that gathers its inputs.
import type { Agent } from "./config.js";
import { fleetLines, owedNote, owesSession } from "./fleet.js";
import { allRecs, type Rec } from "./state.js";
import type { Workspace } from "./workspace.js";

export function idleWork(recs: Rec[], agents: Agent[], live: ReadonlySet<string>, unknown: ReadonlyMap<string, string> = new Map()): string[] {
  const out: string[] = [];

  // A builder is owed its item only while it is building or fixing. A PR in review, at the gate or
  // waiting on the human frees the builder for new work, and a builder with no session is free too.
  const busy = new Set<string>();
  for (const r of recs) if (owesSession(r)) busy.add(r.agent);
  const builders = agents.filter((a) => a.role === "builder");

  // 1. Queued work a free builder of that stack could take right now.
  const seen = new Set<string>();
  for (const r of recs) {
    if (r.state !== "queued" || !r.stack || seen.has(r.ticket)) continue;
    if (builders.some((b) => b.stack === r.stack && !busy.has(b.name))) {
      out.push(`dispatch: ${r.ticket} (${r.stack}) is queued and a ${r.stack} builder is free`);
      seen.add(r.ticket);
    }
  }

  // 2. PRs waiting at agent-review with fewer reviewer sessions running than PRs to cover.
  const atReview = recs.filter((r) => r.state === "agent-review").length;
  const reviewersLive = agents.filter((a) => a.role === "reviewer" && live.has(a.name)).length;
  const reviewersUnknown = agents.filter((a) => a.role === "reviewer" && unknown.has(a.name)).map((a) => a.name);
  if (atReview > reviewersLive + reviewersUnknown.length) {
    const asked = reviewersUnknown.length ? `, ${reviewersUnknown.join(", ")} unknown` : "";
    out.push(`review: ${atReview} PR(s) at agent-review, ${reviewersLive} reviewer(s) running${asked} -- run factory review`);
  }

  // 3. A working state whose builder has no live session: a dropped delegation.
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
