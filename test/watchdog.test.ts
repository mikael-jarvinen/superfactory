// The unanswered watchdog's rules, without a scheduler.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../src/messages.js";
import { NO_WATCH, oldestUnanswered, step, type WatchEvent, type WatchState } from "../src/scheduler/watchdog.js";

const isHuman = (k: string | undefined) => k === "human";
const at = (min: number) => new Date(Date.UTC(2026, 10, 13, 12, min)).toISOString();
const row = (id: string, min: number, kind = "human"): Message => ({ id, t: at(min), kind, text: id });

test("the oldest unanswered message is the first after the last one seen", () => {
  const rows = [row("a00001", 0), row("a00002", 1), row("b00001", 2, "note"), row("a00003", 3), row("a00004", 4)];
  const seen = new Set(["a00002"]);
  const receipt = (id: string) => (seen.has(id) ? "seen" : "delivered") as "seen" | "delivered";
  assert.equal(oldestUnanswered(rows, { isHuman, receipt })?.id, "a00003", "a00001 never got a receipt, but a later one was seen");
  seen.add("a00004");
  assert.equal(oldestUnanswered(rows, { isHuman, receipt }), null);
  assert.equal(oldestUnanswered([row("x", 0, "answer")], { isHuman, receipt }), null, "only the human's rows count");
});

// A check a minute, from minute `from` to `to`, with the same oldest unanswered message throughout.
const o = { staleMinutes: 12, capMs: 2 * 60_000 };
function checks(state: WatchState, oldest: Message | null, from: number, to: number): { state: WatchState; events: WatchEvent[] } {
  const events: WatchEvent[] = [];
  for (let m = from; m <= to; m++) {
    const r = step(state, oldest, { ...o, nowMs: Date.parse(at(m)) });
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

test("one alert per episode, and the episode ends when its message is seen", () => {
  let r = checks(NO_WATCH, null, -5, -1);
  r = checks(r.state, row("a00001", 0), 0, 11);
  assert.deepEqual(r.events, [], "11 minutes is not stale");
  r = checks(r.state, row("a00001", 0), 12, 12);
  assert.deepEqual(r.events, [{ type: "alert", id: "a00001", t: at(0), age: 12 }]);
  r = checks(r.state, row("a00001", 0), 13, 40);
  assert.deepEqual(r.events, [], "not again in the same episode");
  r = checks(r.state, row("a00002", 30), 41, 41);
  assert.deepEqual(r.events, [{ type: "recovered", id: "a00001" }], "a00001 seen; a00002 is 11 minutes old");
  r = checks(r.state, row("a00002", 30), 42, 42);
  assert.deepEqual(r.events, [{ type: "alert", id: "a00002", t: at(30), age: 12 }], "a new episode, its age counted while a00001 was the oldest");
  r = checks(r.state, null, 43, 43);
  assert.deepEqual(r.events, [{ type: "recovered", id: "a00002" }]);
  assert.equal(r.state.alerted, null);
});

test("a suspend does not count toward the age, nor does time the scheduler was not running", () => {
  let r = checks(NO_WATCH, row("a00001", 0), 0, 1);
  // asleep from minute 1 to minute 480
  r = checks(r.state, row("a00001", 0), 480, 480);
  assert.equal(step(r.state, row("a00001", 0), { ...o, nowMs: Date.parse(at(480)) }).age, 2, "counted from the wake, plus the cap's margin");
  r = checks(r.state, row("a00001", 0), 481, 489);
  assert.deepEqual(r.events, []);
  r = checks(r.state, row("a00001", 0), 490, 490);
  assert.deepEqual(r.events, [{ type: "alert", id: "a00001", t: at(0), age: 12 }]);
  // a first check finds a message written long before it
  assert.equal(step(NO_WATCH, row("a00002", 0), { ...o, nowMs: Date.parse(at(300)) }).age, 2);
});
