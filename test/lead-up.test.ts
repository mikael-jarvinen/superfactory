import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { Session } from "../src/fleet.js";
import { lead } from "../src/fleet.js";
import { launch, leadPrompt, settingsFile } from "../src/launch.js";
import { bringUpLead, resumePrompt } from "../src/lead-up.js";
import { forgetStopped, lastStopped, noteStopped, resumable } from "../src/stopped.js";
import { wake } from "../src/wake.js";
import type { StartRequest, Transport } from "../src/transport.js";
import { FactoryError } from "../src/util.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace } from "./helpers.js";

const dir = tempWorkspace();
mkdirSync(join(dir, "lead"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ws = openWorkspace(dir, {});
const ld = lead(ws);
// the rows a hook's wake left for later (stopped.ts), read as the file holds them
const staleFile = () => join(ws.runDir, `stale-${ld.name}.json`);
const staleIds = (): string[] => (existsSync(staleFile()) ? (JSON.parse(readFileSync(staleFile(), "utf8")) as string[]) : []);
const forgetAll = () => (forgetStopped(ws, ld.name), rmSync(staleFile(), { force: true }));

// A transport whose listing is `sessions`; whatever it starts or respawns comes up alive.
function fake(sessions: Session[], opts: { startFails?: boolean; stopFails?: boolean; stopBug?: boolean; neverUp?: boolean; deadRow?: number; launchId?: string } = {}) {
  const started: { cwd: string; prompt: string; args: string[]; appendix: string | null; runDir: string }[] = [];
  const respawned: string[] = [];
  const removed: string[] = [];
  const t: Transport = {
    where: "here",
    sessions: (all = false) => sessions.filter((s) => all || s.alive),
    sessionsAsync: () => assert.fail("not used"),
    alive: (s): s is Session => !!s && s.alive === true,
    start(req: StartRequest) {
      if (opts.startFails) throw new Error("claude --bg failed: no such session");
      started.push({ cwd: req.cwd, prompt: req.prompt, args: req.args(req.appendix ? "/run/appendix.md" : null), appendix: req.appendix, runDir: req.runDir });
      if (!opts.neverUp) sessions.push({ id: "new1", name: ld.name, kind: "background", alive: true });
      // a launch that dies at once: the listing keeps its row, started now, never alive
      else if (opts.deadRow) sessions.push({ id: "new1", name: ld.name, kind: "background", state: "failed", startedAt: opts.deadRow });
      return opts.launchId ?? "new1";
    },
    respawn(_name, id) {
      respawned.push(id);
      sessions.push({ id, name: ld.name, kind: "background", alive: true });
      return { ok: true, said: "respawned", why: "" };
    },
    stop(_name, id, remove) {
      assert.equal(remove, true);
      if (opts.stopBug) throw new TypeError("a bug in stop");
      if (opts.stopFails) throw new FactoryError("systemd-run made no scope for claude stop: Failed to connect to bus: No such file or directory");
      removed.push(id);
    },
    worktree: () => assert.fail("not used"),
    worktreeLeft: () => assert.fail("not used"),
    removeWorktree: () => assert.fail("not used"),
    checkout: () => assert.fail("not used"),
  };
  return { t, started, respawned, removed };
}

const UUID = "d1079ed1-114a-4030-9dd1-ff8036f527cc";
const stopped = (extra: Partial<Session> = {}): Session => ({ id: "d1079ed1", name: ld.name, kind: "background", state: "stopped", cwd: "/x/lead", sessionId: UUID, ...extra });

test("a stopped lead is resumed with a first turn that arms the message page inbox", () => {
  const { t, started, respawned, removed } = fake([stopped()]);
  const said: string[] = [];
  bringUpLead(ws, ld, t, false, (l) => said.push(l), 1);
  assert.deepEqual(respawned, [], "no respawn: it takes no prompt, so the Stop hook would never fire");
  assert.equal(started.length, 1);
  const [s] = started;
  assert.equal(s!.cwd, "/x/lead", "resumed where the conversation was");
  assert.equal(s!.prompt, resumePrompt(ws));
  assert.match(s!.prompt, /Monitor with command `.* board --inbox`/);
  const i = s!.args.indexOf("--resume");
  assert.deepEqual(s!.args.slice(i, i + 3), ["--resume", UUID, s!.prompt], "the session id, then the prompt last");
  assert.equal(s!.args[0], "--bg");
  assert.ok(s!.args.includes("--name") && s!.args.includes("--settings"), "the lead's own flags, as at launch");
  assert.deepEqual(removed, ["d1079ed1"], "the old entry, which the resume copied, is taken off the list");
  assert.deepEqual(said, [`${ld.name} resumed from ${UUID} as new1, told to arm the message page inbox`]);
});

test("a resumed lead is up even when taking the old entry off the list fails", () => {
  const { t, respawned, removed } = fake([stopped()], { stopFails: true });
  const said: string[] = [];
  bringUpLead(ws, ld, t, false, (l) => said.push(l), 1);
  assert.deepEqual(respawned, [], "no respawn: the resume worked");
  assert.deepEqual(removed, []);
  assert.deepEqual(said, [
    "the old d1079ed1 stays listed: systemd-run made no scope for claude stop: Failed to connect to bus: No such file or directory",
    `${ld.name} resumed from ${UUID} as new1, told to arm the message page inbox`,
  ]);
  assert.throws(() => bringUpLead(ws, ld, fake([stopped()], { stopBug: true }).t, false, () => {}, 1), TypeError, "a bug in stop is no die: it throws");
});

test("a resume that fails falls back to respawn, as before", () => {
  const { t, respawned } = fake([stopped()], { startFails: true });
  const said: string[] = [];
  bringUpLead(ws, ld, t, false, (l) => said.push(l), 1);
  assert.deepEqual(respawned, ["d1079ed1"]);
  assert.match(said[0]!, /^resuming .* failed \(claude --bg failed: no such session\); respawning instead$/);
  assert.equal(said[1], `${ld.name} respawned from d1079ed1: respawned`);
});

// The respawn reruns the old command line, whose --settings is this file: rendered again first, a lead
// stopped before an upgrade comes back with the current hooks (CodeRabbit on #124).
test("a lead respawned here comes back with its settings rendered again", () => {
  const file = settingsFile(ws, ld);
  writeFileSync(file, "{}\n");
  const { t, respawned } = fake([stopped()], { startFails: true });
  bringUpLead(ws, ld, t, false, () => {}, 1);
  assert.deepEqual(respawned, ["d1079ed1"]);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).hooks?.PreToolUse?.length, "the stale file was rendered again");
});

