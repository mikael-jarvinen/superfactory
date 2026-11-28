// The supervisor of one Antigravity session. `agy acp` is an ACP server over stdio that lives only
// as long as whoever holds its pipes, so AntigravityBackend.start (antigravity.ts) runs this as a
// detached process of its own, which outlives the `factory` command that started it. It:
//
//   - starts `agy acp` in the session's cwd, sets up a session (session/new, or session/resume or
//     session/load of an earlier one with --load) and sets its model and thinking level;
//   - sends the first prompt, then each message put in its inbox (agy-store.ts), one prompt at a
//     time, as session/prompt;
//   - keeps state.json: "working" while a prompt is in flight, "done" between prompts;
//   - answers session/request_permission from read-only.ts: a read-only call is allowed once,
//     every other one is denied;
//   - writes the transcript (agy-store.ts's transcriptFile) and every ACP message (acp.jsonl);
//   - ends the session on SIGTERM, and marks it failed when agy exits on its own, when agy runs a
//     tool that is not read-only without asking, or when the setup fails.
//
// Usage: node agy-supervisor.js --id <id> [--add-dir <dir>]... [--model <m>] [--effort <e>]
//          [--appendix <file>] [--mcp-config <file>] [--load <session id>] --name <name> --prompt <text>
// It runs in the session's cwd.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { AcpError, AcpPeer, PROTOCOL_VERSION } from "./acp.js";
import { agyBin, agySettingsFile, type AgyState, inboxDir, sessionDir, transcriptFile, validId, writeJson } from "./agy-store.js";
import { permissionOutcome, readOnly } from "./read-only.js";
import { startStamp } from "../stacks/process.js";

export interface SupervisorSpec {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  addDirs: string[];
  model?: string;
  effort?: string;
  appendix?: string;
  mcpConfig?: string;
  load?: string;
}

export function parseSpec(argv: string[], cwd: string): SupervisorSpec {
  const v = parseArgs({
    args: argv,
    options: {
      id: { type: "string" }, name: { type: "string" }, prompt: { type: "string" }, "add-dir": { type: "string", multiple: true },
      model: { type: "string" }, effort: { type: "string" }, appendix: { type: "string" }, "mcp-config": { type: "string" }, load: { type: "string" },
    },
    strict: true,
  }).values;
  if (!validId(v.id)) throw new Error(`--id must be agy- and 12 hex digits, got ${String(v.id)}`);
  if (!v.name) throw new Error("--name is required");
  if (v.prompt === undefined) throw new Error("--prompt is required");
  return {
    id: v.id, name: v.name, cwd, prompt: v.prompt, addDirs: v["add-dir"] ?? [],
    ...(v.model ? { model: v.model } : {}), ...(v.effort ? { effort: v.effort } : {}),
    ...(v.appendix ? { appendix: v.appendix } : {}), ...(v["mcp-config"] ? { mcpConfig: v["mcp-config"] } : {}),
    ...(v.load ? { load: v.load } : {}),
  };
}

// What in agy's own settings would let a tool run without a permission request reaching the
// supervisor, or null for none. A request that never comes is one the handler cannot deny.
export function unsafeSettings(text: string | null): string | null {
  if (text === null || !text.trim()) return null;
  let s: any;
  try {
    s = JSON.parse(text);
  } catch {
    return "it is not JSON, so what it allows cannot be told";
  }
  if (!s || typeof s !== "object") return null;
  if (["always-proceed", "proceed-in-sandbox"].includes(s.toolPermission)) return `toolPermission is ${JSON.stringify(s.toolPermission)}`;
  if (["auto", "accept-edits"].includes(s.agentMode)) return `agentMode is ${JSON.stringify(s.agentMode)}`;
  const allow = s.permissions?.allow;
  if (Array.isArray(allow) && allow.length) return `permissions.allow has rules (${allow.map(String).join(", ")})`;
  return null;
}

// Claude's --mcp-config file ({mcpServers: {name: {command, args, env}}}) as ACP's stdio servers.
export function mcpServers(text: string | null): unknown[] {
  if (!text) return [];
  const servers = (JSON.parse(text) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> }).mcpServers ?? {};
  return Object.entries(servers)
    .filter(([, s]) => typeof s.command === "string")
    .map(([name, s]) => ({ name, command: s.command, args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([n, value]) => ({ name: n, value })) }));
}

// ACP's session config options, and the older models and modes fields some agents send instead.
interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: ({ value: string; name?: string } | { group?: string; options: { value: string; name?: string }[] })[];
}

const flat = (o: ConfigOption) =>
  (o.options ?? []).flatMap((x) => ("value" in x ? [x] : (x.options ?? [])));

