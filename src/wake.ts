// Bringing up an agent whose session is off. A start is always a new conversation, with the model,
// effort, window and brief the config gives now: an old conversation is never resumed or
// respawned, as it would come back on the command line, model and context it started with. The
// agent's CLAUDE.md is the way back into its work. A message to a session that is off is not
// queued, so the session is started before the message goes.
//
// A lead, reviewer or assistant starts in its role's cwd with its role's first prompt. A builder or
// designer works on an item, and starts fresh on it through `factory dispatch`, so wake starts
// neither and says that command instead.
//
// A start is listed live within a few seconds, and on a host its Remote Control name takes up to
// 10 s more to be addressable from another machine, hence WAKE_SETTLE_S.
import type { Agent } from "./config.js";
import { closeSync } from "node:fs";
import { findSession, type Session } from "./fleet.js";
import { assistantPrompt, launch, leadPrompt, reviewerPrompt, roleAppendix, roleOf, startLock } from "./launch.js";
import { tryLock } from "./tickets/lock.js";
import { freshCommand } from "./stopped.js";
import { ask, CHILD_SLACK_MS, Unreachable } from "./remote.js";
import { LISTING_TIMEOUT_MS, type Transport, transportFor } from "./transport.js";
import { FactoryError, sleep } from "./util.js";
import type { Workspace } from "./workspace.js";

export const WAKE_SETTLE_S = 15;

export type Woken =
  | { is: "live"; s: Session }
  | { is: "started"; s: Session }
  // fresh: the command that starts it, when wake does not (a builder or designer)
  | { is: "failed"; why: string; fresh?: string }
  // the sessions could not be listed
  | { is: "unknown"; why: string };

export interface WakeOptions {
  t?: Transport;
  // How long to wait for the new session to be listed live.
  waitS?: number;
  pollMs?: number;
  // Epoch ms by which wake must have answered, for a caller with a timeout (the hook). No step
  // starts that could run past it; running out of time is failed, with why.
  deadline?: number;
}

// The first prompt of a session wake may start, or null for a role that starts on an item.
export function firstPrompt(ws: Workspace, agent: Agent): string | null {
  switch (agent.role) {
    case "lead": return leadPrompt(ws);
    case "reviewer": return reviewerPrompt(ws);
    case "assistant": return assistantPrompt(ws);
    default: return null;
  }
}

// Under the agent's start lock (launch.ts), the check for a live session included: a second wake
// while the first one's start is under way waits for it and then finds it live, never starting a
// second session under the same name.
export function wake(ws: Workspace, agent: Agent, o: WakeOptions = {}): Woken {
  const left = () => (o.deadline ?? Infinity) - Date.now();
  const lock = startLock(ws, agent.name);
  let fd: number | null;
  try {
    while ((fd = tryLock(lock)) === null) {
      if (left() < 1000) return { is: "failed", why: `another start of ${agent.name} is under way; out of time waiting for it` };
      sleep(50);
    }
  } catch (e) {
    if (e instanceof FactoryError) return { is: "failed", why: e.message };
    throw e;
  }
  try {
    return wakeLocked(ws, agent, o, left);
  } finally {
    closeSync(fd);
  }
}

function wakeLocked(ws: Workspace, agent: Agent, o: WakeOptions, left: () => number): Woken {
  const t = o.t ?? transportFor(ws, agent);
  // A listing that cannot be had, a local one that timed out included, leaves the recipient unknown.
  const live = ask(() => findSession(t, agent.name));
  if (live instanceof Unreachable) return { is: "unknown", why: live.brief };
  if (t.alive(live)) return { is: "live", s: live };
  const prompt = firstPrompt(ws, agent);
  if (prompt === null)
    return { is: "failed", fresh: freshCommand(agent), why: `a ${agent.role} starts fresh on its item: \`${freshCommand(agent)}\`` };
  // the start, then listings until it is up, each up to LISTING_TIMEOUT_MS
  const waitMs = left() - 2 * LISTING_TIMEOUT_MS;
  // a request to a host is given its child's slack on top of its own timeout (remote.ts)
  if (waitMs < (agent.host ? CHILD_SLACK_MS : 0) + 1000) return { is: "failed", why: `out of time before starting ${agent.name}` };
  let s: Session;
  try {
    const appendix = roleAppendix(ws, agent);
    const waitS = Math.min(o.waitS ?? 90, waitMs / 1000);
    const bounded = left() !== Infinity;
    s = launch(ws, agent, roleOf(ws, agent).cwd as string, prompt, appendix, undefined, t,
      { waitS, pollMs: o.pollMs, lastPollAt: bounded ? Date.now() + waitMs : Infinity, locked: true, ...(bounded ? { startMs: waitMs } : {}) });
  } catch (e) {
    // a start whose listing could not be had after it (launch.ts); a start refused is failed
    if (e instanceof Unreachable) return { is: "unknown", why: e.message };
    if (e instanceof FactoryError) return { is: "failed", why: e.message };
    throw e;
  }
  return { is: "started", s };
}

export const startedLine = (name: string, id: string | undefined) => `${name} was off; started a fresh session (${id ?? "?"})`;
