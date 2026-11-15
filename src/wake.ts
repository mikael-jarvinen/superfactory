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
import { findSession, type Session, waitForName } from "./fleet.js";
import { ask, Unreachable } from "./remote.js";
import { isAgentSession, newest, type Transport, transportFor } from "./transport.js";
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
}

export function wake(ws: Workspace, agent: Agent, o: WakeOptions = {}): Woken {
  const t = o.t ?? transportFor(ws, agent);
  const live = ask(() => findSession(t, agent.name));
  if (live instanceof Unreachable) return { is: "unknown", why: live.brief };
  if (t.alive(live)) return { is: "live", s: live };
  const all = ask(() => t.sessions(true));
  if (all instanceof Unreachable) return { is: "unknown", why: all.brief };
  const old = newest(all.filter(isAgentSession(agent.name)));
  if (!old?.id || (o.match && !o.match(old))) return { is: "none" };
  const r = t.respawn(agent.name, old.id);
  if (!r.ok) return { is: "failed", why: `respawn of ${old.id} failed: ${r.why || "no reason given"}` };
  const s = waitForName(t, agent.name, o.waitS ?? 60, o.pollMs ?? 1000);
  if (!s) return { is: "failed", why: `respawned ${old.id}, and it was not listed live within ${o.waitS ?? 60} s` };
  return { is: "woke", s, from: old.id };
}

// For the routes that keep context: the line to print, or null when nothing was woken.
export function wokeLine(name: string, w: Woken): string | null {
  if (w.is === "woke") return `${name} was off; woke ${w.from} (its conversation kept)`;
  if (w.is === "failed" || w.is === "unknown") return `${name} was off and did not wake (${w.why})`;
  return null;
}
