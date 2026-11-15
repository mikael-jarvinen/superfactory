import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "../src/config.js";
import { owed, owesSession } from "../src/fleet.js";
import { idleWork } from "../src/idle.js";
import { type Rec, STATES } from "../src/state.js";

const rec = (ticket: string, state: string, stack: string | null = null, agent: string | null = null): Rec =>
  ({ ticket, state, stack, agent } as unknown as Rec);

const builder = (name: string, stack: string): Agent =>
  ({ name, role: "builder", stack, repos: [] } as unknown as Agent);

const reviewer = (name: string): Agent => ({ name, role: "reviewer", repos: [] } as unknown as Agent);

const FLEET: Agent[] = [
  builder("ramos", "classic"),
  builder("juarez", "modules"),
  builder("sanchez", "events"),
  reviewer("castro"),
  reviewer("kepler"),
];

test("queued work with a free builder of that stack is flagged", () => {
  const work = idleWork([rec("CL-1", "queued", "events")], FLEET, new Set());
  assert.equal(work.length, 1);
  assert.match(work[0] as string, /^dispatch: CL-1 \(events\)/);
});

test("queued work is not flagged when that stack's builder is busy building or fixing", () => {
  const recs = [rec("CL-1", "queued", "events"), rec("CL-2", "fixing", "events", "sanchez")];
  const work = idleWork(recs, FLEET, new Set(["sanchez"]));
  assert.deepEqual(work.filter((w) => w.startsWith("dispatch")), []);
});

test("a builder whose item is only in review still counts as free", () => {
  const recs = [rec("CL-1", "queued", "classic"), rec("CL-2", "agent-review", "classic", "ramos")];
  // One reviewer live so the agent-review rule does not also fire.
  const work = idleWork(recs, FLEET, new Set(["ramos", "castro"]));
  assert.ok(work.some((w) => w.startsWith("dispatch: CL-1 (classic)")));
});

test("a blocked ticket is never flagged for dispatch", () => {
  const work = idleWork([rec("CL-1", "blocked", "events")], FLEET, new Set());
  assert.deepEqual(work, []);
});

test("agent-review with no reviewer running is flagged", () => {
  const work = idleWork([rec("CL-1", "agent-review", "events", "sanchez")], FLEET, new Set(["sanchez"]));
  assert.ok(work.some((w) => /^review: 1 PR\(s\) at agent-review, 0 reviewer/.test(w)));
});

test("agent-review count within live reviewers is not flagged", () => {
  const recs = [rec("CL-1", "agent-review", "events", "sanchez"), rec("CL-2", "agent-review", "classic", "ramos")];
  const work = idleWork(recs, FLEET, new Set(["sanchez", "ramos", "castro", "kepler"]));
  assert.deepEqual(work.filter((w) => w.startsWith("review")), []);
});

test("a working state with a dead agent is a dropped delegation", () => {
  const work = idleWork([rec("CL-1", "building", "classic", "ramos")], FLEET, new Set());
  assert.ok(work.some((w) => w === "dropped: ramos has no live session while CL-1 is building"));
});

test("nothing actionable yields an empty list", () => {
  const recs = [rec("CL-1", "your-review", "events", "sanchez"), rec("CL-2", "done", "classic", "ramos")];
  const work = idleWork(recs, FLEET, new Set(["sanchez"]));
  assert.deepEqual(work, []);
});

test("the same queued ticket is reported once", () => {
  const work = idleWork([rec("CL-1", "queued", "events")], FLEET, new Set());
  assert.equal(work.filter((w) => w.includes("CL-1")).length, 1);
});

test("an agent whose host could not be asked is unknown, not dropped, and counts as a reviewer", () => {
  const fleet = [...FLEET, { name: "rae", role: "builder", stack: "events", repos: [] } as unknown as Agent];
  const work = idleWork([rec("CL-1", "building", "events", "rae")], fleet, new Set(), new Map([["rae", "host far: ECONNREFUSED"]]));
  assert.deepEqual(work.filter((w) => !w.startsWith("dispatch")), ["unknown: rae's host could not be asked (host far: ECONNREFUSED) while CL-1 is building"]);
  const recs = [rec("CL-2", "agent-review", "events", "sanchez"), rec("CL-3", "agent-review", "classic", "ramos")];
  assert.deepEqual(idleWork(recs, FLEET, new Set(["castro"]), new Map([["kepler", "host far: ECONNREFUSED"]])).filter((w) => w.startsWith("review")), []);
  assert.deepEqual(idleWork([...recs, rec("CL-4", "agent-review", "modules", "juarez")], FLEET, new Set(["castro"]), new Map([["kepler", "host far: ECONNREFUSED"]])).filter((w) => w.startsWith("review")),
    ["review: 3 PR(s) at agent-review, 1 reviewer(s) running, kepler unknown -- run factory review"]);
});

test("a builder is busy for idleWork exactly when its record owes it a session", () => {
  assert.deepEqual(STATES.filter((s) => owesSession(rec("CL-1", s, "events", "sanchez"))).sort(), ["building", "designing", "fixing"]);
  assert.equal(owesSession(rec("CL-1", "building")), false, "no agent, no session owed");
  for (const state of STATES) {
    const mine = rec("CL-1", state, "events", "sanchez");
    const free = idleWork([mine, rec("CL-2", "queued", "events")], FLEET, new Set()).some((w) => w.startsWith("dispatch: CL-2"));
    assert.equal(free, !owesSession(mine), `${state}: free for new work only when it owes no session`);
    assert.equal(owed(mine, new Set(), new Map()) === null, !owesSession(mine), `${state}: owed agrees`);
  }
});
