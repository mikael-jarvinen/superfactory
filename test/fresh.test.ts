// Every start is a fresh session, with the role's prompt and the config's model and effort now: an
// old conversation is never resumed.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Session } from "../src/fleet.js";
import { agentOrDie, lead } from "../src/fleet.js";
import { buildingPrompt, fixingPrompt, handoffPath, leadPrompt } from "../src/launch.js";
import { bringUpLead } from "../src/lead-up.js";
import { clearEnded, freshCommand } from "../src/stopped.js";
import type { StartRequest, Transport } from "../src/transport.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace } from "./helpers.js";

const dir = tempWorkspace();
mkdirSync(join(dir, "lead"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ws = openWorkspace(dir, {});
const ld = lead(ws);

// A transport whose listing is `sessions`; whatever it starts comes up alive as new1.
function fake(sessions: Session[]) {
  const started: { cwd: string; prompt: string; args: string[] }[] = [];
  const stopped: string[] = [];
  const t: Transport = {
    where: "here",
    sessions: (all = false) => sessions.filter((s) => all || s.alive),
    sessionsAsync: () => assert.fail("not used"),
    alive: (s): s is Session => !!s && s.alive === true,
    start(req: StartRequest) {
      started.push({ cwd: req.cwd, prompt: req.prompt, args: req.args(req.appendix ? "/run/appendix.md" : null) });
      sessions.push({ id: "new1", name: req.agent.name, kind: "background", alive: true });
      return "new1";
    },
    stop(_name, id, remove) {
      assert.equal(remove, true);
      stopped.push(id);
    },
    worktree: () => assert.fail("not used"),
    worktreeLeft: () => assert.fail("not used"),
    removeWorktree: () => assert.fail("not used"),
    checkout: () => assert.fail("not used"),
  };
  return { t, started, stopped };
}

test("factory up starts a lead that is off as a fresh session, and the ended rows go once it is up", () => {
  const { t, started, stopped } = fake([{ id: "old1", name: ld.name, kind: "background", state: "stopped", sessionId: "u-1" }]);
  const out: string[] = [];
  bringUpLead(ws, ld, t, (l) => out.push(l));
  assert.equal(started.length, 1);
  assert.equal(started[0]!.cwd, join(dir, "lead"));
  assert.equal(started[0]!.prompt, leadPrompt(ws));
  const a = started[0]!.args;
  assert.equal(a[0], "--bg");
  assert.ok(!a.includes("--resume") && !a.includes("respawn"), a.join(" "));
  for (const [flag, v] of [["--model", "opus"], ["--effort", "high"], ["--autocompact", "1M"], ["--name", "ada"]] as const)
    assert.equal(a[a.indexOf(flag) + 1], v, flag);
  assert.equal(a.at(-1), leadPrompt(ws));
  assert.deepEqual(out, [`ada started (new1) in ${join(dir, "lead")} with Remote Control`]);
  assert.deepEqual(stopped, ["old1"], "the old conversation's row is removed, never resumed");
});

test("factory up leaves a running lead alone", () => {
  const { t, started, stopped } = fake([{ id: "l1", name: ld.name, kind: "background", alive: true }]);
  const out: string[] = [];
  bringUpLead(ws, ld, t, (l) => out.push(l));
  assert.deepEqual([started, stopped, out], [[], [], ["ada already running (l1)"]]);
});

test("the ended rows a start clears are the agent's own, never the live one or another's", () => {
  const { t, stopped } = fake([
    { id: "a0", name: "ada", kind: "background", state: "stopped" },
    { id: "a1", name: "ada", kind: "background", alive: true },
    { id: "b0", name: "bea", kind: "background", state: "stopped" },
    { id: "i0", name: "ada", kind: "interactive", state: "stopped" },
  ]);
  clearEnded("ada", t, "a1");
  assert.deepEqual(stopped, ["a0"]);
});

test("each role's way to start fresh is the command that starts it", () => {
  const cmd = (name: string, role: string) => freshCommand({ name, role } as Parameters<typeof freshCommand>[0]);
  assert.equal(cmd("ada", "lead"), "factory up");
  assert.equal(cmd("rae", "reviewer"), "factory review --name rae");
  assert.equal(cmd("winston", "assistant"), "factory assistant winston");
  assert.equal(cmd("bea", "builder"), "factory dispatch bea <KEY>");
  assert.equal(cmd("dora", "designer"), "factory dispatch dora <KEY>");
});

test("the build session is told where to write the handoff, and the fix round where to read it", () => {
  const w = openWorkspace(tempWorkspace(TOML), {});
  const bea = agentOrDie(w, "bea");
  const wt = "/w/repos/web/.claude/worktrees/TEST-1/";
  assert.equal(handoffPath(wt), "/w/repos/web/.claude/worktrees/TEST-1.handoff.md", "beside the worktree, never in it");
  const b = buildingPrompt(w, bea, "TEST-1", handoffPath(wt));
  assert.match(b, /When you open the PR, write the handoff for the fix round to \/w\/repos\/web\/\.claude\/worktrees\/TEST-1\.handoff\.md/);
  assert.doesNotMatch(buildingPrompt(w, bea, "TEST-1"), /handoff/);
  const f = fixingPrompt(w, bea, "TEST-1", handoffPath(wt));
  assert.match(f, /FIX ROUND, in a fresh session/);
  assert.match(f, /the handoff at \/w\/repos\/web\/\.claude\/worktrees\/TEST-1\.handoff\.md/);
  assert.match(f, /The review findings are not in it: they come by message, from the reviewer or Ada\. Reply exactly READY and wait for them/);
  assert.doesNotMatch(f, /holds what the build did and the review findings/);
});
