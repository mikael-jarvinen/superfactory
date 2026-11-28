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
//   - holds the session in agy's "default" mode, the one that asks before edits and commands, and
//     re-reads agy's settings before each prompt;
//   - writes the transcript (agy-store.ts's transcriptFile) and every ACP message (acp.jsonl);
//   - ends the session on SIGTERM, and marks it failed when agy exits on its own, when agy runs a
//     tool that is not read-only without asking, when the mode cannot be held, when the setup
//     fails, or when the supervisor itself crashes, killing agy and its tools first;
//   - leaves any message that never went to agy in the inbox, named in state.json's undelivered.
//
// Usage: node agy-supervisor.js --id <id> [--add-dir <dir>]... [--model <m>] [--effort <e>]
//          [--appendix <file>] [--mcp-config <file>] [--load <session id>] --name <name> --prompt <text>
// It runs in the session's cwd.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { AcpError, AcpPeer, PROTOCOL_VERSION } from "./acp.js";
import { agyBin, agySettingsFile, type AgyState, enqueue, FIRST_PROMPT, inboxDir, sessionDir, transcriptFile, validId, writeJson } from "./agy-store.js";
import { permissionOutcome, readOnly } from "./read-only.js";
import { killTree, startStamp } from "../stacks/process.js";

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

// agy's settings file, read again before every prompt: null for none.
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

// What a tool call's updates say of it: whether the supervisor ends the session over it, and why.
// A call that is not read-only trips it when it ends, completed or failed, without ever having been
// put to the supervisor, or completes after it was denied; and so does an allowed read-only call
// whose kind is later changed to one that is not. Fails closed: a call with no kind is not read-only.
// A call announced with no kind takes the first kind it gives later, asked or in an update; from
// then on its kind only gets stricter (stricterKind), so a call once seen as not read-only stays so.
// agy 1.5.19, seen live: every tool_call it announces carries its kind (a read as "read", an edit as
// "edit"), and its permission requests and updates repeat that same kind, so the adoption is for an
// agy that does otherwise. A call that ends while it still has no kind is not read-only.
export interface CallSeen {
  kind: unknown;
  asked: boolean;
  allowed: boolean;
}

// The kind a call is held to, from the one seen before and one it now gives (undefined when it gives
// none): the first kind a kind-less call gives, then the stricter of the two, so a kind seen as not
// read-only, announced or asked, is kept.
export function stricterKind(before: unknown, now: unknown, seenBefore: boolean): unknown {
  if (!seenBefore || before === undefined) return now;
  if (now === undefined || !readOnly(before)) return before;
  return now;
}

export function tripped(c: CallSeen, status: unknown, kindChanged: boolean): string | null {
  if (readOnly(c.kind)) return null;
  if (c.allowed && kindChanged) return `changed its kind to ${String(c.kind)} after it was allowed as read-only`;
  if (status !== "completed" && status !== "failed") return null;
  if (!c.asked) return `${status === "completed" ? "ran" : "ran and failed"} without asking`;
  if (!c.allowed && status === "completed") return "ran after it was denied";
  return null;
}

// The only mode the session may be in: agy's "default" asks before edits and commands. "plan",
// "accept-edits" and "auto" are put back.
export const HELD_MODE = "default";

