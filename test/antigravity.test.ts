import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { antigravityBackend, listSessions, sessionAlive, startSupervisor, stopSession } from "../src/backends/antigravity.js";
import { readState, sessionDir } from "../src/backends/agy-store.js";
import { mcpServers, pickValue, unsafeSettings } from "../src/backends/agy-supervisor.js";
import { backendFor } from "../src/backends/index.js";
import { permissionOutcome, READ_ONLY_KINDS, readOnly } from "../src/backends/read-only.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { hook } from "../src/hooks/wake.js";
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

const requests = (): any[] => (existsSync(agyLog) ? readFileSync(agyLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const cwdFor = (name: string) => {
  const d = join(root, "cwd", name);
  mkdirSync(d, { recursive: true });
  return d;
};
const transcript = (id: string): any[] => readFileSync(readState(id)!.transcript!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cleanup: string[] = [];
after(() => {
  for (const id of cleanup) stopSession(id, false);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const start = (name: string, prompt: string, extra: string[] = []) => {
  const id = startSupervisor(cwdFor(name), ["--name", name, ...extra, "--prompt", prompt], process.env, 20_000);
  cleanup.push(id);
  return id;
};

test("the read-only list is read, search and think, and nothing else is allowed", () => {
  assert.deepEqual([...READ_ONLY_KINDS], ["read", "search", "think"]);
  const opts = [
    { optionId: "a1", kind: "allow_always" },
    { optionId: "a", kind: "allow_once" },
    { optionId: "r", kind: "reject_once" },
    { optionId: "r2", kind: "reject_always" },
  ];
  for (const k of READ_ONLY_KINDS) assert.deepEqual(permissionOutcome(k, opts), { outcome: "selected", optionId: "a" }, k);
  // every other ACP ToolKind, a kind left out, and one not in the protocol
  for (const k of ["edit", "delete", "move", "execute", "fetch", "switch_mode", "other", undefined, null, "READ", "write"]) {
    assert.equal(readOnly(k), false, String(k));
    assert.deepEqual(permissionOutcome(k, opts), { outcome: "selected", optionId: "r" }, String(k));
  }
  assert.deepEqual(permissionOutcome("edit", [{ optionId: "r2", kind: "reject_always" }]), { outcome: "selected", optionId: "r2" });
  // never an allow-always, and nothing to pick is cancelled
  assert.deepEqual(permissionOutcome("read", [{ optionId: "a1", kind: "allow_always" }]), { outcome: "cancelled" });
  assert.deepEqual(permissionOutcome("edit", [{ optionId: "a", kind: "allow_once" }]), { outcome: "cancelled" });
  assert.deepEqual(permissionOutcome("read", "junk"), { outcome: "cancelled" });
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

test("backend = \"antigravity\" loads, and takes no host", () => {
  const ws = tempWorkspace(TOML.replace('name = "rae"\nrole = "reviewer"\n', 'name = "rae"\nrole = "reviewer"\nbackend = "antigravity"\n'));
  after(() => rmSync(ws, { recursive: true, force: true }));
  const c = loadConfig(join(ws, "factory.toml"), {});
  const rae = c.agents.find((a) => a.name === "rae")!;
  assert.equal(rae.backend, "antigravity");
  assert.equal(backendFor(rae), antigravityBackend);
  const hosted = tempWorkspace(TOML.replace('name = "rae"\nrole = "reviewer"\n', 'name = "rae"\nrole = "reviewer"\nbackend = "antigravity"\nhost = "far"\ncwd = "/far/rae"\n') +
    '\n[hosts.far]\nssh = "far"\nurl = "http://far:1"\ntoken_file = "t"\n');
  after(() => rmSync(hosted, { recursive: true, force: true }));
  assert.throws(() => loadConfig(join(hosted, "factory.toml"), {}), (e: unknown) => e instanceof ConfigError && e.problems.some((p) => /rae runs under antigravity, which runs on this machine only/.test(p)));
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
  const sets = requests().filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value]);
  assert.deepEqual(sets, [["model", "gemini-pro"], ["thinking", "extra"]]);
  // the brief went in as a system-prompt addition, and the prompt as it is
  const created = requests().find((r) => r.method === "session/new");
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

test("a session that agy starts in a mode that approves edits is put back in its default mode", async () => {
  process.env.FAKE_AGY_MODE = "accept-edits";
  try {
    const id = start("moded", "hi");
    await until("idle", () => readState(id)?.state === "done");
    const sets = requests().filter((r) => r.method === "session/set_config_option" && r.params.sessionId === readState(id)!.sessionId);
    assert.deepEqual(sets.map((r) => [r.params.configId, r.params.value]), [["mode", "default"]]);
  } finally {
    delete process.env.FAKE_AGY_MODE;
  }
});

test("a tool that is not read-only and runs without asking ends the session as failed", async () => {
  const id = start("rogue", "hi");
  await until("idle", () => readState(id)?.state === "done");
  antigravityBackend.deliver!(listSessions().find((s) => s.id === id)!, "rogue");
  await until("the session to fail", () => readState(id)?.state === "failed");
  assert.match(readState(id)!.error!, /not read-only \(execute, call-\d+\) without asking/);
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
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: join(dir, "lead"), tool_name: "SendMessage", tool_input: { to: "vega", message: "read notes.md" } });
  const r = hook(["--wait-seconds", "20"], input, dir);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout!).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /^Delivered: vega runs on antigravity.*after a fresh start/);
  const s = listSessions().find((x) => x.name === "vega" && sessionAlive(x))!;
  cleanup.push(s.id!);
  await until("the message to be answered", () => transcript(s.id!).some((l) => l.type === "assistant" && l.message.content[0].text === "read ok"));
  const asked = transcript(s.id!).filter((l) => l.type === "user" && l.message.content[0].type === "text").map((l) => l.message.content[0].text);
  assert.equal(asked.length, 2);
  assert.equal(asked[1], "Message from ada:\n\nread notes.md");
  void ws;
});
