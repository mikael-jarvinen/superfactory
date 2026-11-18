import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Session } from "../src/fleet.js";
import { lead } from "../src/fleet.js";
import { leadPrompt, settingsFile } from "../src/launch.js";
import { bringUpLead, resumePrompt } from "../src/lead-up.js";
import type { StartRequest, Transport } from "../src/transport.js";
import { FactoryError } from "../src/util.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace } from "./helpers.js";

const dir = tempWorkspace();
mkdirSync(join(dir, "lead"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ws = openWorkspace(dir, {});
const ld = lead(ws);

// A transport whose listing is `sessions`; whatever it starts or respawns comes up alive.
function fake(sessions: Session[], opts: { startFails?: boolean; stopFails?: boolean; stopBug?: boolean } = {}) {
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
      sessions.push({ id: "new1", name: ld.name, kind: "background", alive: true });
      return "new1";
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
