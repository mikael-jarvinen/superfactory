// Waking an agent whose session is off. `claude stop` keeps the conversation, and `claude respawn
// <id>` reruns the session's command line under the same ids, so it comes back as it was. A message
// to a session that is off is not queued, so the session is woken before the message goes.
//
// Probed 2026-11-15: a respawn is listed live within 2 s, and on a host its Remote Control name took
// up to 10 s more to be addressable from another machine, hence WAKE_SETTLE_S.
import type { Agent } from "./config.js";
import { findSession, pollForName, type Session } from "./fleet.js";
import { refreshSettings } from "./launch.js";
import { freshCommand, resumable } from "./stopped.js";
import { ask, Unreachable } from "./remote.js";
import { isAgentSession, LISTING_TIMEOUT_MS, newest, type Transport, transportFor } from "./transport.js";
import type { Workspace } from "./workspace.js";

export const WAKE_SETTLE_S = 15;

export type Woken =
  | { is: "live"; s: Session }
  | { is: "woke"; s: Session; from: string }
  // no session under the name, or the newest is not the one the caller would wake
  | { is: "none" }
  // fresh: the command that starts it fresh, when its conversation cannot come back
  | { is: "failed"; why: string; fresh?: string }
  // the sessions could not be listed
  | { is: "unknown"; why: string };

export interface WakeOptions {
  t?: Transport;
  // How long to wait for the respawned session to be listed live.
  waitS?: number;
  pollMs?: number;
  // Wake only this one: false leaves the newest session off and answers none.
  match?: (s: Session) => boolean;
  // Epoch ms by which wake must have answered, for a caller with a timeout (the hook). No step
  // starts that could run past it; running out of time is failed, with why.
  deadline?: number;
}

export function wake(ws: Workspace, agent: Agent, o: WakeOptions = {}): Woken {
  const t = o.t ?? transportFor(ws, agent);
  const left = () => (o.deadline ?? Infinity) - Date.now();
  const late = (step: string): Woken => ({ is: "failed", why: `out of time before ${step}` });
  // A listing that cannot be had, a local one that timed out included, leaves the recipient unknown.
  const live = ask(() => findSession(t, agent.name));
  if (live instanceof Unreachable) return { is: "unknown", why: live.brief };
  if (t.alive(live)) return { is: "live", s: live };
  if (left() < LISTING_TIMEOUT_MS) return late("the stopped sessions were listed");
  const all = ask(() => t.sessions(true));
  if (all instanceof Unreachable) return { is: "unknown", why: all.brief };
  // Not findSession: it prefers a row alive() passes, and locally that is a host-wide check, so a
  // stale "done" row would beat the newest stopped session. The session the factory stopped is
  // resumed by its id, and never an older row in its place (stopped.ts).
  const which = resumable(ws, agent.name, all.filter(isAgentSession(agent.name)), newest);
  if ("gone" in which)
    return { is: "failed", fresh: freshCommand(agent),
      why: `${which.gone}, the session stopped last, is no longer listed, and an older one is another conversation; \`${freshCommand(agent)}\` starts it fresh` };
  const old = which.s;
  if (!old?.id || (o.match && !o.match(old))) return { is: "none" };
  if (left() - LISTING_TIMEOUT_MS < 1000) return late(`respawning ${old.id}`);
  // A failed render fails the wake: the caller is told, rather than an agent coming back on
  // settings older than its role's (CodeRabbit on #127). The render takes time of its own, so the
  // respawn's budget is what is left after it (CodeRabbit on #127).
  try {
    refreshSettings(ws, agent);
  } catch (e) {
    return { is: "failed", why: `${agent.name}'s settings could not be rendered: ${(e as Error).message}` };
  }
  const respawnMs = left() - LISTING_TIMEOUT_MS;
  if (respawnMs < 1000) return late(`respawning ${old.id}`);
  const r = t.respawn(agent.name, old.id, Number.isFinite(respawnMs) ? respawnMs : undefined);
  if (!r.ok) return { is: "failed", why: `respawn of ${old.id} failed: ${r.why || "no reason given"}` };
  const waitS = o.waitS ?? 60;
  const lastPollAt = (o.deadline ?? Infinity) - LISTING_TIMEOUT_MS;
  const s = pollForName(t, agent.name, waitS, o.pollMs ?? 1000, lastPollAt);
  // Respawned, and the last listing could not be had: most likely live, so not failed.
  if (s instanceof Unreachable) return { is: "unknown", why: `respawned ${old.id}, then ${s.brief}` };
  if (s) return { is: "woke", s, from: old.id };
  return { is: "failed", why: `respawned ${old.id}, and it was not listed live ${Date.now() >= lastPollAt ? "in the time the hook has" : `within ${waitS} s`}` };
}

export const wokeLine = (name: string, from: string) => `${name} was off; woke ${from} (its conversation kept)`;

// For the routes that keep context: wakes the session, prints what happened, and returns it once
// woken, or null when the caller is to start a fresh one.
export function wakeForRound(ws: Workspace, agent: Agent, t: Transport, match?: (s: Session) => boolean): Session | null {
  const w = wake(ws, agent, { t, ...(match ? { match } : {}) });
  if (w.is === "woke") console.log(wokeLine(agent.name, w.from));
  else if (w.is === "failed" || w.is === "unknown") console.log(`  warning: ${agent.name} was off and did not wake (${w.why}); starting a fresh session`);
  return w.is === "woke" ? w.s : null;
}