// A role whose template is gone must not keep the lead down: it comes back on the settings last
// rendered, and the failure is said (CodeRabbit on #127).
test("a lead whose settings cannot be rendered is respawned anyway, and the failure said loudly", () => {
  const w = openWorkspace(dir, {});
  const role = w.config.roles[lead(w).role] as { settings: string };
  role.settings = join(dir, "gone.json");
  const { t, respawned } = fake([stopped()], { startFails: true });
  const said: string[] = [];
  bringUpLead(w, lead(w), t, false, (l) => said.push(l), 1);
  assert.deepEqual(respawned, ["d1079ed1"]);
  assert.ok(said.some((l) => /^WARNING: .*settings could not be rendered .*gone\.json/.test(l)), said.join("\n"));
});

test("a listing with no session id, or a lead on another host, is respawned", () => {
  const a = fake([stopped({ sessionId: undefined })]);
  bringUpLead(ws, ld, a.t, false, () => {}, 1);
  assert.deepEqual([a.respawned, a.started.length], [["d1079ed1"], 0]);
  const b = fake([stopped()]);
  bringUpLead(ws, { ...ld, host: "far" }, b.t, false, () => {}, 1);
  assert.deepEqual([b.respawned, b.started.length], [["d1079ed1"], 0]);
});

test("a running lead is left alone, and --fresh starts a new one with the lead prompt", () => {
  const run = fake([{ id: "live1", name: ld.name, kind: "background", alive: true }]);
  const said: string[] = [];
  bringUpLead(ws, ld, run.t, false, (l) => said.push(l), 1);
  assert.deepEqual([run.started.length, run.respawned, said], [0, [], [`${ld.name} already running (live1)`]]);
  const f = fake([stopped()]);
  bringUpLead(ws, ld, f.t, true, () => {}, 1);
  assert.deepEqual(f.respawned, []);
  assert.equal(f.started[0]!.prompt, leadPrompt(ws));
  assert.ok(!f.started[0]!.args.includes("--resume"));
});

