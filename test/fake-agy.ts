// A stand-in for `agy acp`: an ACP v1 agent over stdio that acts on what each prompt says.
// Its tool calls go as agy 1.5's do: reported in_progress, then pending while it asks, then
// in_progress again and completed or failed; a read runs without asking, as agy's do. Its
// requests to the client carry string ids, as agy's do.
//   "read <x>"   a read tool call, put to the client for permission; runs if allowed
//   "quiet <x>"  a read tool call that runs without asking
//   "edit <x>"   an edit tool call, put to the client; runs if allowed, else fails
//   "rogue"      an execute tool call that runs without asking
//   "rogue-fail" an execute tool call that runs without asking and fails
//   "morph"      a read tool call, put to the client, whose kind turns to edit once it is allowed
//   "unmorph"    an edit tool call, put to the client, that reports itself read and completed
//                once denied
//   "ask-as-read" an edit tool call put to the client as a read
//   "stubborn"   starts a tool process that ignores SIGTERM (its pid logged as {tool}), then an
//                execute tool call that runs without asking
//   "mode <m>"   moves the session to mode m and says so with a config_option_update (or a
//                current_mode_update under FAKE_AGY_LEGACY_MODES)
//   "slow"       a turn that takes 1.5 s
//   anything     answered "echo: <text>"
// FAKE_AGY_LOG names a file each request it gets is appended to, as JSON lines. FAKE_AGY_AUTH=0
// answers every session method "Authentication required". FAKE_AGY_NO_SYSTEM=1 leaves out the
// system-prompt capability. FAKE_AGY_MODE is the mode a session starts in. FAKE_AGY_LEGACY_MODES=1
// reports the mode in the older modes field, set with session/set_mode, and not as a config
// option. FAKE_AGY_MODE_STUCK=1 refuses every change of mode. FAKE_AGY_IGNORE_EOF=1 keeps running
// once stdin closes, as an agy that ignores it would.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const logFile = process.env.FAKE_AGY_LOG;
const record = (m: unknown) => logFile && appendFileSync(logFile, JSON.stringify(m) + "\n");
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
let next = 1;
const waiting = new Map<string, (r: any) => void>();
const ask = (method: string, params: unknown) =>
  new Promise<any>((res) => {
    const id = String(next++);
    waiting.set(id, res);
    send({ jsonrpc: "2.0", id, method, params });
  });
const update = (sessionId: string, u: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const OPTIONS = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Deny", kind: "reject_once" },
];
let calls = 0;

async function tool(sessionId: string, kind: string, title: string, asked = true, ends: "completed" | "failed" = "completed", turnsInto?: string): Promise<boolean> {
  const toolCallId = `call-${++calls}`;
  update(sessionId, { sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress", rawInput: { title } });
  if (!asked) {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: ends, rawOutput: ends === "failed" ? "exit 1" : "done" });
    return true;
  }
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, kind, status: "pending" });
  const r = await ask("session/request_permission", { sessionId, toolCall: { toolCallId, title, kind, status: "pending" }, options: OPTIONS });
  const ok = r?.outcome?.outcome === "selected" && String(r.outcome.optionId).startsWith("allow");
  record({ permission: { kind, outcome: r?.outcome } });
  if (ok) {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", ...(turnsInto ? { kind: turnsInto } : {}) });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: `${title}: ok` });
  } else {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: "denied" });
  }
  return ok;
}

