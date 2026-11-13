import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonAlive, nextDue, runAlive } from "../src/scheduler/daemon.js";
import { isScheduler, stateFile } from "../src/scheduler/state.js";
import { startStamp } from "../src/stacks/process.js";
import { openWorkspace } from "../src/workspace.js";
import { tempWorkspace } from "./helpers.js";
import { every } from "../src/scheduler/launchd.js";

const at = (h: number, m: number, s = 0, day = 13) => new Date(2026, 10, day, h, m, s);

test("nextDue: the next calendar fire strictly after, in local time", () => {
  const quarter = every(15);
  assert.deepEqual(nextDue(quarter, at(10, 7, 30)), at(10, 15));
  assert.deepEqual(nextDue(quarter, at(10, 15)), at(10, 30), "a fire exactly now is the last one, not the next");
  assert.deepEqual(nextDue(quarter, at(10, 52)), at(11, 0));
  assert.deepEqual(nextDue([{ Minute: 7 }], at(10, 7, 1)), at(11, 7));
  assert.deepEqual(nextDue([{ Minute: 7 }], at(23, 59)), at(0, 7, 0, 14), "over midnight");
  assert.deepEqual(nextDue([{ Minute: 3 }, { Minute: 33 }], at(10, 20)), at(10, 33));
  assert.deepEqual(nextDue(every(360), at(13, 0)), at(18, 0));
  assert.deepEqual(nextDue(every(360), at(19, 0)), at(0, 0, 0, 14), "an hourly calendar over midnight");
  assert.throws(() => nextDue([], at(10, 0)));
});

test("daemonAlive: fresh, from a live pid", () => {
  const s = { pid: process.pid, at: new Date().toISOString(), checkSeconds: 30, jobs: {} };
  assert.equal(daemonAlive(s), true);
  assert.equal(daemonAlive(null), false);
  assert.equal(daemonAlive({ ...s, at: new Date(Date.now() - 91_000).toISOString() }), false, "three checks old");
  assert.equal(daemonAlive({ ...s, pid: 2 ** 22 + 1 }), false, "a pid that is gone");
});

// Europe/Helsinki: 2026-03-29 the clock jumps 03:00 EET -> 04:00 EEST at 01:00Z, and 2026-10-25 it
// goes back 04:00 EEST -> 03:00 EET at 01:00Z. An hourly job fires every real hour through both.
test("nextDue: through a clock change, an hourly job still fires every real hour", () => {
  const tz = process.env.TZ;
  process.env.TZ = "Europe/Helsinki";
  try {
    const z = (s: string) => new Date(s);
    assert.deepEqual(nextDue([{ Minute: 7 }], z("2026-10-25T00:07:00Z")), z("2026-10-25T01:07:00Z"), "03:07 EEST, then 03:07 EET");
    assert.deepEqual(nextDue([{ Minute: 7 }], z("2026-10-25T01:07:00Z")), z("2026-10-25T02:07:00Z"));
    assert.deepEqual(nextDue([{ Minute: 7 }], z("2026-03-29T00:07:00Z")), z("2026-03-29T01:07:00Z"), "02:07 EET, then 04:07 EEST");
    assert.deepEqual(nextDue([{ Hour: 0, Minute: 0 }], z("2026-10-24T21:00:00Z")), z("2026-10-25T22:00:00Z"), "a daily midnight across the change");
    assert.deepEqual(nextDue([{ Hour: 3, Minute: 0 }], z("2026-03-28T22:00:00Z")), z("2026-03-30T00:00:00Z"), "03:00 does not exist on the 29th, so it waits a day");
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test("runAlive: the recorded run, not whatever holds its pid now", async () => {
  const other = spawn("sleep", ["30"]);
  const pid = other.pid as number;
  try {
    const stamp = startStamp(pid);
    assert.ok(stamp, "a live process has a stamp");
    assert.equal(startStamp(pid), stamp, "and it does not change");
    assert.equal(runAlive({ due: "", pid, stamp }), true);
    assert.equal(runAlive({ due: "", pid, stamp: `${stamp}0` }), false, "a pid reused since the run was spawned");
    assert.equal(runAlive({ due: "", pid }), true, "no stamp: the pid alone, held off rather than doubled");
    assert.equal(runAlive({ due: "", pid: null, stamp }), false);
  } finally {
    other.kill();
  }
  await new Promise((r) => other.once("exit", r));
  assert.equal(startStamp(pid), null);
  assert.equal(runAlive({ due: "", pid, stamp: "x" }), false, "a pid that is gone");
});

test("startStamp: ps's start time does not move with TZ", () => {
  // the ps path, which macOS takes; Linux's procps prints lstart too
  const real = process.platform;
  const tz = process.env.TZ;
  Object.defineProperty(process, "platform", { value: "testos" });
  try {
    process.env.TZ = "Europe/Helsinki";
    const a = startStamp(process.pid);
    process.env.TZ = "America/Los_Angeles";
    const b = startStamp(process.pid);
    assert.ok(a);
    assert.equal(a, b);
  } finally {
    Object.defineProperty(process, "platform", { value: real });
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test("runAlive: a lookup that fails counts as alive, and is reported", () => {
  const seen: unknown[] = [];
  // the ps path with no ps to run
  const r = { due: "", pid: process.pid, stamp: "x" };
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "testos" });
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.equal(runAlive(r, (e) => seen.push(e)), true);
  } finally {
    Object.defineProperty(process, "platform", { value: real });
    process.env.PATH = path;
  }
  assert.equal(seen.length, 1);
});

test("isScheduler: the pid the workspace's state file names, with the start stamp it has now", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir);
  const write = (v: object) => {
    mkdirSync(join(ws.runDir), { recursive: true });
    writeFileSync(stateFile(ws), JSON.stringify({ at: new Date().toISOString(), checkSeconds: 30, jobs: {}, ...v }));
  };
  assert.equal(isScheduler(ws, process.pid), false, "no state file");
  write({ pid: process.pid, stamp: startStamp(process.pid) });
  assert.equal(isScheduler(ws, process.pid), true);
  assert.equal(isScheduler(ws, process.ppid), false, "another pid");
  write({ pid: process.pid, stamp: "an-earlier-boot:12345" });
  assert.equal(isScheduler(ws, process.pid), false, "a pid recycled since, as by another workspace's scheduler");
  write({ pid: process.pid });
  assert.equal(isScheduler(ws, process.pid), false, "no stamp, no trust");
});