// ada with a brief: in a workspace of her own, so the others keep a lead without one.
function briefed(brief: string | null) {
  const d = tempWorkspace(TOML.replace('name = "ada"\nrole = "lead"', 'name = "ada"\nrole = "lead"\nappendix = ["briefs/ada.md"]'));
  after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, "briefs"));
  if (brief !== null) writeFileSync(join(d, "briefs", "ada.md"), brief);
  const w = openWorkspace(d, {});
  return { w, ld: lead(w) };
}
const ADA = "<!-- briefs/ada.md -->\nada's brief\n";

// runDir is where the appendix file goes, so a respawn after a reboot still finds it.
test("a lead gets its appendix, in the run dir, whether it is resumed or started fresh", () => {
  const { w, ld: a } = briefed("ada's brief\n");
  const r = fake([stopped({ name: a.name })]);
  bringUpLead(w, a, r.t, false, () => {}, 1);
  assert.equal(r.started[0]!.appendix, ADA);
  assert.equal(r.started[0]!.runDir, w.runDir);
  const args = r.started[0]!.args;
  assert.ok(args.indexOf("--append-system-prompt-file") >= 0 && args.indexOf("--append-system-prompt-file") < args.indexOf("--resume"), args.join(" "));
  const f = fake([]);
  bringUpLead(w, a, f.t, true, () => {}, 1);
  assert.equal(f.started[0]!.appendix, ADA);
  assert.equal(f.started[0]!.runDir, w.runDir);
});

test("a lead whose brief is missing is refused before anything is resumed, respawned or started", () => {
  const { w, ld: a } = briefed(null);
  const r = fake([stopped({ name: a.name })]);
  assert.throws(() => bringUpLead(w, a, r.t, false, () => {}, 1), /appendix file .*ada\.md is missing or empty/);
  assert.deepEqual([r.started, r.respawned, r.removed], [[], [], []]);
});