async function prompt(p: any): Promise<unknown> {
  const sid = p.sessionId as string;
  const text = (p.prompt ?? []).map((b: any) => b.text ?? "").join("");
  const last = text.split("\n").pop() ?? "";
  if (last.startsWith("read ")) say(sid, (await tool(sid, "read", last)) ? "read ok" : "read denied");
  else if (last.startsWith("edit ")) say(sid, (await tool(sid, "edit", last)) ? "edit ok" : "edit denied");
  else if (last.startsWith("quiet ")) say(sid, (await tool(sid, "read", last, false)) ? "quiet ok" : "");
  else if (last === "rogue") await tool(sid, "execute", "rm -rf /tmp/x", false);
  else if (last === "rogue-fail") await tool(sid, "execute", "git push && npm test", false, "failed");
  else if (last === "morph") await tool(sid, "read", "README.md", true, "completed", "edit");
  else if (last === "unmorph") {
    const toolCallId = `call-${++calls}`;
    update(sid, { sessionUpdate: "tool_call", toolCallId, title: "write x", kind: "edit", status: "pending" });
    await ask("session/request_permission", { sessionId: sid, toolCall: { toolCallId, title: "write x", kind: "edit", status: "pending" }, options: OPTIONS });
    update(sid, { sessionUpdate: "tool_call_update", toolCallId, kind: "read", status: "completed", rawOutput: "written" });
  } else if (last === "ask-as-read") {
    const toolCallId = `call-${++calls}`;
    update(sid, { sessionUpdate: "tool_call", toolCallId, title: "write x", kind: "edit", status: "pending" });
    const r = await ask("session/request_permission", { sessionId: sid, toolCall: { toolCallId, title: "write x", kind: "read", status: "pending" }, options: OPTIONS });
    record({ permission: { kind: "read", outcome: r?.outcome } });
    update(sid, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: "denied" });
    say(sid, "asked as read");
  } else if (last === "stubborn") {
    const t = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1<<30)"], { stdio: "ignore" });
    record({ tool: t.pid });
    await new Promise((r) => setTimeout(r, 300));
    await tool(sid, "execute", "make -j8", false);
  }
  else if (last.startsWith("mode ")) {
    mode = last.slice(5);
    if (legacy) update(sid, { sessionUpdate: "current_mode_update", currentModeId: mode });
    else update(sid, { sessionUpdate: "config_option_update", configOptions: config() });
    say(sid, `mode ${mode}`);
  }
  else if (last === "slow") await new Promise((r) => setTimeout(r, 1500));
  else say(sid, `echo: ${last}`);
  return { stopReason: "end_turn" };
}

const legacy = process.env.FAKE_AGY_LEGACY_MODES === "1";
const stuck = process.env.FAKE_AGY_MODE_STUCK === "1";
const MODES = ["default", "accept-edits", "auto", "plan"];
let mode = process.env.FAKE_AGY_MODE ?? "default";
const config = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-flash", options: [{ value: "gemini-flash", name: "Gemini Flash" }, { value: "gemini-pro", name: "Gemini Pro" }] },
  { id: "thinking", name: "Thinking level", category: "thought_level", type: "select", currentValue: "medium", options: ["low", "medium", "high", "extra", "max"].map((v) => ({ value: v, name: v[0]!.toUpperCase() + v.slice(1) })) },
  ...(legacy ? [] : [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode, options: MODES.map((value) => ({ value })) }]),
];
const modes = () => (legacy ? { modes: { currentModeId: mode, availableModes: MODES.map((id) => ({ id, name: id })) } } : {});
const setMode = (m: unknown) => {
  if (stuck) throw new Error("the mode cannot be changed");
  mode = String(m);
};

async function handle(m: any): Promise<unknown> {
  const authed = process.env.FAKE_AGY_AUTH !== "0";
  switch (m.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, ...(process.env.FAKE_AGY_NO_SYSTEM === "1" ? {} : { _meta: { antigravity: { systemPrompt: { append: true } } } }) },
        agentInfo: { name: "Fake ACP", version: "0" },
        authMethods: [],
      };
    case "session/new":
    case "session/resume":
    case "session/load":
      if (!authed) throw Object.assign(new Error("Authentication required"), { code: -32000 });
      return { ...(m.method === "session/new" ? { sessionId: `sess-${process.pid}` } : {}), configOptions: config(), ...modes() };
    case "session/set_config_option":
      if (m.params?.configId === "mode") setMode(m.params.value);
      return { configOptions: config() };
    case "session/set_mode":
      if (!legacy) throw Object.assign(new Error("method not found: session/set_mode"), { code: -32601 });
      setMode(m.params?.modeId);
      return {};
    case "session/prompt":
      return prompt(m.params);
    case "session/close":
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0;) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
      continue;
    }
    record({ method: m.method, params: m.params });
    if (m.id === undefined) continue;
    handle(m).then(
      (result) => send({ jsonrpc: "2.0", id: m.id, result }),
      (e: any) => send({ jsonrpc: "2.0", id: m.id, error: { code: e.code ?? -32603, message: e.message } }),
    );
  }
});
process.stdin.on("end", () => {
  if (process.env.FAKE_AGY_IGNORE_EOF === "1") setInterval(() => {}, 1 << 30);
  else process.exit(0);
});
