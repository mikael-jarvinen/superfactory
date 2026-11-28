import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { antigravityBackend, listSessions, sessionAlive, startSupervisor, stopSession } from "../src/backends/antigravity.js";
import { allStates, readState, sessionDir } from "../src/backends/agy-store.js";
import { agyHookMissing, agyHooksFile } from "../src/backends/agy-guard.js";
import { mcpServers, modeOf, pickValue, stricterKind, tripped, unsafeSettings } from "../src/backends/agy-supervisor.js";
import { backendFor } from "../src/backends/index.js";
import { NAME_HEAD_BYTES } from "../src/agent-name.js";
import { permissionOutcome, READ_ONLY_KINDS, readOnly } from "../src/backends/read-only.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { hook, senderName } from "../src/hooks/wake.js";
import { launchSpec } from "../src/launch.js";
import { procStat } from "../src/stacks/process.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace, until } from "./helpers.js";

// Every test here runs agy as the fake (fake-agy.ts), under a home of its own.
const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-agy-")));
process.env.SF_AGY_HOME = join(root, "home");
process.env.SF_AGY_SETTINGS = join(root, "agy-settings.json");
const agyLog = join(root, "agy-requests.jsonl");
process.env.FAKE_AGY_LOG = agyLog;
const fake = join(root, "agy");
writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./fake-agy.js", import.meta.url))}" "$@"\n`);
chmodSync(fake, 0o755);
process.env.SF_AGY_BIN = fake;
// No test opens a real scope (helpers.ts). This systemd-run stands in for one that makes the
// session's scope: it puts itself (the supervisor, once it execs) in a cgroup of the --unit name
// under SF_CGROUP_ROOT, and fake-agy.ts adds itself and its tools, as the kernel would. withScope
// puts it first on PATH.
process.env.SF_CGROUP_ROOT = join(root, "cgroup");
const scopeBin = join(root, "scope-bin");
mkdirSync(scopeBin);
writeFileSync(join(scopeBin, "systemd-run"), `#!/bin/sh
unit=
while [ "$1" != "--" ]; do [ $# -gt 0 ] || exit 2; case "$1" in --unit=*) unit="\${1#--unit=}";; esac; shift; done
shift
[ -n "$unit" ] || exit 3
SF_CGROUP_SELF="/agents.slice/$unit.scope"; export SF_CGROUP_SELF
mkdir -p "$SF_CGROUP_ROOT$SF_CGROUP_SELF" && echo $$ >> "$SF_CGROUP_ROOT$SF_CGROUP_SELF/cgroup.procs"
exec "$@"
`);
chmodSync(join(scopeBin, "systemd-run"), 0o755);
const withScope = async (f: () => Promise<void>) => {
  const path = process.env.PATH;
  process.env.PATH = `${scopeBin}:${path}`;
  try {
    await f();
  } finally {
    process.env.PATH = path;
  }
};

const requests = (): any[] => (existsSync(agyLog) ? readFileSync(agyLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const cwdFor = (name: string) => {
  const d = join(root, "cwd", name);
  mkdirSync(d, { recursive: true });
  return d;
};
const transcript = (id: string): any[] => readFileSync(readState(id)!.transcript!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
// Every process still running with this file's agy home: a supervisor or an agy a test left. The
// test process itself set SF_AGY_HOME after it started, so its own environ does not name it.
const left = (): number[] => {
  if (process.platform !== "linux") return [];
  const mark = `\0SF_AGY_HOME=${process.env.SF_AGY_HOME}\0`;
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number).filter((pid) => {
    if (pid === process.pid) return false;
    try {
      return `\0${readFileSync(`/proc/${pid}/environ`, "utf8")}`.includes(mark) && procStat(pid)?.state !== "Z";
    } catch {
      return false;
    }
  });
};
// Every session any test started is stopped, whether its start came up or not, and then nothing of
// them may be left running.
after(() => {
  for (const s of allStates())
    try {
      stopSession(s.id, false);
    } catch {
      // stopped as far as it can be; the check below says what is left
    }
  const pids = left();
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  assert.deepEqual(pids, [], "a supervisor or an agy outlived the tests");
});
const start = (name: string, prompt: string, extra: string[] = []) =>
  startSupervisor(cwdFor(name), ["--name", name, ...extra, "--prompt", prompt], process.env, 20_000);
const rowOf = (id: string) => listSessions(true).find((s) => s.id === id)!;
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return procStat(pid)?.state === "Z";
  } catch {
    return true;
  }
};
// With env set for the start, and put back after.
const withEnv = async (env: Record<string, string>, f: () => Promise<void> | void) => {
  Object.assign(process.env, env);
  try {
    await f();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
};

test("the read-only list is read, search and think, and nothing else is allowed", () => {
  assert.deepEqual([...READ_ONLY_KINDS], ["read", "search", "think"]);
  const opts = [
    { optionId: "a1", kind: "allow_always" },
    { optionId: "a", kind: "allow_once" },
    { optionId: "r", kind: "reject_once" },
    { optionId: "r2", kind: "reject_always" },
  ];
  for (const k of READ_ONLY_KINDS) assert.equal(readOnly(k), true, k);
  assert.deepEqual(permissionOutcome(true, opts), { outcome: "selected", optionId: "a" });
  assert.deepEqual(permissionOutcome(false, opts), { outcome: "selected", optionId: "r" });
  // every other ACP ToolKind, a kind left out, and one not in the protocol
  for (const k of ["edit", "delete", "move", "execute", "fetch", "switch_mode", "other", undefined, null, "READ", "write"]) {
    assert.equal(readOnly(k), false, String(k));
  }
  assert.deepEqual(permissionOutcome(false, [{ optionId: "r2", kind: "reject_always" }]), { outcome: "selected", optionId: "r2" });
  // never an allow-always, and nothing to pick is cancelled
  assert.deepEqual(permissionOutcome(true, [{ optionId: "a1", kind: "allow_always" }]), { outcome: "cancelled" });
  assert.deepEqual(permissionOutcome(false, [{ optionId: "a", kind: "allow_once" }]), { outcome: "cancelled" });
  assert.deepEqual(permissionOutcome(true, "junk"), { outcome: "cancelled" });
});

test("agy settings that would run a tool without asking are refused", () => {
  assert.equal(unsafeSettings(null), null);
  assert.equal(unsafeSettings("{}"), null);
  assert.equal(unsafeSettings('{"toolPermission":"request-review","permissions":{"deny":["command(rm)"]}}'), null);
  assert.match(unsafeSettings('{"toolPermission":"always-proceed"}')!, /always-proceed/);
  assert.match(unsafeSettings('{"toolPermission":"proceed-in-sandbox"}')!, /proceed-in-sandbox/);
  assert.match(unsafeSettings('{"agentMode":"auto"}')!, /auto/);
  assert.match(unsafeSettings('{"permissions":{"allow":["command(git)"]}}')!, /command\(git\)/);
  assert.match(unsafeSettings("{not json")!, /not JSON/);
});

test("Claude's MCP config becomes ACP stdio servers; a model or effort is picked by value or name", () => {
  assert.deepEqual(mcpServers('{"mcpServers":{"pw":{"command":"npx","args":["pw"],"env":{"A":"1"}},"web":{"url":"http://x"}}}'),
    [{ name: "pw", command: "npx", args: ["pw"], env: [{ name: "A", value: "1" }] }]);
  const o = { id: "t", options: [{ value: "low", name: "Low" }, { group: "g", options: [{ value: "extra", name: "Extra" }] }] };
  assert.equal(pickValue(o, "xhigh"), "extra");
  assert.equal(pickValue(o, "LOW"), "low");
  assert.equal(pickValue(o, "max"), null);
});

test("an antigravity agent never takes its role's Claude model or effort, and its own model is not checked at load", () => {
  const agy = (extra: string) => TOML.replace('name = "rae"\nrole = "reviewer"\n', `name = "rae"\nrole = "reviewer"\nbackend = "antigravity"\n${extra}`);
  const ws = tempWorkspace(agy(""));
  after(() => rmSync(ws, { recursive: true, force: true }));
  const w = openWorkspace(ws, {});
  const rae = w.config.agents.find((a) => a.name === "rae")!;
  assert.ok(w.config.roles.reviewer!.model, "the role has a model");
  const spec = launchSpec(w, rae, "hi", null, undefined);
  assert.equal(spec.model, undefined);
  assert.equal(spec.effort, undefined);
  // the role's rendered settings, whose rules the supervisor holds agy's calls to, with no wake hook
  const rendered = JSON.parse(readFileSync(spec.settings!, "utf8"));
  assert.ok(rendered.permissions?.deny?.length, "the reviewer's deny rules are rendered");
  assert.ok(!JSON.stringify(rendered.hooks ?? {}).includes(" hook wake"), "no wake hook for a backend with no message tool");
  const own = tempWorkspace(agy('model = "Gemini 4 Neon"\neffort = "xhigh"\n'));
  after(() => rmSync(own, { recursive: true, force: true }));
  const w2 = openWorkspace(own, {});
  const spec2 = launchSpec(w2, w2.config.agents.find((a) => a.name === "rae")!, "hi", null, undefined);
  assert.deepEqual([spec2.model, spec2.effort], ["Gemini 4 Neon", "xhigh"]);
  // Only the agy that runs knows its models, so a name no list here has loads, and start checks it.
  const fresh = tempWorkspace(agy('model = "gemini-9-ultra"\n'));
  after(() => rmSync(fresh, { recursive: true, force: true }));
  assert.equal(loadConfig(join(fresh, "factory.toml"), {}).agents.find((a) => a.name === "rae")!.model, "gemini-9-ultra");
});

test("a model the running agy does not offer fails the start, naming the agent and agy's models", () => {
  assert.throws(() => start("nomodel", "hi", ["--model", "opus"]),
    /nomodel's model "opus" is not one this agy offers; it offers gemini-flash \(Gemini Flash\), gemini-pro \(Gemini Pro\)\. Set model in factory\.toml/);
});

test("backend = \"antigravity\" loads, on this machine or a host", () => {
  const ws = tempWorkspace(TOML.replace('name = "rae"\nrole = "reviewer"\n', 'name = "rae"\nrole = "reviewer"\nbackend = "antigravity"\n'));
  after(() => rmSync(ws, { recursive: true, force: true }));
  const c = loadConfig(join(ws, "factory.toml"), {});
  const rae = c.agents.find((a) => a.name === "rae")!;
  assert.equal(rae.backend, "antigravity");
  assert.equal(backendFor(rae), antigravityBackend);
  const hosted = tempWorkspace(TOML.replace('name = "rae"\nrole = "reviewer"\n', 'name = "rae"\nrole = "reviewer"\nbackend = "antigravity"\nhost = "far"\ncwd = "/far/rae"\n') +
    '\n[hosts.far]\nssh = "far"\nurl = "http://far:1"\ntoken_file = "t"\nhash_files = ["daemon.toml", "workspace.toml"]\n');
  after(() => rmSync(hosted, { recursive: true, force: true }));
  assert.equal(loadConfig(join(hosted, "factory.toml"), {}).agents.find((a) => a.name === "rae")!.host, "far");
});

test("a session outlives its start, sets its model and effort, goes idle after its turn, and its transcript is under projects/", async () => {
  const brief = join(root, "brief.md");
  writeFileSync(brief, "You are Vera.\n");
  const id = start("vera", "hello", ["--model", "Gemini Pro", "--effort", "xhigh", "--appendix", brief]);
  await until("the first turn to end", () => readState(id)?.state === "done");
  const st = readState(id)!;
  const row = listSessions().find((s) => s.id === id)!;
  assert.ok(sessionAlive(row), "listed live");
  assert.equal(antigravityBackend.midTurn(row), false, "idle between prompts");
  assert.equal(row.name, "vera");
  assert.equal(st.model, "gemini-pro");
  const sets = requests().filter((r) => r.method === "session/set_config_option" && r.params.sessionId === st.sessionId).map((r) => [r.params.configId, r.params.value]);
  assert.deepEqual(sets, [["model", "gemini-pro"], ["thinking", "extra"]]);
  // the brief went in as a system-prompt addition, and the prompt as it is
  const created = requests().find((r) => r.method === "session/new" && r.params.cwd === cwdFor("vera"));
  assert.equal(created.params._meta.antigravity.systemPrompt.append, "You are Vera.\n");
  assert.equal(created.params.cwd, cwdFor("vera"));
  assert.ok(st.transcript!.startsWith(antigravityBackend.projectDir(cwdFor("vera"))));
  const lines = transcript(id);
  assert.deepEqual(lines[0], { type: "agent-name", agentName: "vera", sessionId: st.sessionId });
  assert.equal(lines[1].type, "user");
  assert.equal(lines[1].message.content[0].text, "hello");
  assert.equal(lines[2].type, "assistant");
  assert.equal(lines[2].message.content[0].text, "echo: hello");
  assert.equal(typeof antigravityBackend.transcriptAt(row), "number");
});

test("without the system-prompt capability the brief goes ahead of the first prompt", async () => {
  process.env.FAKE_AGY_NO_SYSTEM = "1";
  const brief = join(root, "brief2.md");
  writeFileSync(brief, "BRIEF\n");
  try {
    const id = start("nosys", "go", ["--appendix", brief]);
    await until("the turn to end", () => readState(id)?.state === "done");
    assert.equal(transcript(id)[1].message.content[0].text, "BRIEF\n\n---\n\ngo");
  } finally {
    delete process.env.FAKE_AGY_NO_SYSTEM;
  }
});

test("a delivered message is the next prompt; a read is allowed, an edit denied", async () => {
  const id = start("msgs", "slow");
  const row = () => listSessions().find((s) => s.id === id)!;
  await until("the first turn to be in flight", () => readState(id)?.state === "working");
  assert.equal(antigravityBackend.midTurn(row()), true, "busy while a prompt is in flight");
  antigravityBackend.deliver!(row(), "read README.md");
  antigravityBackend.deliver!(row(), "edit README.md");
  antigravityBackend.deliver!(row(), "quiet README.md");
  await until("the messages to be answered", () => transcript(id).filter((l) => l.type === "turn-end").length === 4);
  const said = transcript(id).filter((l) => l.type === "assistant" && l.message.content[0].type === "text").map((l) => l.message.content[0].text);
  assert.deepEqual(said, ["read ok", "edit denied", "quiet ok"]);
  const perms = requests().filter((r) => r.permission).map((r) => [r.permission.kind, r.permission.outcome.optionId]);
  assert.deepEqual(perms.slice(-2), [["read", "allow-once"], ["edit", "reject-once"]]);
  assert.equal(readState(id)!.state, "done");
});

test("a session that agy starts in a mode other than default, plan included, is put back in default", async () => {
  for (const m of ["accept-edits", "plan"])
    await withEnv({ FAKE_AGY_MODE: m }, async () => {
      const id = start(`moded-${m}`, "hi");
      await until("idle", () => readState(id)?.state === "done");
      const sets = requests().filter((r) => r.method === "session/set_config_option" && r.params.sessionId === readState(id)!.sessionId);
      assert.deepEqual(sets.map((r) => [r.params.configId, r.params.value]), [["mode", "default"]], m);
    });
});

test("the mode is held: a change mid-session is put back, by config option or the older modes field", async () => {
  const id = start("held", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const sid = readState(id)!.sessionId;
  antigravityBackend.deliver!(rowOf(id), "mode accept-edits");
  antigravityBackend.deliver!(rowOf(id), "hello");
  await until("both answered", () => transcript(id).filter((l) => l.type === "turn-end").length === 3);
  const sets = requests().filter((r) => r.method === "session/set_config_option" && r.params.sessionId === sid);
  assert.deepEqual(sets.map((r) => [r.params.configId, r.params.value]), [["mode", "default"]]);
  // the next prompt went only once the mode was back
  const order = requests().filter((r) => r.params?.sessionId === sid).map((r) => r.method === "session/prompt" ? r.params.prompt[0].text : r.method);
  assert.deepEqual(order.slice(-3), ["mode accept-edits", "session/set_config_option", "hello"]);
  assert.equal(readState(id)!.state, "done");

  await withEnv({ FAKE_AGY_LEGACY_MODES: "1", FAKE_AGY_MODE: "plan" }, async () => {
    const old = start("legacy", "hi");
    await until("idle", () => readState(old)?.state === "done");
    antigravityBackend.deliver!(rowOf(old), "mode auto");
    await until("answered", () => transcript(old).filter((l) => l.type === "turn-end").length === 2);
    await until("the mode set back", () => requests().filter((r) => r.method === "session/set_mode" && r.params.sessionId === readState(old)!.sessionId).length === 2);
    assert.ok(requests().filter((r) => r.method === "session/set_mode").every((r) => r.params.modeId === "default"));
    assert.equal(readState(old)!.state, "done");
  });
});

test("a mode that cannot be set back ends the session as failed", async () => {
  await withEnv({ FAKE_AGY_MODE_STUCK: "1" }, async () => {
    const id = start("stuck", "hi");
    await until("idle", () => readState(id)?.state === "done");
    antigravityBackend.deliver!(rowOf(id), "mode auto");
    await until("the session to fail", () => readState(id)?.state === "failed");
    assert.match(readState(id)!.error!, /moved the session to mode auto, and it could not be set back to default: session\/set_config_option: the mode cannot be changed/);
  });
});

test("agy settings are read again before each prompt", async () => {
  const id = start("resettings", "hi");
  await until("idle", () => readState(id)?.state === "done");
  writeFileSync(process.env.SF_AGY_SETTINGS!, '{"agentMode":"accept-edits"}');
  try {
    antigravityBackend.deliver!(rowOf(id), "hello");
    await until("the session to fail", () => readState(id)?.state === "failed");
    assert.match(readState(id)!.error!, /lets tools run without asking: agentMode is "accept-edits"/);
    assert.equal(transcript(id).filter((l) => l.type === "turn-end").length, 1, "the prompt did not go");
    // delivered by the hook, so never lost: still in the inbox, and named in the state
    const left = readdirSync(join(sessionDir(id), "inbox")).filter((n) => n.endsWith(".json"));
    assert.equal(left.length, 1);
    assert.match(JSON.parse(readFileSync(join(sessionDir(id), "inbox", left[0]!), "utf8")).text, /hello/);
    assert.deepEqual(readState(id)!.undelivered, left);
  } finally {
    rmSync(process.env.SF_AGY_SETTINGS!, { force: true });
  }
});

test("the tripwire: a call never asked trips it whether it completes or fails; asked, denied and failed does not", () => {
  const unasked = { kind: "execute", asked: false, allowed: false };
  assert.match(tripped(unasked, "completed", false)!, /ran without asking/);
  assert.match(tripped(unasked, "failed", false)!, /ran and failed without asking/);
  assert.equal(tripped(unasked, "in_progress", false), null);
  assert.equal(tripped({ kind: "edit", asked: true, allowed: false }, "failed", false), null);
  assert.match(tripped({ kind: "edit", asked: true, allowed: false }, "completed", false)!, /after it was denied/);
  assert.equal(tripped({ kind: "read", asked: false, allowed: false }, "completed", false), null);
  assert.match(tripped({ kind: undefined, asked: false, allowed: false }, "failed", false)!, /without asking/);
  assert.match(tripped({ kind: "edit", asked: true, allowed: true }, "in_progress", true)!, /changed its kind to edit after it was allowed/);
  // a kind only gets stricter: once not read-only, a call stays so, whatever it later says
  const seen = (kind: unknown, asked = false) => ({ kind, asked, allowed: false });
  assert.equal(stricterKind(undefined, "read"), "read");
  assert.equal(stricterKind(seen("read"), "edit"), "edit");
  assert.equal(stricterKind(seen("edit"), "read"), "edit");
  assert.equal(stricterKind(seen("read"), undefined), "read");
  // a call announced with no kind takes the first kind it gives before it is asked, then only gets stricter
  assert.equal(stricterKind(seen(undefined), "read"), "read");
  assert.equal(stricterKind(seen(undefined), undefined), undefined);
  assert.equal(stricterKind(seen(stricterKind(seen(undefined), "read")), "edit"), "edit");
  assert.equal(stricterKind(seen(stricterKind(seen(undefined), "edit")), "read"), "edit");
  // asked with no kind, it was denied as not read-only, and a kind it gives later is not taken
  assert.equal(stricterKind(seen(undefined, true), "read"), undefined);
  assert.deepEqual(modeOf(undefined, { currentModeId: "plan", availableModes: [{ id: "default" }] }), { current: "plan", offersDefault: true, via: "modes" });
  assert.equal(modeOf([], undefined), undefined);
});

test("an unasked command that fails, and a read whose kind turns to edit, each end the session", async () => {
  const id = start("roguefail", "hi");
  await until("idle", () => readState(id)?.state === "done");
  antigravityBackend.deliver!(rowOf(id), "rogue-fail");
  await until("the session to fail", () => readState(id)?.state === "failed");
  assert.match(readState(id)!.error!, /\(execute\) is not read-only and ran and failed without asking/);

  const m = start("morph", "hi");
  await until("idle", () => readState(m)?.state === "done");
  antigravityBackend.deliver!(rowOf(m), "morph");
  await until("the session to fail", () => readState(m)?.state === "failed");
  assert.match(readState(m)!.error!, /\(edit\) is not read-only and changed its kind to edit after it was allowed as read-only/);
});

test("a call's kind is held to the stricter: denied as an edit it cannot pass as a read, nor be asked as one", async () => {
  const u = start("unmorph", "hi");
  await until("idle", () => readState(u)?.state === "done");
  antigravityBackend.deliver!(rowOf(u), "unmorph");
  await until("the session to fail", () => readState(u)?.state === "failed");
  assert.match(readState(u)!.error!, /\(edit\) is not read-only and ran after it was denied/);

  const a = start("askasread", "hi");
  await until("idle", () => readState(a)?.state === "done");
  antigravityBackend.deliver!(rowOf(a), "ask-as-read");
  await until("the turn", () => transcript(a).some((l) => l.type === "permission"));
  const p = transcript(a).find((l) => l.type === "permission");
  assert.equal(p.kind, "edit");
  assert.equal(p.allowed, false);
  await until("idle", () => readState(a)?.state === "done");
});

test("a tripwire kills agy's tools too, SIGKILL for one that outlives SIGTERM, before the supervisor exits", async () => {
  const id = start("stubborn", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  antigravityBackend.deliver!(rowOf(id), "stubborn");
  await until("the session to fail", () => readState(id)?.state === "failed", 20_000);
  const toolPid = requests().map((r) => r.tool).filter((x) => typeof x === "number").pop() as number;
  assert.ok(toolPid, "the fake started its tool");
  await until("the supervisor to exit", () => gone(st.pid), 20_000);
  assert.equal(gone(toolPid), true, "the tool outlived the supervisor");
  assert.equal(gone(st.agentPid!), true);
});

// The pids whose process group is pgid, zombies aside.
const inGroup = (pgid: number): number[] =>
  readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number).filter((pid) => {
    try {
      const s = procStat(pid);
      return s?.pgid === pgid && s.state !== "Z";
    } catch {
      return false;
    }
  });
const lastTool = () => requests().map((r) => r.tool).filter((x) => typeof x === "number").pop() as number;

test("a call announced with no kind takes the kind it gives later: a read so given passes, asked or not", async () => {
  const id = start("kindless", "hi");
  await until("idle", () => readState(id)?.state === "done");
  antigravityBackend.deliver!(rowOf(id), "kindless");
  await until("the turn", () => transcript(id).filter((l) => l.type === "turn-end").length === 2);
  antigravityBackend.deliver!(rowOf(id), "kindless-ask");
  await until("the turn", () => transcript(id).filter((l) => l.type === "turn-end").length === 3);
  assert.equal(readState(id)!.state, "done", readState(id)!.error);
  const p = transcript(id).find((l) => l.type === "permission");
  assert.equal(p.kind, "read");
  assert.equal(p.allowed, true);
});

test("agy that exits on its own takes its tools with it: nothing is left in the supervisor's group", async () => {
  const id = start("exitwithtool", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  antigravityBackend.deliver!(rowOf(id), "exit-with-tool");
  await until("the session to fail", () => readState(id)?.state === "failed", 20_000);
  assert.match(readState(id)!.error!, /agy exited on its own \(code 3\)/);
  const toolPid = lastTool();
  assert.ok(toolPid, "the fake started its tool");
  await until("the supervisor to exit", () => gone(st.pid), 20_000);
  assert.equal(gone(toolPid), true, "the tool outlived agy and the supervisor");
  assert.deepEqual(inGroup(st.pid), []);
});

test("stop with a tool running kills it, SIGKILL as it ignores SIGTERM: nothing is left in the supervisor's group", async () => {
  const id = start("stopwithtool", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  antigravityBackend.deliver!(rowOf(id), "spawn-tool");
  await until("the turn", () => transcript(id).filter((l) => l.type === "turn-end").length === 2);
  const toolPid = lastTool();
  assert.equal(gone(toolPid), false, "the tool runs after the turn");
  stopSession(id, false);
  assert.equal(readState(id)!.state, "stopped");
  assert.equal(gone(toolPid), true, "the tool outlived the stop");
  assert.equal(gone(st.pid), true);
  assert.deepEqual(inGroup(st.pid), []);
});

test("stop kills what is left in the group of a supervisor that is gone, agy and its tool both dead", async () => {
  const id = start("orphantool", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  antigravityBackend.deliver!(rowOf(id), "spawn-tool");
  await until("the turn", () => transcript(id).filter((l) => l.type === "turn-end").length === 2);
  const toolPid = lastTool();
  process.kill(st.pid, "SIGKILL");
  process.kill(st.agentPid!, "SIGKILL");
  await until("supervisor and agy gone", () => gone(st.pid) && gone(st.agentPid!));
  assert.equal(gone(toolPid), false, "the tool is left, reparented");
  stopSession(id, true);
  assert.equal(gone(toolPid), true, "the tool was killed by its group");
  assert.deepEqual(inGroup(st.pid), []);
});

test("a call asked with no kind is denied, and a read it reports after that and completes trips the session", async () => {
  const id = start("kindlessdenied", "hi");
  await until("idle", () => readState(id)?.state === "done");
  antigravityBackend.deliver!(rowOf(id), "kindless-denied");
  await until("the session to fail", () => readState(id)?.state === "failed");
  assert.match(readState(id)!.error!, /\(no kind\) is not read-only and ran after it was denied/);
  const p = transcript(id).find((l) => l.type === "permission");
  assert.equal(p.allowed, false);
});

test("a plain stop of an idle session takes well under 5 s, and the supervisor logs no survivor", async () => {
  const id = start("quickstop", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  const t0 = Date.now();
  stopSession(id, false);
  const took = Date.now() - t0;
  assert.ok(took < 2500, `the stop took ${took} ms`);
  assert.equal(readState(id)!.state, "stopped");
  assert.equal(gone(st.pid), true);
  assert.equal(gone(st.agentPid!), true);
  const log = readFileSync(join(sessionDir(id), "supervisor.log"), "utf8");
  assert.doesNotMatch(log, /still running after SIGKILL|survived/);
});

// The living pids in a session's scope.
const inScope = (st: { cgroup?: string | null }): number[] =>
  readFileSync(`${process.env.SF_CGROUP_ROOT}${st.cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number).filter((p) => !gone(p));

test("the supervisor runs in a scope named for its session, holding agy; one that runs in none says so", async () => {
  await withScope(async () => {
    const id = start("scoped", "hi");
    await until("idle", () => readState(id)?.state === "done");
    const st = readState(id)!;
    assert.equal(st.cgroup, `/agents.slice/sf-${id}.scope`);
    assert.deepEqual(inScope(st).sort(), [st.pid, st.agentPid!].sort());
    stopSession(id, true);
    assert.deepEqual(inScope(st), []);
  });
  const id = start("unscoped", "hi");
  await until("idle", () => readState(id)?.state === "done");
  assert.equal(readState(id)!.cgroup, null);
  assert.match(readFileSync(join(sessionDir(id), "supervisor.log"), "utf8"), /not in the scope sf-agy-[0-9a-f]{12}\.scope \(cgroup .*\): an end kills the supervisor's process group/);
  stopSession(id, true);
});

test("agy that exits on its own takes a tool in a session of its own with it: nothing is left in the scope", () => withScope(async () => {
  const id = start("exitsetsid", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  antigravityBackend.deliver!(rowOf(id), "exit-with-setsid-tool");
  await until("the session to fail", () => readState(id)?.state === "failed", 20_000);
  const toolPid = lastTool();
  assert.ok(toolPid, "the fake started its tool");
  assert.notEqual(procStat(toolPid)?.pgid ?? 0, st.pid, "the tool is in a group of its own");
  await until("the supervisor to exit", () => gone(st.pid), 20_000);
  assert.equal(gone(toolPid), true, "the tool outlived agy and the supervisor");
  assert.deepEqual(inScope(st), []);
}));

test("stop kills a tool in a session of its own by the scope, when supervisor and agy are both gone", () => withScope(async () => {
  const id = start("orphansetsid", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  antigravityBackend.deliver!(rowOf(id), "spawn-setsid-tool");
  await until("the turn", () => transcript(id).filter((l) => l.type === "turn-end").length === 2);
  const toolPid = lastTool();
  process.kill(st.pid, "SIGKILL");
  process.kill(st.agentPid!, "SIGKILL");
  await until("supervisor and agy gone", () => gone(st.pid) && gone(st.agentPid!));
  assert.equal(gone(toolPid), false, "the tool is left");
  stopSession(id, true);
  assert.equal(gone(toolPid), true, "the tool was killed by the scope");
  assert.deepEqual(inScope(st), []);
}));

// what stopSession says on stderr
function stopSaying(id: string): string {
  const said: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((x: string) => (said.push(String(x)), true)) as typeof process.stderr.write;
  try {
    stopSession(id, true);
  } finally {
    process.stderr.write = write;
  }
  return said.join("");
}

function staleState(id: string, name: string, pid: number, stamp: string, boot?: string): void {
  mkdirSync(sessionDir(id), { recursive: true });
  const st = { id, name, kind: "background", backend: "antigravity", state: "done", status: "idle", cwd: root, pid, stamp, ...(boot ? { boot } : {}), cgroup: null, agentPid: null, sessionId: null, model: null, transcript: null, startedAt: 0, updatedAt: "" };
  writeFileSync(join(sessionDir(id), "state.json"), JSON.stringify(st));
}

// a group whose leader has exited, with a member left: what a stale pid can name after a reboot
async function leaderless(): Promise<[number, number]> {
  const sh = spawnSync("sh", ["-c", "setsid sh -c 'sleep 30 >/dev/null 2>&1 & echo $$ $!'"], { encoding: "utf8" });
  const pair = sh.stdout.trim().split(/\s+/).map(Number) as [number, number];
  await until("the leader to exit", () => gone(pair[0]));
  return pair;
}

const kill9 = (pids: number[]) => {
  for (const p of pids)
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // gone
    }
};

async function withBoot(boot: string, f: () => Promise<void>): Promise<void> {
  const before = process.env.SF_BOOT_ID;
  process.env.SF_BOOT_ID = boot;
  try {
    await f();
  } finally {
    if (before === undefined) delete process.env.SF_BOOT_ID;
    else process.env.SF_BOOT_ID = before;
  }
}

test("with no scope, a stale state from another boot never has its supervisor's pid's group killed", { skip: process.platform !== "linux" }, async () => {
  const [pgid, member] = await leaderless();
  try {
    assert.equal(procStat(member)?.pgid, pgid);
    staleState("agy-0123456789ab", "stale", pgid, "another-boot:1");
    assert.match(stopSaying("agy-0123456789ab"), /stale: no scope recorded, and the supervisor's pid \d+ is from another boot, so its process group is not killed/);
    assert.equal(gone(member), false, "an unrelated group was killed");
    // off Linux the boot is recorded beside the stamp, which holds none
    await withBoot("boot-b", async () => {
      staleState("agy-0123456789ae", "stale-mac", pgid, "Sat Nov 28 10:00:00 2026", "boot-a");
      assert.match(stopSaying("agy-0123456789ae"), /stale-mac: no scope recorded, and the supervisor's pid \d+ is from another boot/);
    });
    assert.equal(gone(member), false, "an unrelated group was killed");
  } finally {
    kill9([member]);
  }
});

test("with no scope and no boot id, the supervisor's group is never killed", { skip: process.platform !== "linux" }, () => withBoot("", async () => {
  const [pgid, member] = await leaderless();
  try {
    staleState("agy-0123456789af", "bootless", pgid, "Sat Nov 28 10:00:00 2026");
    assert.match(stopSaying("agy-0123456789af"), /bootless: no scope recorded, and the supervisor's pid \d+ cannot be told from another boot's on this platform/);
    assert.equal(gone(member), false, "an unrelated group was killed");
  } finally {
    kill9([member]);
  }
}));

test("with no scope, in the boot the supervisor recorded, the stamp match decides its group", { skip: process.platform !== "linux" }, () => withBoot("boot-b", async () => {
  const [gonePid, orphan] = await leaderless();
  const up = spawnSync("sh", ["-c", "setsid sh -c 'sleep 30 >/dev/null 2>&1 & echo $$ $!; wait' >\"$1\" 2>/dev/null &", "sh", join(root, "up.pids")]);
  assert.equal(up.status, 0);
  await until("the second group", () => existsSync(join(root, "up.pids")) && readFileSync(join(root, "up.pids"), "utf8").trim().split(/\s+/).length === 2);
  const [upPid, member] = readFileSync(join(root, "up.pids"), "utf8").trim().split(/\s+/).map(Number) as [number, number];
  try {
    // macOS's shape: the boot beside a stamp that holds none
    staleState("agy-0123456789ac", "orphaned", gonePid, "Sat Nov 28 10:00:00 2026", "boot-b");
    assert.equal(stopSaying("agy-0123456789ac"), "", "nothing to say when the group is the session's");
    await until("the left tool killed", () => gone(orphan));
    staleState("agy-0123456789ad", "reused", upPid, "Sat Nov 28 10:00:00 2026", "boot-b");
    assert.match(stopSaying("agy-0123456789ad"), /reused: no scope recorded, and the supervisor's pid \d+ is another process's now, so its process group is not killed/);
    assert.equal(gone(member), false, "an unrelated group was killed");
    assert.equal(gone(upPid), false, "an unrelated process was killed");
  } finally {
    kill9([orphan, upPid, member]);
  }
}));

test("a stop that removes a session tells each undelivered message, with its sender, and keeps it in the transcript", async () => {
  const id = start("undelivered", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  antigravityBackend.deliver!(rowOf(id), "slow", "ada");
  await until("the slow turn", () => readState(id)?.state === "working");
  antigravityBackend.deliver!(rowOf(id), "the second message\nof two lines", "grace");
  const out = stopSaying(id);
  assert.match(out, /^undelivered: a message from grace \(\S+\) never reached the session, and the stop drops it from the inbox:\n  the second message\n  of two lines\n$/);
  const u = readFileSync(st.transcript!, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "undelivered");
  assert.equal(u.length, 1);
  assert.equal(u[0].from, "grace");
  assert.equal(u[0].text, "the second message\nof two lines");
  assert.equal(existsSync(sessionDir(id)), false);
});

test("a tool that is not read-only and runs without asking ends the session as failed", async () => {
  const id = start("rogue", "hi");
  await until("idle", () => readState(id)?.state === "done");
  antigravityBackend.deliver!(listSessions().find((s) => s.id === id)!, "rogue");
  await until("the session to fail", () => readState(id)?.state === "failed");
  assert.match(readState(id)!.error!, /tool call call-\d+ \(execute\) is not read-only and ran without asking/);
  await until("the supervisor to exit", () => !sessionAlive(readState(id) as any));
  assert.equal(listSessions().some((s) => s.id === id), false, "an ended session is listed only with includeDone");
  assert.ok(listSessions(true).some((s) => s.id === id));
});

test("stop ends the session and its agy, and remove takes its directory but not its transcript", async () => {
  const id = start("stopme", "hi");
  await until("idle", () => readState(id)?.state === "done");
  const st = readState(id)!;
  stopSession(id, false);
  assert.equal(readState(id)!.state, "stopped");
  assert.equal(sessionAlive(readState(id) as any), false);
  assert.throws(() => process.kill(st.agentPid!, 0), "agy is gone");
  stopSession(id, true);
  assert.equal(existsSync(sessionDir(id)), false);
  assert.ok(existsSync(st.transcript!));
});

test("stop kills an agy whose supervisor is gone", async () => {
  await withEnv({ FAKE_AGY_IGNORE_EOF: "1" }, async () => {
    const id = start("orphan", "hi");
    await until("idle", () => readState(id)?.state === "done");
    const st = readState(id)!;
    process.kill(st.pid, "SIGKILL");
    await until("the supervisor to be gone", () => !sessionAlive(readState(id) as any));
    assert.equal(gone(st.agentPid!), false, "agy outlived its supervisor");
    stopSession(id, true);
    assert.equal(gone(st.agentPid!), true, "agy was killed");
    assert.equal(existsSync(sessionDir(id)), false);
  });
});

test("a supervisor that crashes kills its agy and records the session failed", async () => {
  await withEnv({ FAKE_AGY_IGNORE_EOF: "1" }, async () => {
    const id = start("crash", "hi");
    await until("idle", () => readState(id)?.state === "done");
    const st = readState(id)!;
    // the transcript turned into a directory: the next prompt's first write throws, uncaught
    rmSync(st.transcript!);
    mkdirSync(st.transcript!);
    antigravityBackend.deliver!(rowOf(id), "hello");
    await until("the session to fail", () => readState(id)?.state === "failed");
    assert.match(readState(id)!.error!, /^the supervisor crashed: EISDIR/);
    assert.equal(readState(id)!.undelivered?.length, 1, "the message it crashed on is still in the inbox");
    await until("agy and the supervisor to be gone", () => gone(st.agentPid!) && gone(st.pid));
  });
});

test("a supervisor that dies before it writes its state fails the start at once, with its log", () => {
  const t0 = Date.now();
  assert.throws(() => startSupervisor(cwdFor("bad"), ["--bogus"], process.env, 20_000), /exited before its session started.*its log ends:\n.*agy-supervisor: /s);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
});

test("a start that agy refuses for want of a login fails, saying how to log in", () => {
  process.env.FAKE_AGY_AUTH = "0";
  try {
    assert.throws(() => start("nologin", "hi"), /not logged in \(agy acp --login\)/);
  } finally {
    delete process.env.FAKE_AGY_AUTH;
  }
});

test("unsafe agy settings stop a start before agy runs", () => {
  writeFileSync(process.env.SF_AGY_SETTINGS!, '{"toolPermission":"always-proceed"}');
  try {
    assert.throws(() => start("unsafe", "hi"), /lets tools run without asking: toolPermission is "always-proceed"/);
  } finally {
    rmSync(process.env.SF_AGY_SETTINGS!, { force: true });
  }
});

test("SendMessage to an Antigravity agent wakes it, delivers the message as a prompt, and is denied as delivered", async () => {
  const dir = tempWorkspace(TOML.replace("[tracker]", `[roles.assistant]
cwd = "assistants"
permission_mode = "auto"
settings = "readonly"

[[agents]]
name = "vega"
role = "assistant"
backend = "antigravity"

[tracker]`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  mkdirSync(join(dir, "assistants"), { recursive: true });
  // the sender is named by its own transcript, not by where it runs: ada and another session share the lead's cwd
  const own = join(root, "s1.jsonl");
  writeFileSync(own, [JSON.stringify({ type: "agent-name", agentName: "ada", sessionId: "s1" }), JSON.stringify({ type: "user" })].join("\n") + "\n");
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", transcript_path: own, cwd: join(dir, "lead"), tool_name: "SendMessage", tool_input: { to: "vega", message: "read notes.md" } });
  const r = hook(["--wait-seconds", "20"], input, dir);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout!).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /^Delivered: vega runs on antigravity.*after a fresh start/);
  const s = listSessions().find((x) => x.name === "vega" && sessionAlive(x))!;
  await until("the message to be answered", () => transcript(s.id!).some((l) => l.type === "assistant" && l.message.content[0].text === "read ok"));
  const asked = transcript(s.id!).filter((l) => l.type === "user" && l.message.content[0].type === "text").map((l) => l.message.content[0].text);
  assert.equal(asked.length, 2);
  assert.equal(asked[1], "Message from ada:\n\nread notes.md");
  void ws;
});

test("a session on a host wakes an Antigravity agent of that host there, and delivers to it there", async () => {
  const dir = tempWorkspace(TOML.replace("[tracker]", `[roles.assistant]
cwd = "assistants"
permission_mode = "auto"
settings = "readonly"

[[agents]]
name = "vesta"
role = "assistant"
backend = "antigravity"
host = "far"
cwd = "%CWD%"

[tracker]`).replace("%CWD%", cwdFor("vesta")) + '\n[hosts.far]\nssh = "far"\nurl = "http://127.0.0.1:1"\ntoken_file = "t"\nhash_files = ["daemon.toml", "workspace.toml"]\n');
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  mkdirSync(join(dir, "assistants"), { recursive: true });
  // the sender is named by its own transcript, not by where it runs: ada and another session share the lead's cwd
  const own = join(root, "s1h.jsonl");
  writeFileSync(own, [JSON.stringify({ type: "agent-name", agentName: "ada", sessionId: "s1h" }), JSON.stringify({ type: "user" })].join("\n") + "\n");
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1h", transcript_path: own, cwd: join(dir, "lead"), tool_name: "SendMessage", tool_input: { to: "vesta", message: "read notes.md" } });
  const r = hook(["--wait-seconds", "20", "--from-host", "far"], input, dir);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout!).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /^Delivered: vesta runs on antigravity.*after a fresh start/);
  const s = listSessions().find((x) => x.name === "vesta" && sessionAlive(x))!;
  await until("the message to be answered", () => transcript(s.id!).some((l) => l.type === "assistant" && l.message.content[0].text === "read ok"));
  const asked = transcript(s.id!).filter((l) => l.type === "user" && l.message.content[0].type === "text").map((l) => l.message.content[0].text);
  assert.equal(asked.length, 2);
  assert.equal(asked[1], "Message from ada:\n\nread notes.md");
  void ws;
});

test("a sender with no transcript naming it is unknown, never a guess", () => {
  assert.equal(senderName({ session_id: "s9", cwd: join(root, "nowhere") }), "unknown (session s9)");
  const t = join(root, "s8.jsonl");
  writeFileSync(t, JSON.stringify({ type: "agent-name", agentName: "otto", sessionId: "other" }) + "\n" + JSON.stringify({ type: "agent-name", agentName: "otto2" }) + "\n");
  assert.equal(senderName({ session_id: "s8", transcript_path: t }), "otto2");
  // the first name is the one, as the board's analytics take it, and only the head is read
  const two = join(root, "s7.jsonl");
  writeFileSync(two, [{ type: "agent-name", agentName: "first" }, { type: "user" }, { type: "agent-name", agentName: "second" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(senderName({ session_id: "s7", transcript_path: two }), "first");
  const deep = join(root, "s6.jsonl");
  writeFileSync(deep, JSON.stringify({ type: "user", pad: "x".repeat(NAME_HEAD_BYTES) }) + "\n" + JSON.stringify({ type: "agent-name", agentName: "late" }) + "\n");
  assert.equal(senderName({ session_id: "s6", transcript_path: deep }), "unknown (session s6)");
});

test("a send from a host session to an Antigravity agent on another machine is refused at once", () => {
  const dir = tempWorkspace(TOML.replace("[tracker]", `[roles.assistant]
cwd = "assistants"
permission_mode = "auto"
settings = "readonly"

[[agents]]
name = "vega"
role = "assistant"
backend = "antigravity"

[tracker]`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const t0 = Date.now();
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s2", cwd: "/far/lead", tool_name: "SendMessage", tool_input: { to: "vega", message: "hi" } });
  const r = hook(["--from-host", "far"], input, dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr!, /vega runs under antigravity on the primary, and an antigravity agent can only be messaged from a session on the primary or on its own machine, not from far\. .*ask the lead/s);
  assert.doesNotMatch(r.stderr!, /factory wake|Tell .* that vega is off/);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(listSessions().some((x) => x.name === "vega" && sessionAlive(x) && x.startedAt as number >= t0), false, "nothing was started");
  // and the failed-send explanation stays out of it
  const post = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s2", cwd: "/far/lead", tool_name: "SendMessage", tool_input: { to: "vega", message: "hi" }, tool_response: { success: false, message: "No agent named vega is reachable" } });
  assert.deepEqual(hook(["--from-host", "far"], post, dir), { code: 0 });
});

// A builder's rendered settings, as an antigravity launch writes them, and the hook entry in place.
function builderSettings(): string {
  const ws = tempWorkspace(TOML.replace('name = "bea"\nrole = "builder"\n', 'name = "bea"\nrole = "builder"\nbackend = "antigravity"\n'));
  after(() => rmSync(ws, { recursive: true, force: true }));
  const w = openWorkspace(ws, {});
  const spec = launchSpec(w, w.config.agents.find((a) => a.name === "bea")!, "hi", null, undefined);
  assert.equal(agyHookMissing(), null, "the launch wrote agy's hook entry");
  return spec.settings!;
}

test("with the role's settings, agy's edits and commands are held to its rules, as a Claude agent's are", async () => {
  const settings = builderSettings();
  const id = start("ruled", "write notes.txt", ["--settings", settings]);
  const row = () => listSessions().find((s) => s.id === id)!;
  await until("the first turn to end", () => readState(id)?.state === "done");
  antigravityBackend.deliver!(row(), "run git status && ls");
  antigravityBackend.deliver!(row(), "run git push origin main");
  await until("the messages to be answered", () => transcript(id).filter((l) => l.type === "turn-end").length === 3);
  const said = transcript(id).filter((l) => l.type === "assistant" && l.message.content[0].type === "text").map((l) => l.message.content[0].text);
  assert.deepEqual(said, ["wrote", "ran", "run denied"]);
  const perms = transcript(id).filter((l) => l.type === "permission");
  assert.deepEqual(perms.map((p) => [p.kind, p.allowed]), [["edit", true], ["execute", true], ["execute", false]]);
  assert.match(perms[2].reason, /guard\[builder\]: refused\. pushing to a protected branch \(main\)/);
  // agy's hook finds the same rules through its environment
  const env = requests().filter((r) => r.env).pop().env;
  assert.deepEqual(env, { SF_AGY_RULES: settings, SF_AGY_PROJECT: cwdFor("ruled") });
  assert.equal(readState(id)!.state, "done", "a refusal is not a tripwire");
});

test("a session whose rules cannot be read, or whose agy would skip the hook, does not start", () => {
  const settings = builderSettings();
  assert.throws(() => start("norules", "hi", ["--settings", join(root, "missing.json")]), /settings .*missing\.json cannot be read/);
  const file = agyHooksFile();
  const saved = readFileSync(file, "utf8");
  try {
    rmSync(file);
    assert.throws(() => start("nohook", "hi", ["--settings", settings]), /so agy's reads would go unchecked/);
  } finally {
    writeFileSync(file, saved);
  }
});

test("a call agy's hook denied never ran, so it is no tripwire", () => {
  // the denied call, and a sibling agy fails with empty output after it
  assert.equal(tripped({ kind: "execute", asked: false, allowed: false }, "failed", false, "tool call denied by pre-tool hook: superfactory: no"), null);
  assert.equal(tripped({ kind: "execute", asked: false, allowed: false }, "failed", false, { output: "" }), null);
  assert.notEqual(tripped({ kind: "execute", asked: false, allowed: false }, "failed", false, "exit 1"), null);
  assert.notEqual(tripped({ kind: "execute", asked: false, allowed: false }, "completed", false, "tool call denied by pre-tool hook: x"), null);
});
