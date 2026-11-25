// As of Claude Code 2.1.327, --resume and respawn keep the system prompt a session started with and
// ignore any --append-system-prompt(-file) given then. So a brief edited since a session started
// reaches it only through the SessionStart hook (hooks/appendix.ts), from the agent's current
// appendix file, which every start writes and every resume and wake writes again first.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resumeProbe } from "../src/doctor.js";
import { agentOrDie, lead, type Session } from "../src/fleet.js";
import { hook, RESUMED_BRIEF_HEAD } from "../src/hooks/appendix.js";
import { currentAppendix, refreshHosted, settingsFile } from "../src/launch.js";
import { bringUpLead } from "../src/lead-up.js";
import { lastStopped, noteStopped } from "../src/stopped.js";
import { appendixFile, currentAppendixPath, type StartRequest, type Transport, writeCurrentAppendix } from "../src/transport.js";
import { wake } from "../src/wake.js";
import { worktreePath } from "../src/worktree.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempDir, tempWorkspace } from "./helpers.js";

const ASSISTANT = TOML.replace("[tracker]", `[roles.assistant]
cwd = "assistants"
model = "opus"
settings = "readonly"

[[agents]]
name = "vega"
role = "assistant"
appendix = ["briefs/vega.md"]

[tracker]`).replace('name = "ada"\nrole = "lead"', 'name = "ada"\nrole = "lead"\nappendix = ["briefs/ada.md"]');

function workspace(toml = ASSISTANT) {
  const dir = tempWorkspace(toml);
  mkdirSync(join(dir, "briefs"), { recursive: true });
  mkdirSync(join(dir, "lead"), { recursive: true });
  mkdirSync(join(dir, "assistants"), { recursive: true });
  writeFileSync(join(dir, "briefs", "vega.md"), "vega's brief, first\n");
  writeFileSync(join(dir, "briefs", "ada.md"), "ada's brief, first\n");
  writeFileSync(join(dir, "briefs", "app.md"), "the app brief\n");
  return { dir, ws: openWorkspace(dir, {}) };
}

const resumeEvent = (source = "resume") => JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "s1" });

test("the appendix hook hands a resumed session its current brief, and says nothing otherwise", () => {
  const d = tempDir();
  const file = join(d, "appendix-vega-current.md");
  writeFileSync(file, "the brief as it is now\n");
  const r = hook(["--file", file], resumeEvent());
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout ?? "");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, `${RESUMED_BRIEF_HEAD}\n\nthe brief as it is now\n`);
  // a fresh start already has it as its system prompt; no file is an agent with no brief
  assert.deepEqual(hook(["--file", file], resumeEvent("startup")), { code: 0 });
  assert.deepEqual(hook(["--file", join(d, "none.md")], resumeEvent()), { code: 0 });
  writeFileSync(file, "  \n");
  assert.deepEqual(hook(["--file", file], resumeEvent()), { code: 0 });
});

test("every role's settings run the appendix hook on a resume, with its own current file", () => {
  const { ws } = workspace();
  for (const name of ["ada", "bea", "rae", "vega"]) {
    const s = JSON.parse(readFileSync(settingsFile(ws, agentOrDie(ws, name)), "utf8"));
    const entries = (s.hooks.SessionStart ?? []).filter((e: { matcher?: string }) => e.matcher === "resume");
    assert.equal(entries.length, 1, `${name}: ${JSON.stringify(s.hooks.SessionStart)}`);
    assert.match(entries[0].hooks[0].command, new RegExp(` hook appendix --file ${currentAppendixPath(ws.runDir, name).replace(/[.]/g, "\\.")}$`), name);
  }
});

test("a start writes the agent's current appendix, and an agent with none has no file", () => {
  const d = tempDir();
  const p = appendixFile(d, "vega", "one\n");
  assert.notEqual(p, currentAppendixPath(d, "vega"));
  assert.equal(readFileSync(currentAppendixPath(d, "vega"), "utf8"), "one\n");
  appendixFile(d, "vega", "two\n");
  assert.equal(readFileSync(currentAppendixPath(d, "vega"), "utf8"), "two\n");
  writeCurrentAppendix(d, "vega", null);
  assert.ok(!existsSync(currentAppendixPath(d, "vega")));
});

