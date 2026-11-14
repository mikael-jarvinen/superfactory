import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Session } from "../src/fleet.js";
import { lead } from "../src/fleet.js";
import { leadPrompt } from "../src/launch.js";
import { bringUpLead, resumePrompt } from "../src/lead-up.js";
import type { StartRequest, Transport } from "../src/transport.js";
import { openWorkspace } from "../src/workspace.js";
import { tempWorkspace } from "./helpers.js";

const dir = tempWorkspace();
mkdirSync(join(dir, "lead"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ws = openWorkspace(dir, {});
const ld = lead(ws);

// A transport whose listing is `sessions`; whatever it starts or respawns comes up alive.
function fake(sessions: Session[], opts: { startFails?: boolean } = {}) {
  const started: { cwd: string; prompt: string; args: string[] }[] = [];
  const respawned: string[] = [];
  const removed: string[] = [];
  const t: Transport = {
    where: "here",
    sessions: (all = false) => sessions.filter((s) => all || s.alive),
    sessionsAsync: () => assert.fail("not used"),
    alive: (s): s is Session => !!s && s.alive === true,
    start(req: StartRequest) {
      if (opts.startFails) throw new Error("claude --bg failed: no such session");
      started.push({ cwd: req.cwd, prompt: req.prompt, args: req.args(null) });
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

test("a resume that fails falls back to respawn, as before", () => {
  const { t, respawned } = fake([stopped()], { startFails: true });
  const said: string[] = [];
  bringUpLead(ws, ld, t, false, (l) => said.push(l), 1);
  assert.deepEqual(respawned, ["d1079ed1"]);
  assert.match(said[0]!, /^resuming .* failed \(claude --bg failed: no such session\); respawning instead$/);
  assert.equal(said[1], `${ld.name} respawned from d1079ed1: respawned`);
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
