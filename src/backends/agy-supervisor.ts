// The supervisor of one Antigravity session. `agy acp` lives only as long as whoever holds its
// pipes, so AntigravityBackend.start runs this detached, to outlive the `factory` command. It holds
// the session in agy's "default" mode, allows only the calls the rules allow, and on any end kills
// every process in its systemd scope, tools that left agy's session included. A message that never
// reached agy stays in the inbox, named in state.json's undelivered. It runs in the session's cwd.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { AcpError, AcpPeer, PROTOCOL_VERSION } from "./acp.js";
import { agyBin, agySettingsFile, type AgyState, enqueue, FIRST_PROMPT, inbox, inboxDir, scopeUnit, sessionCgroup, sessionDir, transcriptFile, validId, writeJson } from "./agy-store.js";
import { agyHookMissing, loadRules, PROJECT_ENV, type Rules, ruling, RULES_ENV } from "./agy-guard.js";
import { permissionOutcome, readOnly } from "./read-only.js";
import { cgroupProcs, currentBoot, killAllAsync, killTreeAsync, ownCgroup, startStamp } from "../stacks/process.js";

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
  // the agent's rendered settings, whose rules agy's calls are held to; without it only read-only calls pass
  settings?: string;
}

export function parseSpec(argv: string[], cwd: string): SupervisorSpec {
  const v = parseArgs({
    args: argv,
    options: {
      id: { type: "string" }, name: { type: "string" }, prompt: { type: "string" }, "add-dir": { type: "string", multiple: true },
      model: { type: "string" }, effort: { type: "string" }, appendix: { type: "string" }, "mcp-config": { type: "string" }, load: { type: "string" },
      settings: { type: "string" },
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
    ...(v.load ? { load: v.load } : {}), ...(v.settings ? { settings: v.settings } : {}),
  };
}

function readSettings(): string | null {
  try {
    return readFileSync(agySettingsFile(), "utf8");
  } catch {
    return null;
  }
}

const unsafeNow = (): string | null => {
  const u = unsafeSettings(readSettings());
  return u && `${agySettingsFile()} lets tools run without asking: ${u}. An Antigravity session runs only with every tool call put to its supervisor.`;
};

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

export interface CallSeen {
  kind: unknown;
  asked: boolean;
  allowed: boolean;
  input?: { name: string; args: Record<string, unknown> };
}

// The kind a call is held to: a kind-less call not yet asked takes the first kind it gives; after
// that only the stricter, so a call once seen as not read-only, or asked with no kind, cannot pass
// off a later "read". agy 1.5.19 always repeats one kind; this is for an agy that does not.
export function stricterKind(prev: CallSeen | undefined, now: unknown): unknown {
  if (!prev || (prev.kind === undefined && !prev.asked)) return now;
  if (now === undefined || !readOnly(prev.kind)) return prev.kind;
  return now;
}

// A failed call that agy stopped before it ran: denied by its PreToolUse hook (agy-guard.ts), or
// dropped beside a call the supervisor denied, which agy reports failed with an empty output.
export const neverRan = (output: unknown): boolean =>
  (typeof output === "string" && output.startsWith("tool call denied")) ||
  (!!output && typeof output === "object" && (output as { output?: unknown }).output === "");

// Why the session ends over a call, or null. One that is not read-only trips it by ending without
// being asked, or completing after a denial; an allowed read-only call, by changing its kind.
// Fails closed: a call with no kind is not read-only.
export function tripped(c: CallSeen, status: unknown, kindChanged: boolean, output?: unknown): string | null {
  if (readOnly(c.kind)) return null;
  if (c.allowed && kindChanged) return `changed its kind to ${String(c.kind)} after it was allowed as read-only`;
  if (status !== "completed" && status !== "failed") return null;
  if (!c.asked && status === "failed" && neverRan(output)) return null;
  if (!c.asked) return `${status === "completed" ? "ran" : "ran and failed"} without asking`;
  if (!c.allowed && status === "completed") return "ran after it was denied";
  return null;
}

// The only mode the session may be in: agy's others approve edits or commands without asking, or
// ("plan") are not the mode asked for.
export const HELD_MODE = "default";

export function modeOf(opts: unknown, modes: unknown): { current: unknown; offersDefault: boolean; via: "config"; id: string } | { current: unknown; offersDefault: boolean; via: "modes" } | undefined {
  const o = Array.isArray(opts) ? optionFor(opts as ConfigOption[], "mode", /^mode$/) : undefined;
  if (o) return { current: o.currentValue, offersDefault: flat(o).some((x) => x.value === HELD_MODE), via: "config", id: o.id };
  const m = modes as { currentModeId?: unknown; availableModes?: { id?: unknown }[] } | null | undefined;
  if (m && typeof m === "object" && "currentModeId" in m)
    return { current: m.currentModeId, offersDefault: Array.isArray(m.availableModes) && m.availableModes.some((x) => x?.id === HELD_MODE), via: "modes" };
  return undefined;
}

export async function supervise(spec: SupervisorSpec): Promise<number> {
  const dir = sessionDir(spec.id);
  mkdirSync(inboxDir(spec.id), { recursive: true });
  writeJson(join(dir, "spec.json"), spec);
  // Every process agy starts stays in the scope's cgroup whatever its parent, group or session, so
  // that is what an end kills; without a scope, the supervisor's process group.
  const cg = ownCgroup();
  const cgroup = sessionCgroup(spec.id, cg) ? cg : null;
  const st: AgyState = {
    id: spec.id, name: spec.name, kind: "background", backend: "antigravity", state: "starting", status: "busy", cwd: spec.cwd,
    pid: process.pid, stamp: startStamp(process.pid), boot: currentBoot(), cgroup, agentPid: null, sessionId: null, model: spec.model ?? null, transcript: null,
    startedAt: Date.now(), updatedAt: iso(),
  };
  const save = (patch: Partial<AgyState> = {}) => {
    Object.assign(st, patch, { updatedAt: iso() });
    writeJson(join(dir, "state.json"), st);
  };
  const log = (s: string) => console.log(`${iso()} ${s}`);
  save();
  if (!cgroup) log(`not in the scope ${scopeUnit(spec.id)}.scope (cgroup ${cg ?? "none"}): an end kills the supervisor's process group, and a tool that leaves it is out of reach`);

  let child: ChildProcess | null = null;
  // Resolved once agy has exited and Node has reaped it, or at once when it never started.
  let agyExited: Promise<void> = Promise.resolve();
  // Kills everything in the session but the supervisor. Async, so Node reaps agy while it waits and
  // no zombie is waited on. Returns the pids still living after the KILL.
  const killSession = async (graceMs: number): Promise<number[]> => {
    const left = cgroup ? await killAllAsync(() => cgroupProcs(cgroup), graceMs) : await killTreeAsync(process.pid, graceMs);
    await Promise.race([agyExited, new Promise((r) => setTimeout(r, 1000))]);
    return left;
  };
  let stopping = false;
  let ended = false;
  let resolveEnd: (code: number) => void = () => {};
  const end = new Promise<number>((r) => (resolveEnd = r));
  const finish = (patch: Partial<AgyState>, code: number) => {
    if (ended) return;
    ended = true;
    save({ status: "off", ...patch, ...undelivered() });
    log(`ended: ${patch.state}${patch.error ? `: ${patch.error}` : ""}`);
    void killSession(5000).then(
      (left) => {
        if (left.length) log(`still running after SIGKILL: ${left.join(", ")}`);
        resolveEnd(code);
      },
      (e) => {
        log(`the session's processes could not all be killed: ${(e as Error).message}`);
        resolveEnd(code);
      },
    );
  };
  const fail = (why: string) => finish({ state: "failed", error: why }, 1);

  // Messages not yet in the inbox (the first prompt); an end puts them there, so none is lost unsaid.
  const queue: { text: string; from: string }[] = [];
  // Written in the same save as the end, so a reader that sees it ended sees these.
  function undelivered(): { undelivered?: string[] } {
    try {
      for (const m of queue.splice(0)) enqueue(spec.id, m.text, m.from);
      const left = inbox(spec.id).map((m) => m.file);
      if (!left.length) return {};
      log(`${left.length} message(s) not delivered, left in the inbox: ${left.join(", ")}`);
      return { undelivered: left };
    } catch (e) {
      log(`the undelivered messages could not be recorded: ${(e as Error).message}`);
      return {};
    }
  }

  let crashing = false;
  // A crash kills agy and its tools and says so, so no agy outlives a supervisor with no record.
  process.on("uncaughtException", (e) => {
    console.error(`agy-supervisor: ${e.stack ?? e.message}`);
    try {
      if (!ended) {
        ended = true;
        save({ state: "failed", status: "off", error: `the supervisor crashed: ${e.message}`, ...undelivered() });
      }
    } catch (ce) {
      console.error(`agy-supervisor: and the crash could not be recorded: ${(ce as Error).message}`);
    }
    // a second crash while this runs exits at once; stopSession then kills what is left by the scope
    if (crashing) process.exit(1);
    crashing = true;
    void killSession(1000).catch(() => []).then((left) => {
      if (left.length) console.error(`agy-supervisor: still running after SIGKILL: ${left.join(", ")}`);
      process.exit(1);
    });
  });

  const unsafe = unsafeNow();
  if (unsafe) {
    fail(unsafe);
    return end;
  }
  let rules: Rules | null = null;
  if (spec.settings) {
    try {
      rules = loadRules(spec.settings);
    } catch (e) {
      fail(`the session's settings ${spec.settings} cannot be read: ${(e as Error).message}`);
      return end;
    }
    // reads inside the workspace never ask, so only agy's hook holds them to the rules
    const missing = agyHookMissing();
    if (missing) {
      fail(`${missing}, so agy's reads would go unchecked; a launch writes it (agy-guard.ts ensureAgyHook)`);
      return end;
    }
  }

  const args = ["acp", "--log-file", join(dir, "agy.log"), ...spec.addDirs.flatMap((d) => ["--add-dir", d])];
  log(`starting ${agyBin()} ${args.join(" ")} in ${spec.cwd}`);
  const env = rules ? { ...process.env, [RULES_ENV]: rules.file, [PROJECT_ENV]: spec.cwd } : process.env;
  child = spawn(agyBin(), args, { cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], env });
  child.on("error", (e) => fail(`agy could not start: ${e.message}`));
  child.stderr?.on("data", (d) => process.stdout.write(`agy: ${d}`));
  agyExited = new Promise((r) => child!.once("exit", () => r()));
  child.on("exit", (code, sig) => {
    if (stopping) finish({ state: "stopped" }, 0);
    else fail(`agy exited on its own (${sig ?? `code ${code}`})`);
  });
  save({ agentPid: child.pid ?? null, agentStamp: child.pid === undefined ? null : startStamp(child.pid) });

  const acpLog = join(dir, "acp.jsonl");
  const peer = new AcpPeer(child.stdin!, child.stdout!, (d, line) => appendFileSync(acpLog, `{"at":"${iso()}","dir":"${d}","m":${line}}\n`));

  let transcript: string | null = null;
  // the assistant text of the turn so far
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

  const calls = new Map<string, CallSeen>();
  peer.handle("session/request_permission", (p: any) => {
    const tc = p?.toolCall ?? {};
    const id = String(tc.toolCallId ?? "");
    const prev = calls.get(id);
    const kind = stricterKind(prev, tc.kind);
    const input = tc.rawInput && typeof tc.rawInput === "object" ? { name: String(tc.name ?? prev?.input?.name ?? tc.title ?? ""), args: tc.rawInput } : prev?.input;
    const refusal = rules ? ruling(rules, kind, input, spec.cwd) : readOnly(kind) ? null : "it is not read-only, and the session has no rules to hold it to";
    const outcome = permissionOutcome(refusal === null, p?.options);
    const allowed = outcome.outcome === "selected" && refusal === null;
    calls.set(id, { kind, asked: true, allowed, ...(input ? { input } : {}) });
    log(`permission ${allowed ? "allowed" : "denied"}: ${String(kind)} ${JSON.stringify(tc.title ?? "")}${refusal ? `: ${refusal}` : ""}`);
    line({ type: "permission", toolCallId: id, kind, title: tc.title ?? null, allowed, ...(refusal ? { reason: refusal } : {}) });
    return { outcome };
  });
  // No client capability is offered for these, so they should not come; each is refused.
  for (const m of ["fs/read_text_file", "fs/write_text_file", "terminal/create"])
    peer.handle(m, () => {
      throw new Error(`${m} is not offered by this client`);
    });

  // agy reports a call in_progress before it asks and again after a denial, so only an end counts
  // as having run (tripped).
  const seen = (id: string, kind: unknown, status: unknown, output?: unknown) => {
    const prev = calls.get(id);
    const c: CallSeen = { kind: stricterKind(prev, kind), asked: prev?.asked ?? false, allowed: prev?.allowed ?? false, ...(prev?.input ? { input: prev.input } : {}) };
    calls.set(id, c);
    const why = tripped(c, status, prev !== undefined && c.kind !== prev.kind, output);
    if (why) fail(`agy's tool call ${id} (${String(c.kind ?? "no kind")}) is not read-only and ${why}; the session cannot be kept read-only`);
  };

  // A prompt waits for the mode to be put back before it goes.
  let modeVia: { via: "config"; id: string } | { via: "modes" } | null = null;
  let holding: Promise<void> = Promise.resolve();
  const setDefault = async (): Promise<void> => {
    if (!modeVia) throw new Error("agy reports no way to set the mode");
    if (modeVia.via === "config") await peer.request("session/set_config_option", { sessionId: st.sessionId, configId: modeVia.id, value: HELD_MODE });
    else await peer.request("session/set_mode", { sessionId: st.sessionId, modeId: HELD_MODE });
  };
  const hold = (m: ReturnType<typeof modeOf>) => {
    if (!m || m.current === HELD_MODE || ended) return;
    if (m.via === "config") modeVia = { via: "config", id: m.id };
    else modeVia ??= { via: "modes" };
    log(`agy moved the session to mode ${String(m.current)}; setting it back to ${HELD_MODE}`);
    holding = holding.then(setDefault).catch((e) => fail(`agy moved the session to mode ${String(m.current)}, and it could not be set back to ${HELD_MODE}: ${(e as Error).message}`));
  };

  peer.on("session/update", (p: any) => {
    const u = p?.update ?? {};
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") said += u.content.text;
        break;
      case "tool_call": {
        flushSaid();
        const id = String(u.toolCallId ?? "");
        line({ type: "assistant", message: { id: `${st.sessionId}:${++msgN}`, role: "assistant", model: st.model, content: [{ type: "tool_use", id, name: u.title ?? u.kind ?? "tool", kind: u.kind ?? null, input: u.rawInput ?? null }] } });
        seen(id, u.kind, u.status, u.rawOutput);
        if (u.rawInput && typeof u.rawInput === "object") calls.get(id)!.input = { name: String(u.name ?? u.title ?? ""), args: u.rawInput };
        break;
      }
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        seen(id, u.kind, u.status, u.rawOutput);
        if (u.status === "completed" || u.status === "failed")
          line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: u.status === "failed", content: u.rawOutput ?? u.content ?? null }] } });
        break;
      }
      case "current_mode_update":
        hold({ current: u.currentModeId, offersDefault: true, via: "modes" });
        break;
      case "config_option_update":
        hold(modeOf(u.configOptions, undefined));
        break;
    }
  });

  process.on("SIGTERM", () => {
    if (ended || stopping) return;
    stopping = true;
    log("SIGTERM: ending the session");
    if (st.sessionId && busy) peer.notify("session/cancel", { sessionId: st.sessionId });
    setTimeout(() => finish({ state: "stopped" }, 0), busy ? 2000 : 0).unref();
  });

  let busy = false;
  // The next message and its inbox file, which is removed only once its user line is written, so
  // a crash before then leaves it in the inbox.
  const takeInbox = (): { text: string; file?: string } | null => {
    if (queue.length) return { text: queue.shift()!.text };
    const m = inbox(spec.id)[0];
    return m ? { text: m.text, file: join(inboxDir(spec.id), m.file) } : null;
  };
  const pump = async (): Promise<void> => {
    if (busy || ended || stopping) return;
    if (!queue.length && !inbox(spec.id).length) return;
    // Both checks come before a message leaves the inbox, so a session they end keeps it there.
    busy = true;
    await holding;
    if (ended || stopping) {
      busy = false;
      return;
    }
    const unsafe = unsafeNow();
    if (unsafe) return fail(unsafe);
    const next = takeInbox();
    if (next === null) {
      busy = false;
      return;
    }
    const { text } = next;
    save({ state: "working", status: "busy" });
    line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    if (next.file) rmSync(next.file, { force: true });
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
    // The agy that runs is the only list of its models: factory.toml's model is checked here.
    const offered = (what: string, want: string, on: string[]) =>
      `${spec.name}'s ${what} ${JSON.stringify(want)} is not one this agy offers; it offers ${on.join(", ")}. Set ${what} in factory.toml to one of them`;
    const set = async (what: "model" | "effort", want: string, category: string, ids: RegExp) => {
      const o = optionFor(opts, category, ids);
      if (o) {
        const value = pickValue(o, want);
        if (!value) throw new Error(offered(what, want, flat(o).map((x) => (x.name && x.name !== x.value ? `${x.value} (${x.name})` : x.value))));
        await peer.request("session/set_config_option", { sessionId: st.sessionId, configId: o.id, value });
        return value;
      }
      const models = setup?.models?.availableModels;
      if (what === "model" && Array.isArray(models)) {
        const hit = models.find((m: any) => [m.modelId, m.name].some((x) => typeof x === "string" && x.toLowerCase() === want.toLowerCase()));
        if (!hit) throw new Error(offered(what, want, models.map((m: any) => String(m.modelId))));
        await peer.request("session/set_model", { sessionId: st.sessionId, modelId: hit.modelId });
        return hit.modelId as string;
      }
      throw new Error(`${spec.name}'s ${what} ${JSON.stringify(want)} cannot be set: this agy offers no ${what} setting. Take ${what} out of ${spec.name}'s entry in factory.toml`);
    };
    // A session that reports no mode is held through its updates.
    const mode = modeOf(setup?.configOptions, setup?.modes);
    if (mode) modeVia = mode.via === "config" ? { via: "config", id: mode.id } : { via: "modes" };
    if (mode && mode.current !== HELD_MODE) {
      if (!mode.offersDefault) throw new Error(`agy is in mode ${String(mode.current)} and offers no "${HELD_MODE}" mode`);
      await setDefault();
    }
    if (spec.model) st.model = await set("model", spec.model, "model", /model/i);
    if (spec.effort) await set("effort", spec.effort, "thought_level", /think|effort|reason/i);
    transcript = transcriptFile(spec.cwd, st.sessionId!);
    mkdirSync(dirname(transcript), { recursive: true });
    appendFileSync(transcript, JSON.stringify({ type: "agent-name", agentName: spec.name, sessionId: st.sessionId }) + "\n");
    save({ transcript, model: st.model });
    log(`session ${st.sessionId}${spec.load ? " (loaded)" : ""}, transcript ${transcript}`);
    queue.push({ text: brief && !viaSystem ? `${brief.trimEnd()}\n\n---\n\n${spec.prompt}` : spec.prompt, from: FIRST_PROMPT });
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

if (process.argv[1] && /agy-supervisor\.js$/.test(process.argv[1])) {
  let spec: SupervisorSpec;
  try {
    spec = parseSpec(process.argv.slice(2), process.cwd());
  } catch (e) {
    console.error(`agy-supervisor: ${(e as Error).message}`);
    process.exit(2);
  }
  void supervise(spec).then((code) => setTimeout(() => process.exit(code), 200));
}