const offVega = (respawned: { id: string; appendix: string | null | undefined }[], back: Partial<Session> = {}) => {
  let up = false;
  return {
    where: "here",
    sessions: (all = false) => (up ? [{ id: "v1", name: "vega", kind: "background", alive: true, ...back }] : all ? [{ id: "v1", name: "vega", kind: "background", cwd: "/x" }] : []),
    alive: (s: unknown) => !!s && (s as { alive?: unknown }).alive === true,
    respawn: (_n: string, id: string, _ms?: number, appendix?: string | null) => (respawned.push({ id, appendix }), (up = true), { ok: true, said: "back", why: "" }),
  } as unknown as Transport;
};

test("a wake writes the brief as it is now before it respawns, which the resumed session is handed", () => {
  const { dir, ws } = workspace();
  const vega = agentOrDie(ws, "vega");
  appendixFile(ws.runDir, "vega", "<!-- briefs/vega.md -->\nvega's brief, first\n");
  writeFileSync(join(dir, "briefs", "vega.md"), "vega's brief, edited since\n");
  const respawned: { id: string; appendix: string | null | undefined }[] = [];
  const w = wake(ws, vega, { t: offVega(respawned), deadline: Date.now() + 60_000, pollMs: 10 });
  assert.equal(w.is, "woke");
  assert.deepEqual(respawned, [{ id: "v1", appendix: undefined }], "a local respawn writes it here, and sends none");
  const now = readFileSync(currentAppendixPath(ws.runDir, "vega"), "utf8");
  assert.match(now, /vega's brief, edited since/);
  const ctx = JSON.parse(hook(["--file", currentAppendixPath(ws.runDir, "vega")], resumeEvent()).stdout ?? "").hookSpecificOutput.additionalContext;
  assert.match(ctx, /edited since/);
});

// The session still has the brief it started with: a message is not kept from it for this.
test("a wake whose brief cannot be read now still respawns, and the copy written last stays", () => {
  const { dir, ws } = workspace();
  appendixFile(ws.runDir, "vega", "the brief it started with\n");
  rmSync(join(dir, "briefs", "vega.md"));
  const respawned: { id: string; appendix: string | null | undefined }[] = [];
  const w = wake(ws, agentOrDie(ws, "vega"), { t: offVega(respawned), deadline: Date.now() + 60_000, pollMs: 10 });
  assert.equal(w.is, "woke");
  assert.deepEqual(respawned, [{ id: "v1", appendix: undefined }]);
  assert.equal(readFileSync(currentAppendixPath(ws.runDir, "vega"), "utf8"), "the brief it started with\n");
});

test("a hosted agent's wake sends its brief with the respawn, for the daemon to write there", () => {
  const { ws } = workspace();
  const vega = { ...agentOrDie(ws, "vega"), host: "far" };
  const respawned: { id: string; appendix: string | null | undefined }[] = [];
  wake(ws, vega, { t: offVega(respawned), deadline: Date.now() + 60_000, pollMs: 10 });
  assert.deepEqual(respawned, [{ id: "v1", appendix: "<!-- briefs/vega.md -->\nvega's brief, first\n" }]);
  assert.ok(!existsSync(currentAppendixPath(ws.runDir, "vega")), "nothing written here for a hosted agent");
});

test("refreshHosted, for the daemon: the settings rendered again and the current brief written", () => {
  const { ws } = workspace();
  const vega = agentOrDie(ws, "vega");
  const file = settingsFile(ws, vega);
  writeFileSync(file, "{}\n");
  refreshHosted(ws, vega, "the brief\n");
  assert.ok(JSON.parse(readFileSync(file, "utf8")).hooks?.SessionStart?.length, "rendered again");
  assert.equal(readFileSync(currentAppendixPath(ws.runDir, "vega"), "utf8"), "the brief\n");
  refreshHosted(ws, vega, null);
  assert.ok(!existsSync(currentAppendixPath(ws.runDir, "vega")));
});

// The daemon's resume at boot respawns on a settings failure, so a render that throws first must
// not leave the session on its old brief.
test("refreshHosted writes the brief before the settings, so a render that throws leaves it written", () => {
  const { dir, ws } = workspace();
  (ws.config.roles[agentOrDie(ws, "vega").role] as { settings: string }).settings = join(dir, "gone.json");
  assert.throws(() => refreshHosted(ws, agentOrDie(ws, "vega"), "the brief as it is now\n"), /gone\.json/);
  assert.equal(readFileSync(currentAppendixPath(ws.runDir, "vega"), "utf8"), "the brief as it is now\n");
});

test("a session that comes back under a new id: the stop record naming the old one is dropped", () => {
  const { ws } = workspace();
  noteStopped(ws, "vega", { id: "v1", name: "vega", kind: "background" } as Session);
  const w = wake(ws, agentOrDie(ws, "vega"), { t: offVega([], { id: "v2" }), deadline: Date.now() + 60_000, pollMs: 10 });
  assert.equal(w.is, "woke");
  assert.equal((w as { s: Session }).s.id, "v2");
  assert.equal(lastStopped(ws, "vega"), null);
  // the same id back keeps it, for the next stop to replace
  noteStopped(ws, "vega", { id: "v1", name: "vega", kind: "background" } as Session);
  wake(ws, agentOrDie(ws, "vega"), { t: offVega([]), deadline: Date.now() + 60_000, pollMs: 10 });
  assert.equal(lastStopped(ws, "vega")?.id, "v1");
});

test("a builder's current brief reads its repo: files from the checkout of the repo it works in", () => {
  const { dir, ws } = workspace();
  const bea = agentOrDie(ws, "bea");
  for (const k of ["web", "api"]) {
    mkdirSync(ws.config.repos[k]!.path, { recursive: true });
    writeFileSync(join(ws.config.repos[k]!.path, "AGENTS.md"), `${k}'s agents file\n`);
  }
  assert.match(currentAppendix(ws, bea, worktreePath(ws.config.repos.api!.path, "TEST-1")) ?? "", /api's agents file/);
  assert.match(currentAppendix(ws, bea, worktreePath(ws.config.repos.web!.path, "TEST-2")) ?? "", /web's agents file/);
  assert.match(currentAppendix(ws, bea, join(dir, "elsewhere")) ?? "", /web's agents file/, "else its first repo's");
});

// roleAppendix with no repo must not throw on a repo: file, or the wake takes that as undefined and
// a hosted builder is never sent its brief as it is now.
test("a hosted builder's current brief reads its repo: files from its first repo, as dispatch does", () => {
  const { ws } = workspace();
  const bea = { ...agentOrDie(ws, "bea"), host: "far" };
  assert.ok(bea.appendix.some((a) => a.startsWith("repo:")), "the fixture's builder has a repo: file");
  for (const k of ["web", "api"]) {
    mkdirSync(ws.config.repos[k]!.path, { recursive: true });
    writeFileSync(join(ws.config.repos[k]!.path, "AGENTS.md"), `${k}'s agents file\n`);
  }
  assert.match(currentAppendix(ws, bea, "/home/far/work/TEST-1") ?? "", /web's agents file/);
});

// The lead's resume and its respawn fallback: the current file is written first.
function leadFake(sessions: Session[], startFails = false) {
  const respawned: { id: string; appendix: string | null | undefined }[] = [];
  const t = {
    where: "here",
    sessions: (all = false) => sessions.filter((s) => all || s.alive),
    alive: (s: unknown) => !!s && (s as { alive?: unknown }).alive === true,
    start(req: StartRequest) {
      if (startFails) throw new Error("claude --bg failed");
      req.args(req.appendix ? "/run/appendix.md" : null);
      sessions.push({ id: "new1", name: "ada", kind: "background", alive: true });
      return "new1";
    },
    respawn(_n: string, id: string, _ms?: number, appendix?: string | null) {
      respawned.push({ id, appendix });
      sessions.push({ id, name: "ada", kind: "background", alive: true });
      return { ok: true, said: "respawned", why: "" };
    },
    stop() {},
  } as unknown as Transport;
  return { t, respawned };
}
const stoppedLead = (): Session => ({ id: "a1", name: "ada", kind: "background", state: "stopped", cwd: "/x/lead", sessionId: "a1-uuid" });

test("up resumes the lead with its brief as it is now written for the hook, on resume and on respawn", () => {
  const { dir, ws } = workspace();
  writeFileSync(join(dir, "briefs", "ada.md"), "ada's brief, edited since\n");
  const cur = currentAppendixPath(ws.runDir, "ada");
  bringUpLead(ws, lead(ws), leadFake([stoppedLead()]).t, false, () => {}, 1);
  assert.match(readFileSync(cur, "utf8"), /edited since/);
  rmSync(cur);
  const f = leadFake([stoppedLead()], true);
  bringUpLead(ws, lead(ws), f.t, false, () => {}, 1);
  assert.deepEqual(f.respawned.map((r) => r.id), ["a1"]);
  assert.match(readFileSync(cur, "utf8"), /edited since/, "the respawn fallback writes it too");
  // a hosted lead's daemon is sent it
  const h = leadFake([stoppedLead()]);
  bringUpLead(ws, { ...lead(ws), host: "far" }, h.t, false, () => {}, 1);
  assert.match(String(h.respawned[0]?.appendix), /edited since/);
});

// A settings render that throws must not skip the appendix, or the lead comes back on its old brief
// with only the settings warning said.
test("up's respawn writes the lead's brief as it is now even when its settings cannot be rendered", () => {
  const { dir, ws } = workspace();
  writeFileSync(join(dir, "briefs", "ada.md"), "ada's brief, edited since\n");
  (ws.config.roles[lead(ws).role] as { settings: string }).settings = join(dir, "gone.json");
  // no session id: up goes straight to the respawn, with no resume to write the brief first
  const f = leadFake([{ ...stoppedLead(), sessionId: undefined }]);
  const said: string[] = [];
  bringUpLead(ws, lead(ws), f.t, false, (l) => said.push(l), 1);
  assert.deepEqual(f.respawned.map((r) => r.id), ["a1"]);
  assert.ok(said.some((l) => /settings could not be rendered/.test(l)), said.join("\n"));
  assert.match(readFileSync(currentAppendixPath(ws.runDir, "ada"), "utf8"), /edited since/);
});

// A claude whose -p prints JSON, and whose --resume runs the settings' SessionStart hook as claude
// does and answers with the context it was given; with HOOKLESS set it ignores the hook, as a claude
// that does not deliver it would.
function probeClaude(hookless: boolean): string {
  const d = tempDir();
  const bin = join(d, "claude");
  writeFileSync(bin, `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const a = process.argv.slice(2);
const settings = JSON.parse(readFileSync(a[a.indexOf("--settings") + 1], "utf8"));
if (!a.includes("--resume")) { console.log(JSON.stringify({ session_id: "p1", result: "OK" })); process.exit(0); }
let ctx = "";
if (!${hookless}) {
  const cmd = settings.hooks.SessionStart.find((e) => e.matcher === "resume").hooks[0].command;
  const out = execSync(cmd, { input: JSON.stringify({ hook_event_name: "SessionStart", source: "resume" }) }).toString();
  ctx = out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
}
const m = /PROBE-[0-9A-F]+/.exec(ctx);
console.log(JSON.stringify({ session_id: "p1", result: m ? m[0] : "NONE" }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

test("doctor --resume-probe: ok when a resumed session is handed the codeword, missing when not", () => {
  const { ws } = workspace();
  assert.equal(resumeProbe(ws, probeClaude(false)).status, "ok");
  const no = resumeProbe(ws, probeClaude(true));
  assert.equal(no.status, "missing");
  assert.match(no.what, /answered "NONE", not the codeword/);
  assert.match(no.fix ?? "", /start it fresh/);
  assert.ok(!existsSync(join(ws.runDir, `resume-probe-${process.pid}`)), "the probe's files are removed");
});