// Niilo, 2026-11-18: restart-lead resumes the conversation it just stopped, by its id. The newest
// row by the listing's clues can be an older thread, here one whose transcript was touched last.
test("restart-lead resumes the lead it stopped, by id, and refuses when that row is gone", () => {
  const today = stopped({ id: "5e7a0b12", sessionId: "today-uuid", startedAt: 2000 });
  const older = stopped({ id: "91c86061", sessionId: "older-uuid", startedAt: 1000, activeAt: 9000 });
  try {
    noteStopped(ws, ld.name, today);
    const { t, started, respawned, removed } = fake([older, today]);
    bringUpLead(ws, ld, t, false, () => {}, 1);
    assert.deepEqual(respawned, []);
    const args = started[0]!.args;
    assert.equal(args[args.indexOf("--resume") + 1], "today-uuid", "the conversation stopped last, not the older thread");
    assert.deepEqual(removed, ["5e7a0b12"], "the row the resume replaced goes, so stopped rows do not build up (Marie on #130)");
    assert.equal(lastStopped(ws, ld.name), null);

    noteStopped(ws, ld.name, stopped({ id: "aa11bb22" }));
    const gone = fake([older]);
    assert.throws(() => bringUpLead(ws, ld, gone.t, false, () => {}, 1),
      /ada's last stopped session aa11bb22 is no longer listed, and an older one is another conversation\. `factory up --fresh` starts a new one/);
    assert.deepEqual([gone.started, gone.respawned], [[], []], "neither the older thread nor a fresh one");

    // a lead launched since the stop, from another box whose run dir has no record: the record is
    // stale, and the newest row is the conversation (Marie on #130)
    noteStopped(ws, ld.name, stopped({ id: "aa11bb22", startedAt: 1000 }));
    const later = stopped({ id: "c0ffee00", sessionId: "later-uuid", startedAt: Date.now() + 60_000 });
    const other = fake([stopped({ id: "aa11bb22", sessionId: "stale-uuid", startedAt: 1000 }), later]);
    bringUpLead(ws, ld, other.t, false, () => {}, 1);
    const a2 = other.started[0]!.args;
    assert.equal(a2[a2.indexOf("--resume") + 1], "later-uuid", "the conversation launched since, not the stale record's");
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a resume that never comes back keeps the stop record for the next try (CodeRabbit on #130)", () => {
  const today = stopped({ id: "5e7a0b12", sessionId: "today-uuid", startedAt: 2000 });
  try {
    noteStopped(ws, ld.name, today);
    const f = fake([today], { neverUp: true });
    bringUpLead(ws, ld, f.t, false, () => {}, 0.01);
    assert.deepEqual(f.respawned, ["5e7a0b12"], "fell back to respawning it");
    assert.equal(lastStopped(ws, ld.name)?.id, "5e7a0b12");
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a launch that never comes up keeps the stopped row and its record (CodeRabbit on #130)", () => {
  const today = stopped({ id: "5e7a0b12", sessionId: "today-uuid" });
  try {
    noteStopped(ws, ld.name, today);
    const f = fake([today], { neverUp: true });
    // waitForName's 90s pass at once
    let now = Date.now();
    const m = mock.method(Date, "now", () => (now += 100_000));
    try {
      assert.throws(() => launch(ws, ld, join(dir, "lead"), "hi", null, undefined, f.t), /did not appear in `claude agents`/);
    } finally {
      m.mock.restore();
    }
    assert.deepEqual(f.removed, [], "the stopped row stays, the only way back");
    assert.equal(lastStopped(ws, ld.name)?.id, "5e7a0b12");
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a launch that never comes up does not make its row the one a wake resumes (CodeRabbit on #130 at fcf9403e)", () => {
  const today = stopped({ id: "5e7a0b12", sessionId: "today-uuid", startedAt: Date.now() - 3_600_000 });
  try {
    noteStopped(ws, ld.name, today);
    const rows: Session[] = [today];
    const f = fake(rows, { neverUp: true, deadRow: Date.now() + 1000 });
    let now = Date.now();
    const m = mock.method(Date, "now", () => (now += 100_000));
    try {
      assert.throws(() => launch(ws, ld, join(dir, "lead"), "hi", null, undefined, f.t), /did not appear in `claude agents`/);
    } finally {
      m.mock.restore();
    }
    assert.ok(rows.some((r) => r.id === "new1"), "the failed launch's row is listed, started after the stop");
    const newest = (r: Session[]) => r.reduce<Session | null>((a, b) => (!a || Number(b.startedAt) > Number(a.startedAt) ? b : a), null);
    const which = resumable(ws, ld.name, rows, newest);
    assert.ok("s" in which && which.s?.id === "5e7a0b12", `a wake resumes the session stopped last, not the launch that failed: ${JSON.stringify(which)}`);
    // a conversation that did come up since still supersedes the record
    rows.push({ id: "c0ffee00", name: ld.name, kind: "background", state: "stopped", startedAt: Date.now() + 5000 });
    const later = resumable(ws, ld.name, rows, newest);
    assert.ok("s" in later && later.s?.id === "c0ffee00", JSON.stringify(later));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

// Marie's gate on #130 at 5e10c7e0
const record = (st: { id: string; at: string; failed?: string[] }) => {
  mkdirSync(ws.runDir, { recursive: true });
  writeFileSync(join(ws.runDir, `stopped-${ld.name}.json`), JSON.stringify(st));
};
const failNow = (rows: Session[], deadRow: number, launchId?: string) => {
  const f = fake(rows, { neverUp: true, deadRow, ...(launchId ? { launchId } : {}) });
  let now = Date.now();
  const m = mock.method(Date, "now", () => (now += 100_000));
  try {
    assert.throws(() => launch(ws, ld, join(dir, "lead"), "hi", null, undefined, f.t), /did not appear in `claude agents`/);
  } finally {
    m.mock.restore();
  }
  return f;
};

test("up picks among the rows resumable filtered, not the whole listing (Marie on #130 at 5e10c7e0)", () => {
  const t0 = Date.now();
  try {
    record({ id: "old1", at: new Date(t0 - 3_600_000).toISOString(), failed: ["new1"] });
    const rows: Session[] = [
      { id: "old1", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 },
      { id: "box2", name: ld.name, kind: "background", state: "done", startedAt: t0 - 1_800_000 },
      { id: "new1", name: ld.name, kind: "background", state: "failed", startedAt: t0 - 60_000 },
    ];
    const f = fake(rows);
    bringUpLead(ws, ld, f.t, false, () => {}, 1);
    assert.deepEqual(f.respawned, ["box2"], "the conversation started after the stop, not the launch that failed");
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a failed launch that comes up later is no longer passed over (Marie on #130 at 5e10c7e0)", () => {
  for (const seenLive of [true, false]) {
    const today = stopped({ id: "5e7a0b12", sessionId: undefined, startedAt: Date.now() - 3_600_000 });
    try {
      noteStopped(ws, ld.name, today);
      const rows: Session[] = [today];
      failNow(rows, Date.now() + 1000);
      assert.deepEqual(lastStopped(ws, ld.name)?.failed, ["new1"]);
      const row = rows.find((r) => r.id === "new1") as Session;
      const f = fake(rows);
      if (seenLive) {
        // it comes up: a wake finds it live, and it replaces the record as a launch that came up does
        Object.assign(row, { alive: true, state: "idle" });
        assert.equal(wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 }).is, "live");
        assert.equal(lastStopped(ws, ld.name), null, `seen live, the record is replaced`);
      }
      // it ends on its own: a wake resumes it, the newer conversation
      Object.assign(row, { alive: false, state: "done" });
      const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
      assert.deepEqual(f.respawned, ["new1"], `seenLive=${seenLive}: ${JSON.stringify(w)}`);
    } finally {
      forgetStopped(ws, ld.name);
    }
  }
});

test("a failed launch's rows are told by the listing, not by this host's clock (Marie on #130 at 5e10c7e0)", () => {
  const today = stopped({ id: "5e7a0b12", startedAt: Date.now() - 7_200_000 });
  try {
    noteStopped(ws, ld.name, today);
    // its id is not known ("?"), and the host's clock is behind this one: the row's startedAt is
    // after the stop and before the launch began here
    const rows: Session[] = [today];
    const at = Date.parse(lastStopped(ws, ld.name)?.at as string);
    failNow(rows, at + 1000, "?");
    assert.deepEqual(lastStopped(ws, ld.name)?.failed, ["new1"]);
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("with no stop record, a failed launch is still not the one resumed (Marie on #130 at 5e10c7e0)", () => {
  const old = stopped({ id: "old1", sessionId: undefined, state: "done", startedAt: Date.now() - 3_600_000 });
  try {
    forgetStopped(ws, ld.name);
    const rows: Session[] = [old];
    failNow(rows, Date.now() + 1000);
    assert.deepEqual(lastStopped(ws, ld.name), { id: "old1", at: lastStopped(ws, ld.name)?.at, failed: ["new1"] });
    const f = fake(rows);
    wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["old1"]);
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a note that cannot be written leaves die's launch id message (Marie on #130 at 5e10c7e0)", () => {
  const old = stopped({ id: "old1", startedAt: Date.now() - 3_600_000 });
  const f = join(ws.runDir, `stopped-${ld.name}.json`);
  mkdirSync(f, { recursive: true });
  const err = mock.method(console, "error", () => {});
  try {
    failNow([old], Date.now() + 1000);
  } finally {
    err.mock.restore();
    rmSync(f, { recursive: true, force: true });
  }
});

test("a failed launch's row that has shown nothing keeps its mark (Marie on #130 at 24691398)", () => {
  for (const shown of [{ state: "working" }, {}] as Partial<Session>[]) {
    const today = stopped({ id: "5e7a0b12", sessionId: undefined, startedAt: Date.now() - 3_600_000 });
    try {
      noteStopped(ws, ld.name, today);
      const rows: Session[] = [today];
      failNow(rows, Date.now() + 1000);
      const row = rows.find((r) => r.id === "new1") as Session;
      // still listed "working" with no pid after the launch gave up, or with no state at all
      delete row.state;
      Object.assign(row, shown, { pid: null });
      const f = fake(rows);
      const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
      assert.deepEqual(f.respawned, ["5e7a0b12"], `${JSON.stringify(shown)}: ${JSON.stringify(w)}`);
    } finally {
      forgetStopped(ws, ld.name);
    }
  }
});

test("a marked launch that ran is the newer conversation, whatever its host's clock (CodeRabbit on #130 at 43510c94)", () => {
  const today = stopped({ id: "5e7a0b12", sessionId: undefined, startedAt: Date.now() - 7_200_000 });
  try {
    noteStopped(ws, ld.name, today);
    const rows: Session[] = [today];
    // the host's clock is behind: the row's startedAt is before the stop recorded here
    failNow(rows, Date.parse(lastStopped(ws, ld.name)?.at as string) - 60_000);
    assert.deepEqual(lastStopped(ws, ld.name)?.failed, ["new1"]);
    Object.assign(rows.find((r) => r.id === "new1") as Session, { state: "done" });
    const f = fake(rows);
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1"], JSON.stringify(w));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a marked launch that ran is not marked again on a later wake (CodeRabbit on #130 at 43510c94)", () => {
  const today = stopped({ id: "5e7a0b12", sessionId: undefined, startedAt: Date.now() - 3_600_000 });
  try {
    noteStopped(ws, ld.name, today);
    const rows: Session[] = [today];
    failNow(rows, Date.now() + 1000);
    const row = rows.find((r) => r.id === "new1") as Session;
    Object.assign(row, { state: "done" });
    const f = fake(rows);
    wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1"]);
    assert.equal(lastStopped(ws, ld.name), null, "the record is replaced, as for a launch seen live");
    assert.deepEqual(f.removed, ["5e7a0b12"], "the stopped row it superseded goes");
    // the respawn ends, and the row is listed "working" with no pid again
    rows.splice(rows.findIndex((r) => r.id === "new1" && r.alive), 1);
    Object.assign(row, { state: "working", pid: null });
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1", "new1"], JSON.stringify(w));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a marked launch that ran is resumed even when its row sorts before the stopped one (CodeRabbit on #130 at 85389fcf)", () => {
  const t0 = Date.now();
  try {
    record({ id: "old1", at: new Date(t0 - 60_000).toISOString(), failed: ["new1"] });
    const rows: Session[] = [
      { id: "old1", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 3_600_000 },
      // the host's clock was set back since: the launch's row sorts before the stopped one
      { id: "new1", name: ld.name, kind: "background", state: "done", startedAt: t0 - 7_200_000 },
    ];
    const f = fake(rows);
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1"], JSON.stringify(w));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a marked launch that ran leaves the other marks in place (CodeRabbit on #130 at 85389fcf)", () => {
  const t0 = Date.now();
  try {
    record({ id: "old1", at: new Date(t0 - 3_600_000).toISOString(), failed: ["new1", "new2"] });
    const ran: Session = { id: "new1", name: ld.name, kind: "background", state: "done", startedAt: t0 - 1_800_000 };
    const rows: Session[] = [
      { id: "old1", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 },
      ran,
      { id: "new2", name: ld.name, kind: "background", state: "failed", startedAt: t0 - 60_000 },
    ];
    const f = fake(rows);
    wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1"]);
    assert.deepEqual(lastStopped(ws, ld.name)?.failed, ["new2"], "the launch that never came up stays marked");
    // the respawn ends, and its row is listed "working" with no pid again
    rows.splice(rows.findIndex((r) => r.id === "new1" && r.alive), 1);
    Object.assign(ran, { state: "working", pid: null });
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1", "new1"], JSON.stringify(w));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a wake that resumes nothing leaves the record and the stopped row (Marie on #130 at 85389fcf)", () => {
  const t0 = Date.now();
  try {
    record({ id: "old1", at: new Date(t0 - 3_600_000).toISOString(), failed: ["new1"] });
    const rows: Session[] = [
      { id: "old1", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 },
      { id: "new1", name: ld.name, kind: "background", state: "done", startedAt: t0 - 1_800_000 },
    ];
    const f = fake(rows);
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10, match: () => false });
    assert.equal(w.is, "none");
    assert.deepEqual(f.respawned, []);
    assert.deepEqual(f.removed, [], "the stopped row stays");
    assert.deepEqual(lastStopped(ws, ld.name)?.failed, ["new1"], "the record stays");
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a lead resumed under a new id keeps the marks of launches that never came up (CodeRabbit on #130 at 7a20b268)", () => {
  const t0 = Date.now();
  try {
    // a launch that ran has replaced the stopped session; another never came up, and sorts newest
    record({ id: "ran1", at: new Date(t0 - 60_000).toISOString(), failed: ["dead2"] });
    const rows: Session[] = [
      stopped({ id: "ran1", sessionId: UUID, startedAt: t0 - 1_800_000 }),
      { id: "dead2", name: ld.name, kind: "background", state: "failed", startedAt: t0 + 3_600_000 },
    ];
    const f = fake(rows);
    bringUpLead(ws, ld, f.t, false, () => {}, 1);
    assert.equal(f.started.length, 1, "resumed by its conversation id");
    assert.deepEqual(lastStopped(ws, ld.name)?.failed, ["dead2"], "the mark stays, on the new id");
    // the resumed lead ends; a wake resumes it, not the launch that never came up
    Object.assign(rows.find((r) => r.id === "new1") as Session, { alive: false, state: "done", startedAt: t0 });
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1"], JSON.stringify(w));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a fresh launch that comes up keeps the marks of launches that never did (CodeRabbit on #130 at 2e89a7a4)", () => {
  const t0 = Date.now();
  try {
    record({ id: "old1", at: new Date(t0 - 3_600_000).toISOString(), failed: ["dead2"] });
    const rows: Session[] = [
      { id: "old1", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 },
      // its host's clock is ahead: it sorts newest of all
      { id: "dead2", name: ld.name, kind: "background", state: "failed", startedAt: t0 + 3_600_000 },
    ];
    const f = fake(rows);
    launch(ws, ld, join(dir, "lead"), "hi", null, undefined, f.t);
    assert.deepEqual(lastStopped(ws, ld.name), { id: "new1", at: lastStopped(ws, ld.name)?.at, failed: ["dead2"] });
    assert.deepEqual(f.removed, ["old1"], "the stopped row it replaces goes");
    // the new conversation ends; a wake resumes it, not the launch that never came up
    Object.assign(rows.find((r) => r.id === "new1") as Session, { alive: false, state: "done", startedAt: t0 });
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["new1"], JSON.stringify(w));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

test("a launch that ran and comes back under a new id takes the record, marks and all (Marie on #130 at 2e89a7a4)", () => {
  const t0 = Date.now();
  try {
    record({ id: "old1", at: new Date(t0 - 3_600_000).toISOString(), failed: ["runA", "deadB"] });
    const rows: Session[] = [
      { id: "old1", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 },
      { id: "runA", name: ld.name, kind: "background", state: "done", startedAt: t0 - 1_800_000 },
      { id: "deadB", name: ld.name, kind: "background", state: "failed", startedAt: t0 - 60_000 },
    ];
    const f = fake(rows);
    // claude brings runA back as runA2
    f.t.respawn = (_name, id) => {
      f.respawned.push(id);
      rows.push({ id: `${id}2`, name: ld.name, kind: "background", alive: true, startedAt: t0 });
      return { ok: true, said: "respawned", why: "" };
    };
    assert.equal(wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 }).is, "woke");
    assert.deepEqual(lastStopped(ws, ld.name), { id: "runA2", at: lastStopped(ws, ld.name)?.at, failed: ["deadB"] });
    // runA2 ends; the next wake resumes it, not runA nor deadB
    Object.assign(rows.find((r) => r.id === "runA2") as Session, { alive: false, state: "done" });
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual(f.respawned, ["runA", "runA2"], JSON.stringify(w));
  } finally {
    forgetStopped(ws, ld.name);
  }
});

// Marie on #130 at f62a6b10: a respawn that came back under a new id left the old row listed,
// stopped, and such rows piled up.
for (const via of ["wake", "up"] as const)
  test(`a respawn by ${via} that comes back under a new id takes the old row off the list`, () => {
    const t0 = Date.now();
    try {
      record({ id: "runA", at: new Date(t0 - 3_600_000).toISOString() });
      const rows: Session[] = [{ id: "runA", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 }];
      const f = fake(rows);
      f.t.respawn = (_name, id) => {
        f.respawned.push(id);
        rows.push({ id: `${id}2`, name: ld.name, kind: "background", alive: true, startedAt: t0 });
        return { ok: true, said: "respawned", why: "" };
      };
      if (via === "wake") assert.equal(wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 }).is, "woke");
      else bringUpLead(ws, ld, f.t, false, () => {}, 1);
      assert.deepEqual(f.respawned, ["runA"]);
      assert.deepEqual(f.removed, ["runA"]);
    } finally {
      forgetStopped(ws, ld.name);
    }
  });

// CodeRabbit on #130 at d1c64cc6: the cleanup after a wake's respawn listed and stopped with no
// regard for the deadline. Short of time for both, the record still moves; the old row waits.
for (const leftS of [30, 120])
test(`a wake with a deadline ${leftS} s off starts no listing or stop after its respawn, and still moves the record`, () => {
  const t0 = Date.now();
  try {
    record({ id: "runA", at: new Date(t0 - 3_600_000).toISOString(), failed: ["deadB"] });
    const rows: Session[] = [
      { id: "runA", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 },
      { id: "deadB", name: ld.name, kind: "background", state: "failed", startedAt: t0 + 7_200_000 },
    ];
    const f = fake(rows);
    let after = 0;
    let respawnedYet = false;
    const list = f.t.sessions;
    f.t.sessions = (all) => {
      if (respawnedYet && all) after++;
      return list(all);
    };
    f.t.respawn = (_name, id) => {
      f.respawned.push(id);
      respawnedYet = true;
      rows.push({ id: `${id}2`, name: ld.name, kind: "background", alive: true, startedAt: t0 });
      return { ok: true, said: "respawned", why: "" };
    };
    // 30 s: time for the listing and the respawn only. 120 s: time for a cleanup listing too, but a
    // stop after it has no bound, so none starts either way (CodeRabbit on #130 at b77aae5c).
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10, deadline: Date.now() + leftS * 1000 });
    assert.equal(w.is, "woke", JSON.stringify(w));
    assert.equal(after, 0, "no full listing after the respawn");
    assert.deepEqual(f.removed, [], "no stop: the old row waits for a later step");
    assert.deepEqual(lastStopped(ws, ld.name), { id: "runA2", at: lastStopped(ws, ld.name)?.at, failed: ["deadB"] });
  } finally {
    forgetAll();
  }
});

test("a listing that fails or comes back empty keeps the rows a hook's wake left", () => {
  try {
    mkdirSync(ws.runDir, { recursive: true });
    writeFileSync(staleFile(), JSON.stringify(["oldA"]) + "\n");
    const rows: Session[] = [{ id: "liveB", name: ld.name, kind: "background", alive: true }];
    const f = fake(rows);
    const list = f.t.sessions;
    for (const all of [() => assert.fail("listing timed out"), () => []] as (() => Session[])[]) {
      f.t.sessions = (wantAll) => (wantAll ? all() : list(false));
      const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
      assert.equal(w.is, "live", JSON.stringify(w));
      assert.deepEqual(f.removed, []);
      assert.deepEqual(staleIds(), ["oldA"]);
    }
  } finally {
    forgetAll();
  }
});

test("a row a deadline wake left goes at the next wake with no deadline, and is never a candidate", () => {
  const t0 = Date.now();
  try {
    record({ id: "runA", at: new Date(t0 - 3_600_000).toISOString() });
    const rows: Session[] = [{ id: "runA", name: ld.name, kind: "background", state: "stopped", startedAt: t0 - 7_200_000 }];
    const f = fake(rows);
    f.t.respawn = (_name, id) => {
      f.respawned.push(id);
      rows.push({ id: `${id}2`, name: ld.name, kind: "background", alive: true, startedAt: t0 });
      return { ok: true, said: "respawned", why: "" };
    };
    const w = wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10, deadline: Date.now() + 120_000 });
    assert.equal(w.is, "woke", JSON.stringify(w));
    assert.deepEqual(f.removed, [], "the hook's wake stops nothing");
    assert.deepEqual(staleIds(), ["runA"], "the old row is noted for later");
    // runA2 ends: the next hook wake resumes runA2, never the stale runA (Niilo on #130 at c2ef44e3)
    const a2 = rows.find((r) => r.id === "runA2");
    if (a2) Object.assign(a2, { alive: false, state: "stopped" });
    f.respawned.length = 0;
    wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10, deadline: Date.now() + 120_000 });
    assert.ok(!f.respawned.includes("runA"), `stale runA respawned: ${JSON.stringify(f.respawned)}`);
    // a CLI wake, with no deadline, stops and removes the old row
    wake(ws, ld, { t: f.t, waitS: 1, pollMs: 10 });
    assert.deepEqual([...f.removed].sort(), ["runA", "runA2"], "both rows the hook's wakes left");
    assert.deepEqual(staleIds(), [], "the noted id is cleared once removed");
  } finally {
    forgetAll();
  }
});