const EFFORT_WORDS: Record<string, string[]> = { xhigh: ["xhigh", "extra"], max: ["max"], high: ["high"], medium: ["medium"], low: ["low"] };

// The value of an option that names `want`: its value or its name, case aside; an effort also by
// another word for it ("Extra" is Antigravity's name for xhigh).
export function pickValue(o: ConfigOption, want: string): string | null {
  const words = (EFFORT_WORDS[want.toLowerCase()] ?? [want.toLowerCase()]);
  const hit = flat(o).find((x) => words.includes(x.value.toLowerCase()) || words.includes((x.name ?? "").toLowerCase()));
  return hit?.value ?? null;
}

export const optionFor = (opts: ConfigOption[], category: string, ids: RegExp) =>
  opts.find((o) => o.category === category) ?? opts.find((o) => ids.test(o.id));

const iso = () => new Date().toISOString();

export async function supervise(spec: SupervisorSpec): Promise<number> {
  const dir = sessionDir(spec.id);
  mkdirSync(inboxDir(spec.id), { recursive: true });
  writeJson(join(dir, "spec.json"), spec);
  const st: AgyState = {
    id: spec.id, name: spec.name, kind: "background", backend: "antigravity", state: "starting", status: "busy", cwd: spec.cwd,
    pid: process.pid, stamp: startStamp(process.pid), agentPid: null, sessionId: null, model: spec.model ?? null, transcript: null,
    startedAt: Date.now(), updatedAt: iso(),
  };
  const save = (patch: Partial<AgyState> = {}) => {
    Object.assign(st, patch, { updatedAt: iso() });
    writeJson(join(dir, "state.json"), st);
  };
  const log = (s: string) => console.log(`${iso()} ${s}`);
  save();

  let child: ChildProcess | null = null;
  let stopping = false;
  let ended = false;
  let resolveEnd: (code: number) => void = () => {};
  const end = new Promise<number>((r) => (resolveEnd = r));
  const finish = (patch: Partial<AgyState>, code: number) => {
    if (ended) return;
    ended = true;
    save({ status: "off", ...patch });
    log(`ended: ${patch.state}${patch.error ? `: ${patch.error}` : ""}`);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const k = setTimeout(() => child?.kill("SIGKILL"), 5000);
      k.unref();
    }
    resolveEnd(code);
  };
  const fail = (why: string) => finish({ state: "failed", error: why }, 1);

  let settings: string | null = null;
  try {
    settings = readFileSync(agySettingsFile(), "utf8");
  } catch {
    settings = null;
  }
  const unsafe = unsafeSettings(settings);
  if (unsafe) {
    fail(`${agySettingsFile()} lets tools run without asking: ${unsafe}. An Antigravity session runs only with every tool call put to its supervisor.`);
    return end;
  }

  const args = ["acp", "--log-file", join(dir, "agy.log"), ...spec.addDirs.flatMap((d) => ["--add-dir", d])];
  log(`starting ${agyBin()} ${args.join(" ")} in ${spec.cwd}`);
  child = spawn(agyBin(), args, { cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
  child.on("error", (e) => fail(`agy could not start: ${e.message}`));
  child.stderr?.on("data", (d) => process.stdout.write(`agy: ${d}`));
  child.on("exit", (code, sig) => {
    if (stopping) finish({ state: "stopped" }, 0);
    else fail(`agy exited on its own (${sig ?? `code ${code}`})`);
  });
  save({ agentPid: child.pid ?? null });

  const acpLog = join(dir, "acp.jsonl");
  const peer = new AcpPeer(child.stdin!, child.stdout!, (d, line) => appendFileSync(acpLog, `{"at":"${iso()}","dir":"${d}","m":${line}}\n`));

  // The transcript, and the assistant text of the turn so far.
  let transcript: string | null = null;
  let said = "";
  let msgN = 0;
  const line = (row: Record<string, unknown>) => {
    if (transcript) appendFileSync(transcript, JSON.stringify({ ...row, timestamp: iso(), sessionId: st.sessionId, cwd: spec.cwd }) + "\n");
  };
  const flushSaid = () => {
    if (!said) return;
    line({ type: "assistant", message: { id: `${st.sessionId}:${++msgN}`, role: "assistant", model: st.model, content: [{ type: "text", text: said }] } });
    said = "";
  };

  // Tool calls by id: the kind the agent gave, and whether the supervisor allowed it.
  const calls = new Map<string, { kind: unknown; allowed: boolean }>();
  peer.handle("session/request_permission", (p: any) => {
    const tc = p?.toolCall ?? {};
    const id = String(tc.toolCallId ?? "");
    const kind = tc.kind ?? calls.get(id)?.kind;
    const outcome = permissionOutcome(kind, p?.options);
    const allowed = outcome.outcome === "selected" && readOnly(kind);
    calls.set(id, { kind, allowed });
    log(`permission ${allowed ? "allowed" : "denied"}: ${String(kind)} ${JSON.stringify(tc.title ?? "")}`);
    line({ type: "permission", toolCallId: id, kind, title: tc.title ?? null, allowed });
    return { outcome };
  });
  // No client capability is offered for these, so they should not come; each is refused.
  for (const m of ["fs/read_text_file", "fs/write_text_file", "terminal/create"])
    peer.handle(m, () => {
      throw new Error(`${m} is not offered by this client`);
    });

  peer.on("session/update", (p: any) => {
    const u = p?.update ?? {};
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") said += u.content.text;
        break;
      case "tool_call": {
        flushSaid();
        const id = String(u.toolCallId ?? "");
        const prev = calls.get(id);
        calls.set(id, { kind: u.kind ?? prev?.kind, allowed: prev?.allowed ?? false });
        line({ type: "assistant", message: { id: `${st.sessionId}:${++msgN}`, role: "assistant", model: st.model, content: [{ type: "tool_use", id, name: u.title ?? u.kind ?? "tool", kind: u.kind ?? null, input: u.rawInput ?? null }] } });
        ranUnasked(id, u.status);
        break;
      }
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        const prev = calls.get(id);
        if (u.kind !== undefined) calls.set(id, { kind: u.kind, allowed: prev?.allowed ?? false });
        ranUnasked(id, u.status);
        if (u.status === "completed" || u.status === "failed")
          line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: u.status === "failed", content: u.rawOutput ?? u.content ?? null }] } });
        break;
      }
    }
  });
  // A call that is not read-only, that the supervisor did not allow, and that completes anyway was
  // run without a permission request: the session cannot be kept read-only, so it ends. agy
  // reports a call in_progress before it asks and again after a denial, which ends it failed, so
  // only completion counts.
  const ranUnasked = (id: string, status: unknown) => {
    if (status !== "completed") return;
    const c = calls.get(id);
    if (c && (c.allowed || readOnly(c.kind))) return;
    fail(`agy ran a tool call that is not read-only (${String(c?.kind ?? "no kind")}, ${id}) without asking; it would have been denied`);
  };

  process.on("SIGTERM", () => {
    if (ended) return;
    stopping = true;
    log("SIGTERM: ending the session");
    if (st.sessionId && busy) peer.notify("session/cancel", { sessionId: st.sessionId });
    setTimeout(() => {
      if (child && child.exitCode === null) child.kill("SIGTERM");
    }, busy ? 2000 : 0).unref();
    setTimeout(() => child?.kill("SIGKILL"), 10_000).unref();
  });

  let busy = false;
  const queue: string[] = [];
  const takeInbox = (): string | null => {
    if (queue.length) return queue.shift()!;
    let names: string[] = [];
    try {
      names = readdirSync(inboxDir(spec.id)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return null;
    }
    for (const n of names) {
      const f = join(inboxDir(spec.id), n);
      try {
        const m = JSON.parse(readFileSync(f, "utf8")) as { text?: unknown };
        rmSync(f, { force: true });
        if (typeof m.text === "string" && m.text) return m.text;
      } catch {
        rmSync(f, { force: true });
      }
    }
    return null;
  };
  const pump = async (): Promise<void> => {
    if (busy || ended || stopping) return;
    const text = takeInbox();
    if (text === null) return;
    busy = true;
    save({ state: "working", status: "busy" });
    line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    try {
      const r = await peer.request<{ stopReason?: string; usage?: unknown }>("session/prompt", { sessionId: st.sessionId, prompt: [{ type: "text", text }] });
      flushSaid();
      line({ type: "turn-end", stopReason: r?.stopReason ?? null, ...(r?.usage ? { usage: r.usage } : {}) });
    } catch (e) {
      flushSaid();
      if (ended) return;
      log(`prompt failed: ${(e as Error).message}`);
      line({ type: "turn-end", stopReason: "error", error: (e as Error).message });
    }
    busy = false;
    if (ended) return;
    save({ state: "done", status: "idle" });
    void pump();
  };

  try {
    const init = await peer.request<any>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "superfactory", version: "0" },
    });
    if (init?.protocolVersion !== PROTOCOL_VERSION) throw new Error(`agy speaks ACP ${String(init?.protocolVersion)}, not ${PROTOCOL_VERSION}`);
    const caps = init.agentCapabilities ?? {};
    let mcp: unknown[] = [];
    if (spec.mcpConfig) mcp = mcpServers(readFileSync(spec.mcpConfig, "utf8"));
    const brief = spec.appendix ? readFileSync(spec.appendix, "utf8") : null;
    // A brief goes in as an addition to the system prompt where agy offers one, else ahead of the first prompt.
    const viaSystem = !!brief && caps._meta?.antigravity?.systemPrompt?.append === true;
    const meta = viaSystem ? { _meta: { antigravity: { systemPrompt: { append: brief } } } } : {};
    let setup: any;
    if (spec.load) {
      const resume = !!caps.sessionCapabilities?.resume;
      if (!resume && !caps.loadSession) throw new Error("agy offers neither session/resume nor session/load");
      setup = await peer.request(resume ? "session/resume" : "session/load", { sessionId: spec.load, cwd: spec.cwd, mcpServers: mcp, ...meta });
      st.sessionId = spec.load;
    } else {
      setup = await peer.request("session/new", { cwd: spec.cwd, mcpServers: mcp, ...meta });
      if (typeof setup?.sessionId !== "string") throw new Error("session/new gave no sessionId");
      st.sessionId = setup.sessionId;
    }
    const opts: ConfigOption[] = Array.isArray(setup?.configOptions) ? setup.configOptions : [];
    const set = async (what: "model" | "effort", want: string, category: string, ids: RegExp) => {
      const o = optionFor(opts, category, ids);
      if (o) {
        const value = pickValue(o, want);
        if (!value) throw new Error(`no ${what} ${want}: agy offers ${flat(o).map((x) => x.value).join(", ")}`);
        await peer.request("session/set_config_option", { sessionId: st.sessionId, configId: o.id, value });
        return value;
      }
      const models = setup?.models?.availableModels;
      if (what === "model" && Array.isArray(models)) {
        const hit = models.find((m: any) => [m.modelId, m.name].some((x) => typeof x === "string" && x.toLowerCase() === want.toLowerCase()));
        if (!hit) throw new Error(`no model ${want}: agy offers ${models.map((m: any) => m.modelId).join(", ")}`);
        await peer.request("session/set_model", { sessionId: st.sessionId, modelId: hit.modelId });
        return hit.modelId as string;
      }
      throw new Error(`agy offers no ${what} setting, so ${what} ${want} cannot be set`);
    };
    // agy's modes other than "default" and "plan" approve edits or commands without asking.
    const mode = optionFor(opts, "mode", /^mode$/);
    if (mode && !["default", "plan"].includes(String(mode.currentValue))) {
      if (!flat(mode).some((x) => x.value === "default")) throw new Error(`agy is in mode ${String(mode.currentValue)} and offers no "default" mode`);
      await peer.request("session/set_config_option", { sessionId: st.sessionId, configId: mode.id, value: "default" });
    }
    if (spec.model) st.model = await set("model", spec.model, "model", /model/i);
    if (spec.effort) await set("effort", spec.effort, "thought_level", /think|effort|reason/i);
    transcript = transcriptFile(spec.cwd, st.sessionId!);
    mkdirSync(dirname(transcript), { recursive: true });
    appendFileSync(transcript, JSON.stringify({ type: "agent-name", agentName: spec.name, sessionId: st.sessionId }) + "\n");
    save({ transcript, model: st.model });
    log(`session ${st.sessionId}${spec.load ? " (loaded)" : ""}, transcript ${transcript}`);
    queue.push(brief && !viaSystem ? `${brief.trimEnd()}\n\n---\n\n${spec.prompt}` : spec.prompt);
  } catch (e) {
    const m = e instanceof AcpError && e.code === -32000 ? `${e.message}: agy is not logged in (agy acp --login)` : (e as Error).message;
    fail(`setup failed: ${m}`);
    return end;
  }

  watch(inboxDir(spec.id), () => void pump()).on("error", () => {});
  setInterval(() => void pump(), 2000).unref();
  void pump();
  const keep = setInterval(() => {}, 1 << 30);
  const code = await end;
  clearInterval(keep);
  return code;
}

// Run as a program: node agy-supervisor.js <args>.
if (process.argv[1] && /agy-supervisor\.js$/.test(process.argv[1])) {
  let spec: SupervisorSpec;
  try {
    spec = parseSpec(process.argv.slice(2), process.cwd());
  } catch (e) {
    console.error(`agy-supervisor: ${(e as Error).message}`);
    process.exit(2);
  }
  process.on("uncaughtException", (e) => {
    console.error(`agy-supervisor: ${e.stack ?? e.message}`);
    process.exit(1);
  });
  void supervise(spec).then((code) => setTimeout(() => process.exit(code), 200));
}
