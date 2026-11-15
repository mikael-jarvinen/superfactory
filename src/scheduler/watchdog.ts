// The unanswered watchdog, run by the scheduler off macOS. It is a check that must not live inside
// the lead's session: a message from the human that the lead has not seen for a while means the
// lead is not listening, and a stuck lead cannot report that itself.
//
// "Seen" is the board's receipt: the lead's transcript holds the message's [m:id] with an assistant
// turn after it. Only what came after the last message the lead has seen counts, so an old row with
// no receipt does not hold an alert open forever.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipts } from "../board/inbox.js";
import { lead } from "../fleet.js";
import { leadStatus } from "../hooks/status.js";
import { type Message, isHuman, post, readTail } from "../messages.js";
import type { Workspace } from "../workspace.js";

type Receipt = ReturnType<Receipts["receipt"]>;

// The first human message after the last one the lead has seen, or null. rows are in log order.
export function oldestUnanswered(rows: Message[], { isHuman, receipt }: { isHuman: (kind: string | undefined) => boolean; receipt: (id: string) => Receipt }): Message | null {
  const human = rows.filter((r) => r.id && r.t && isHuman(r.kind));
  let from = 0;
  human.forEach((r, i) => {
    if (receipt(r.id as string) === "seen") from = i + 1;
  });
  return human[from] ?? null;
}

export interface WatchState {
  alerted: string | null;
  since: string | null;
  // Since when the checks have run without a gap, and when the last one was.
  awakeFrom: string | null;
  checked: string | null;
}

export const NO_WATCH: WatchState = { alerted: null, since: null, awakeFrom: null, checked: null };

export type WatchEvent = { type: "recovered"; id: string } | { type: "alert"; id: string; t: string; age: number };

// One alert per episode: an episode is one unanswered message, and it ends when that message is no
// longer the oldest unanswered one (the lead saw it, or saw something after it). A watchdog that
// repeats every check is a watchdog people mute.
//
// The age counts from the message or from the current run of checks, whichever is later. A gap over
// capMs between checks (a suspend, or no scheduler) starts a new run, backdated by capMs.
// The backdating is a margin on purpose: the gap's last capMs may have been awake.
export function step(state: WatchState, oldest: Message | null, { nowMs, capMs, staleMinutes }: { nowMs: number; capMs: number; staleMinutes: number }): { state: WatchState; events: WatchEvent[]; age: number | null } {
  const unbroken = state.awakeFrom && state.checked && nowMs - Date.parse(state.checked) <= capMs;
  const awakeFrom = unbroken ? (state.awakeFrom as string) : new Date(nowMs - capMs).toISOString();
  const age = oldest ? Math.floor((nowMs - Math.max(Date.parse(oldest.t as string), Date.parse(awakeFrom))) / 60000) : null;
  const events: WatchEvent[] = [];
  let next: WatchState = { ...state, awakeFrom, checked: new Date(nowMs).toISOString() };
  if (state.alerted && state.alerted !== oldest?.id) {
    events.push({ type: "recovered", id: state.alerted });
    next = { ...next, alerted: null, since: null };
  }
  if (oldest && !next.alerted && age !== null && age >= staleMinutes) {
    events.push({ type: "alert", id: oldest.id as string, t: oldest.t as string, age });
    next = { ...next, alerted: oldest.id as string, since: new Date(nowMs).toISOString() };
  }
  return { state: next, events, age };
}

// Kept in a file, so a restarted scheduler does not alert twice for one episode, and keeps the age.
export const watchFile = (ws: Workspace) => join(ws.runDir, "watchdog.json");

// The local time of day a message was written, as the page shows it.
const hhmm = (t: string) => new Date(t).toTimeString().slice(0, 5);

// One check: read the log and the lead's receipts, post an alert or note a recovery, keep the state.
export function watchdog(ws: Workspace, { staleMinutes, checkSeconds, receipts }: { staleMinutes: number; checkSeconds: number; receipts: Receipts }, log: (line: string) => void): () => void {
  let state = NO_WATCH;
  try {
    const s = JSON.parse(readFileSync(watchFile(ws), "utf8")) as Partial<WatchState>;
    state = { ...NO_WATCH, ...Object.fromEntries(Object.entries(s).filter(([k]) => k in NO_WATCH)) };
  } catch {
    // never written
  }
  return () => {
    const name = lead(ws).name;
    receipts.read(leadStatus(ws).transcript);
    const oldest = oldestUnanswered(readTail(ws.messages), { isHuman: (k) => isHuman(ws, k), receipt: (id) => receipts.receipt(id) });
    const r = step(state, oldest, { nowMs: Date.now(), capMs: Math.max(2 * checkSeconds, 60) * 1000, staleMinutes });
    for (const e of r.events) {
      if (e.type === "recovered") log(`watchdog: ${name} has seen [m:${e.id}] or a later message, episode over`);
      else {
        log(`watchdog: ALERT, [m:${e.id}] unseen by ${name} for ${e.age} min`);
        post(ws, { text: `${name} has not seen your message of ${hhmm(e.t)} after ${e.age} minutes. Nudge the session to get an answer.`, kind: "watchdog" });
      }
    }
    state = r.state;
    const p = watchFile(ws);
    writeFileSync(`${p}.tmp`, JSON.stringify({ ...state, oldest: oldest?.id ?? null, ageMinutes: r.age }, null, 2) + "\n");
    renameSync(`${p}.tmp`, p);
  };
}
