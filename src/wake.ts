// Waking an agent whose session is off. An idle session can be stopped to give its memory back (by
// the workspace's own daemon, or by Claude's, which retires a settled session after hours idle).
// `claude stop` keeps the conversation, and `claude respawn <id>` reruns the session's command line
// under the same id and session id, so its mode, settings and appendix come back with it and the
// conversation carries on.
//
// A message to a session that is off is not queued: SendMessage fails with "No agent named ... is
// reachable". So the session is woken before the message goes, never after: `factory wake`, the
// wake hook on SendMessage, and the routes that keep an agent's context (a fix round, another
// design round, a named assistant) all come through here.
//
// Probed 2026-11-15: a local respawn is listed live within 2 s. A session on a host comes back
// in its host's listing as fast, but its Remote Control name took up to 10 s more to be
// addressable from another machine, hence WAKE_SETTLE_S after a wake on a host.
import type { Agent } from "./config.js";
import { findSession, type Session } from "./fleet.js";
import { ask, Unreachable } from "./remote.js";
import { isAgentSession, newest, type Transport, transportFor } from "./transport.js";
import { sleep } from "./util.js";
import type { Workspace } from "./workspace.js";

export const WAKE_SETTLE_S = 15;

export type Woken =
  | { is: "live"; s: Session }
  | { is: "woke"; s: Session; from: string }
  // no session under the name, or the newest is not the one the caller would wake
  | { is: "none" }
  | { is: "failed"; why: string }
  // the host could not be asked
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

// The longest one listing may take: a remote one is bounded at 20 s plus its child's 5 s.
const listingMs = (t: Transport) => (t.where === "local" ? 5_000 : 25_000);

export function wake(ws: Workspace, agent: Agent, o: WakeOptions = {}): Woken {
  const t = o.t ?? transportFor(ws, agent);
  const budget = listingMs(t);
  const left = () => (o.deadline ?? Infinity) - Date.now();
  const late = (step: string): Woken => ({ is: "failed", why: `out of time before ${step}` });
  const live = ask(() => findSession(t, agent.name));
  if (live instanceof Unreachable) return { is: "unknown", why: live.brief };
  if (t.alive(live)) return { is: "live", s: live };
  if (left() < budget) return late("the stopped sessions were listed");
  const all = ask(() => t.sessions(true));
  if (all instanceof Unreachable) return { is: "unknown", why: all.brief };
  const old = newest(all.filter(isAgentSession(agent.name)));
  if (!old?.id || (o.match && !o.match(old))) return { is: "none" };
  // the respawn leaves time for at least one listing after it
  const respawnMs = left() - budget;
  if (respawnMs < 1000) return late(`respawning ${old.id}`);
  const r = t.respawn(agent.name, old.id, Number.isFinite(respawnMs) ? respawnMs : undefined);
  if (!r.ok) return { is: "failed", why: `respawn of ${old.id} failed: ${r.why || "no reason given"}` };
  const waitS = o.waitS ?? 60;
  const pollMs = o.pollMs ?? 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < waitS * 1000) {
    const s = ask(() => findSession(t, agent.name));
    if (!(s instanceof Unreachable) && t.alive(s)) return { is: "woke", s, from: old.id };
    const nap = Math.min(pollMs, left() - budget);
    if (nap <= 0) return { is: "failed", why: `respawned ${old.id}, and it was not listed live in the time the hook has` };
    sleep(nap);
  }
  return { is: "failed", why: `respawned ${old.id}, and it was not listed live within ${waitS} s` };
}

// For the routes that keep context: the line to print, or null when nothing was woken.
export function wokeLine(name: string, w: Woken): string | null {
  if (w.is === "woke") return `${name} was off; woke ${w.from} (its conversation kept)`;
  if (w.is === "failed" || w.is === "unknown") return `${name} was off and did not wake (${w.why})`;
  return null;
}