// The mode a session reports, from its config options or the older modes field, or undefined.
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
  // Everything in the supervisor's process group but the supervisor: agy, which is spawned in it,
  // and every tool agy runs, reparented or not. The supervisor leads the group (spawnDetached).
  const killGroup = (graceMs: number) => killTree(process.pid, graceMs);
  let stopping = false;
  let ended = false;
  let resolveEnd: (code: number) => void = () => {};
  const end = new Promise<number>((r) => (resolveEnd = r));
  const finish = (patch: Partial<AgyState>, code: number) => {
    if (ended) return;
    ended = true;
    save({ status: "off", ...patch, ...undelivered() });
    log(`ended: ${patch.state}${patch.error ? `: ${patch.error}` : ""}`);
    // agy and every tool it runs, alive or not: a tool agy left behind when it exited is still in
    // the group. SIGKILL for whatever outlives the grace; this waits for that before the supervisor
    // exits.
    if (!killGroup(5000)) log("agy or one of its tools survived SIGKILL");
    resolveEnd(code);
  };
  const fail = (why: string) => finish({ state: "failed", error: why }, 1);

  // The messages a session ends with that never went to agy: each stays in the inbox, the first
  // prompt is put there too, and state.json names them (undelivered), so none is lost unsaid.
  const queue: string[] = [];
  const inboxNames = (): string[] => {
    try {
      return readdirSync(inboxDir(spec.id)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }
  };
  // Written with the session's end, in the same save, so a reader that sees it ended sees these.
  function undelivered(): { undelivered?: string[] } {
    try {
      for (const text of queue.splice(0)) enqueue(spec.id, text, FIRST_PROMPT);
      const left = inboxNames();
      if (!left.length) return {};
      log(`${left.length} message(s) not delivered, left in the inbox: ${left.join(", ")}`);
      return { undelivered: left };
    } catch (e) {
      log(`the undelivered messages could not be recorded: ${(e as Error).message}`);
      return {};
    }
  }

  // A crash kills agy and its tools and says so, so no agy outlives a supervisor with no record.
  // Registered here, where the session it cleans up is in scope, as SIGTERM's handler is below.
  process.on("uncaughtException", (e) => {
    console.error(`agy-supervisor: ${e.stack ?? e.message}`);
    try {
      killGroup(1000);
      if (!ended) {
        ended = true;
        save({ state: "failed", status: "off", error: `the supervisor crashed: ${e.message}`, ...undelivered() });
      }
    } catch (ce) {
      console.error(`agy-supervisor: and the crash could not be cleaned up: ${(ce as Error).message}`);
    }
    process.exit(1);
  });

  const unsafe = unsafeNow();
  if (unsafe) {
    fail(unsafe);
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
  save({ agentPid: child.pid ?? null, agentStamp: child.pid === undefined ? null : startStamp(child.pid) });

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

  // Tool calls by id: the strictest kind the agent gave it, whether it was put to the supervisor,
  // and whether the supervisor allowed it.
  const calls = new Map<string, CallSeen>();
  peer.handle("session/request_permission", (p: any) => {
    const tc = p?.toolCall ?? {};
    const id = String(tc.toolCallId ?? "");
    const prev = calls.get(id);
    // asked as read-only, a call announced as not read-only is still held to its announced kind
    const kind = stricterKind(prev?.kind, tc.kind, prev !== undefined);
    const outcome = permissionOutcome(kind, p?.options);
    const allowed = outcome.outcome === "selected" && readOnly(kind);
    calls.set(id, { kind, asked: true, allowed });
    log(`permission ${allowed ? "allowed" : "denied"}: ${String(kind)} ${JSON.stringify(tc.title ?? "")}`);
    line({ type: "permission", toolCallId: id, kind, title: tc.title ?? null, allowed });
    return { outcome };
  });
  // No client capability is offered for these, so they should not come; each is refused.
  for (const m of ["fs/read_text_file", "fs/write_text_file", "terminal/create"])
    peer.handle(m, () => {
      throw new Error(`${m} is not offered by this client`);
    });

  // A tool call's update: its kind, if it gives one, is held to the stricter (stricterKind), and the tripwire (tripped)
  // ends the session over a call that ran without the supervisor's leave. agy reports a call
  // in_progress before it asks and again after a denial, so only an end counts as having run.
  const seen = (id: string, kind: unknown, status: unknown) => {
    const prev = calls.get(id);
    const c: CallSeen = { kind: stricterKind(prev?.kind, kind, prev !== undefined), asked: prev?.asked ?? false, allowed: prev?.allowed ?? false };
    calls.set(id, c);
    const why = tripped(c, status, prev !== undefined && c.kind !== prev.kind);
    if (why) fail(`agy's tool call ${id} (${String(c.kind ?? "no kind")}) is not read-only and ${why}; the session cannot be kept read-only`);
  };

  // The mode, held at default: a change agy reports is put back, and one that cannot be is the end
  // of the session. A prompt waits for the mode to be put back before it goes.
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
        seen(id, u.kind, u.status);
        break;
      }
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        seen(id, u.kind, u.status);
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

  // A stop: the turn in flight is cancelled, and finish ends the session, its group with it.
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
    if (queue.length) return { text: queue.shift()! };
    for (const n of inboxNames()) {
      const f = join(inboxDir(spec.id), n);
      try {
        const m = JSON.parse(readFileSync(f, "utf8")) as { text?: unknown };
        if (typeof m.text === "string" && m.text) return { text: m.text, file: f };
      } catch {
        // a file that is not a message is no message
      }
      rmSync(f, { force: true });
    }
    return null;
  };
  const pump = async (): Promise<void> => {
    if (busy || ended || stopping) return;
    if (!queue.length && !inboxNames().length) return;
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
    // agy's modes other than "default" approve edits or commands without asking, or ("plan") are
    // not the mode it was asked for. A session that reports no mode is held through its updates.
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
  void supervise(spec).then((code) => setTimeout(() => process.exit(code), 200));
}
