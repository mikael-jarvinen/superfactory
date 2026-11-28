// A Claude agent's deny rules, safety hooks and MCP servers, from its rendered settings and MCP
// config, applied to agy's tool calls: by agy's own PreToolUse hook (`factory hook agy`) before
// every call, asked or not, and by the supervisor's permission handler for every call that asks.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hook as guardHook, tokenize } from "../hooks/guard.js";
import { hook as markedCommentsHook } from "../hooks/marked-comments.js";
import { hook as noDialogsHook } from "../hooks/no-dialogs.js";
import { hook as noSideChannelsHook } from "../hooks/no-side-channels.js";
import { factoryCommand, type HookResult } from "../settings.js";
import { readOnly } from "./read-only.js";

type HookFn = (argv: string[], input: string, workspace?: string) => HookResult;
// The hooks that refuse a call. wake and status are Claude's messaging and board plumbing.
const SAFETY: Record<string, HookFn> = {
  "guard": guardHook, "no-dialogs": noDialogsHook, "no-side-channels": noSideChannelsHook, "marked-comments": markedCommentsHook,
};

export interface ClaudeCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// An MCP server's name as agy writes it in a tool's name, `mcp_<server>_<tool>`.
const mcpKey = (server: string) => server.replace(/[^A-Za-z0-9]/g, "_");

// agy's call as the Claude tool that does the same; a refusal when the call cannot be held to the
// rules Claude's would be; or null when there is no Claude counterpart. By name and arguments, as
// agy's hook gets no kind. agy 1.5.19's tools, from its own listing: run_command {CommandLine},
// write_file {Path, Content}, edit_file {Path, Target, Replacement}, read_file {Path}, search_web
// {query}, list_resources {ServerName}, read_resource {ServerName, Uri}, and each MCP tool as
// mcp_<server>_<tool> with the tool's own arguments and a toolSummary. It has no move, rename,
// delete or URL-reading tool; a move moves by run_command, where the guard judges both paths.
export function claudeCall(name: string, args: Record<string, unknown>, mcp: readonly string[] = []): ClaudeCall | { refused: string } | null {
  const command = str(args.CommandLine) ?? str(args.Command);
  if (command !== null) return { tool_name: "Bash", tool_input: { command } };
  if (name === "ask_question") return { tool_name: "AskUserQuestion", tool_input: args };
  if (name === "search_web") return { tool_name: "WebSearch", tool_input: { query: args.query } };
  const server = str(args.ServerName);
  if (name === "list_resources" || name === "read_resource") {
    if (server === null || !mcp.includes(server)) return { refused: `${name} on ${server ?? "no server"}, which is not an MCP server ${given(mcp)}` };
    return name === "list_resources" ? { tool_name: "ListMcpResourcesTool", tool_input: { server } } : { tool_name: "ReadMcpResourceTool", tool_input: { server, uri: args.Uri } };
  }
  if (name.startsWith("mcp_")) {
    const s = mcp.filter((m) => name.startsWith(`mcp_${mcpKey(m)}_`)).sort((a, b) => b.length - a.length)[0];
    if (s === undefined) return { refused: `${name} is not a tool of an MCP server ${given(mcp)}` };
    const { toolSummary: _, ...input } = args;
    return { tool_name: `mcp__${s}__${name.slice(`mcp_${mcpKey(s)}_`.length)}`, tool_input: input };
  }
  if (/fetch|url/.test(name)) {
    const url = str(args.Url) ?? str(args.url) ?? str(args.URL);
    return url === null ? { refused: `${name} names no URL to check` } : { tool_name: "WebFetch", tool_input: { url, prompt: "" } };
  }
  // the guard judges a move by its source and its destination; agy has no such tool to name the
  // destination argument of, so one that comes is refused
  if (/move|rename/.test(name)) return { refused: `${name} moves a file, and its destination cannot be named to check` };
  const path = str(args.Path) ?? str(args.AbsolutePath) ?? str(args.TargetFile) ?? str(args.FilePath) ?? str(args.File) ?? str(args.SearchPath) ?? str(args.DirectoryPath);
  if (path === null) return null;
  if (/write|create/.test(name)) return { tool_name: "Write", tool_input: { file_path: path, content: args.Content } };
  if (/edit|replace|patch|delete|remove/.test(name)) return { tool_name: "Edit", tool_input: { file_path: path } };
  if (/grep|search/.test(name)) return { tool_name: "Grep", tool_input: { path, glob: str(args.Includes) ?? undefined, output_mode: "content" } };
  if (/read|view/.test(name)) return { tool_name: "Read", tool_input: { file_path: path } };
  return null;
}

const given = (mcp: readonly string[]) => `this role is given${mcp.length ? ` (${mcp.join(", ")})` : ": it is given none"}`;

// The servers of a Claude --mcp-config file, which a session of the role is given.
export function mcpServerNames(file: string | undefined): string[] {
  if (!file) return [];
  const v = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
  return Object.keys(v.mcpServers ?? {});
}

interface Hook {
  matcher: RegExp;
  name: string;
  argv: string[];
  workspace?: string;
}

export interface Rules {
  file: string;
  deny: string[];
  hooks: Hook[];
  // the MCP servers the session is given
  mcp: string[];
}

export function loadRules(file: string, mcpConfig?: string): Rules {
  const s = JSON.parse(readFileSync(file, "utf8")) as { permissions?: { deny?: unknown }; hooks?: { PreToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] } };
  const deny = Array.isArray(s.permissions?.deny) ? s.permissions.deny.filter((r): r is string => typeof r === "string") : [];
  const hooks: Hook[] = [];
  for (const g of s.hooks?.PreToolUse ?? [])
    for (const h of g.hooks ?? []) {
      const w = tokenize(h.command ?? "").map((t) => t.t);
      const at = w.indexOf("hook");
      const name = w[at + 1];
      if (at < 0 || !name || !(name in SAFETY)) continue;
      const ws = w.indexOf("--workspace");
      const m = g.matcher ?? "";
      hooks.push({ matcher: new RegExp(m === "" || m === "*" ? ".*" : `^(?:${m})$`), name, argv: w.slice(at + 2), ...(ws >= 0 && ws < at ? { workspace: w[ws + 1] } : {}) });
    }
  return { file, deny, hooks, mcp: mcpServerNames(mcpConfig) };
}

const SEPARATOR = /^[;&|()]+$/;

// The commands of a line, at the shell's control operators and inside $(...) and backticks, as
// Claude matches a Bash rule against each command of a line; null for a line that cannot be parsed.
function commands(line: string): string[] | null {
  let toks;
  try {
    toks = tokenize(line);
  } catch {
    return null;
  }
  const out: string[] = [];
  let cur: string[] = [];
  let tick = false;
  const end = (): boolean => {
    const c = cur.join(" ");
    if (c) out.push(c);
    if (tick) for (const m of c.matchAll(/`([^`]*)`/g)) {
      const inner = commands(m[1] as string);
      if (inner === null) return false;
      out.push(...inner);
    }
    [cur, tick] = [[], false];
    return true;
  };
  for (const t of toks) {
    if (t.op && SEPARATOR.test(t.t)) {
      if (!end()) return null;
      continue;
    }
    cur.push(t.t);
    tick ||= !!t.tick;
    for (const s of t.subs ?? []) {
      const inner = commands(s);
      if (inner === null) return null;
      out.push(...inner);
    }
  }
  return end() ? out : null;
}

const globRe = (g: string, star: string) => g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*/g, (m) => (m === "*" ? star : ".*"));

function bashRule(spec: string, command: string): boolean {
  // `x:*` is the older prefix form; `x *` matches x alone too
  const pat = spec.endsWith(":*") ? `${spec.slice(0, -2)} *` : spec;
  const re = new RegExp(`^${globRe(pat, ".*").replace(/ \.\*$/, "(?: .*)?")}$`, "s");
  // a line that cannot be parsed is refused, as the guard refuses it
  return commands(command)?.some((c) => re.test(c)) ?? true;
}

function pathRule(spec: string, file: string, base: string): boolean {
  const abs = spec.startsWith("//") ? spec.slice(1) : spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : resolve(base, spec.replace(/^\//, ""));
  return new RegExp(`^${globRe(abs, "[^/]*")}$`).test(file);
}

// The deny rule that refuses the call, or null. Claude holds Write to the Edit rules too.
function denied(rules: Rules, call: ClaudeCall, cwd: string): string | null {
  const tool = call.tool_name === "Write" ? "Edit" : call.tool_name;
  const file = str(call.tool_input.file_path) ?? str(call.tool_input.path);
  for (const r of rules.deny) {
    const m = /^([\w-]+)(?:\((.*)\))?$/s.exec(r);
    if (!m) continue;
    const [, name, spec] = m as unknown as [string, string, string | undefined];
    if (name !== call.tool_name && name !== tool && !(name === "Read" && tool === "Grep")) continue;
    if (spec === undefined || spec === "*") return r;
    if (name === "Bash" && bashRule(spec, String(call.tool_input.command))) return r;
    if (name !== "Bash" && file && pathRule(spec, resolve(cwd, file), dirname(rules.file))) return r;
  }
  return null;
}

// Why the rules refuse the call, or null when they let it through. A hook that fails in any way
// but a pass refuses: Claude lets a hook's crash through, and here that would be a hole.
export function check(rules: Rules, call: ClaudeCall, cwd: string, projectDir: string): string | null {
  const rule = denied(rules, call, cwd);
  if (rule) return `${rules.file} denies it: ${rule}`;
  const input = JSON.stringify({ ...call, hook_event_name: "PreToolUse", cwd });
  // the guard reads relative paths against the cwd, and finds its workspace from the project dir
  const here = process.cwd();
  const before = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.chdir(cwd);
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    for (const h of rules.hooks) {
      if (!h.matcher.test(call.tool_name)) continue;
      let r: HookResult;
      try {
        r = (SAFETY[h.name] as HookFn)(h.argv, input, h.workspace);
      } catch (e) {
        return `the ${h.name} hook failed: ${(e as Error).message}`;
      }
      const out = r.stdout ? (() => { try { return JSON.parse(r.stdout) as any; } catch { return null; } })() : null;
      if (out?.hookSpecificOutput?.permissionDecision === "deny") return String(out.hookSpecificOutput.permissionDecisionReason ?? `the ${h.name} hook refused it`);
      if (r.code !== 0) return (r.stderr ?? "").trim() || `the ${h.name} hook refused it (exit ${r.code})`;
    }
  } finally {
    process.chdir(here);
    if (before === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = before;
  }
  return null;
}

const art = (k: string) => `${/^[aeiou]/.test(k) ? "an" : "a"} ${k}`;
const isMcp = (t: string) => t.startsWith("mcp__") || t === "ListMcpResourcesTool" || t === "ReadMcpResourceTool";
// The Claude tools a call of each ACP kind may be, as rules can judge it; a kind with none listed
// is refused. A read-only kind that names nothing is let through.
const KIND_TOOLS: Record<string, (t: string) => boolean> = {
  edit: (t) => t === "Write" || t === "Edit",
  delete: (t) => t === "Edit",
  execute: (t) => t === "Bash",
  fetch: (t) => t === "WebFetch" || t === "WebSearch",
  other: (t) => isMcp(t) || t === "AskUserQuestion",
  read: (t) => t === "Read" || t === "Grep" || isMcp(t),
  search: (t) => t === "Grep" || t === "WebSearch" || isMcp(t),
};

// Why the rules refuse an ACP call that asks, or null. The supervisor's permission handler.
export function ruling(rules: Rules, kind: unknown, input: { name: string; args: Record<string, unknown> } | undefined, cwd: string): string | null {
  const call = input ? claudeCall(input.name, input.args, rules.mcp) : null;
  if (call && "refused" in call) return call.refused;
  const k = String(kind ?? "no kind");
  if (k === "move") return "a move call, whose destination agy names in no argument the rules can check";
  const fits = KIND_TOOLS[k];
  if (!fits) return `${art(k)} call, which the rules have nothing for`;
  if (!call) return readOnly(kind) ? null : `${art(k)} call that names nothing the rules can check`;
  if (!fits(call.tool_name)) return `${art(k)} call that agy names ${input!.name}, which the rules have nothing for`;
  return check(rules, call, cwd, cwd);
}

export const RULES_ENV = "SF_AGY_RULES";
export const PROJECT_ENV = "SF_AGY_PROJECT";
export const MCP_ENV = "SF_AGY_MCP";
export const HOOK_LOG_ENV = "SF_AGY_HOOK_LOG";

// What `factory hook agy` decided, a JSON line by agy's tool call id, for the supervisor's tripwire.
export interface HookDecision {
  id: string;
  name: string;
  decision: "deny" | "pass";
  reason?: string;
}

export function hookDecisions(file: string): Map<string, HookDecision> {
  const out = new Map<string, HookDecision>();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const l of text.split("\n")) {
    try {
      const d = JSON.parse(l) as HookDecision;
      if (typeof d?.id === "string" && d.id) out.set(d.id, d);
    } catch {}
  }
  return out;
}

// agy's PreToolUse hook, `factory hook agy`, run on every call before it runs, asked or not.
// Neutral outside a superfactory session, and on a call with no Claude counterpart, which the
// supervisor's tripwire then sees. stdin is {toolCall: {id, name, args}, cwd, ...}; stdout is
// {decision, reason}.
export function agyHook(_argv: string[], input: string): HookResult {
  const file = process.env[RULES_ENV];
  if (!file) return { code: 0 };
  let ev: { toolCall?: { id?: unknown; name?: unknown; args?: unknown }; cwd?: unknown } = {};
  const decide = (decision: "deny" | "pass", reason?: string): HookResult => {
    const log = process.env[HOOK_LOG_ENV];
    if (log) {
      const d: HookDecision = { id: String(ev?.toolCall?.id ?? ""), name: String(ev?.toolCall?.name ?? ""), decision, ...(reason ? { reason } : {}) };
      try {
        appendFileSync(log, JSON.stringify(d) + "\n");
      } catch {}
    }
    return decision === "deny" ? { code: 0, stdout: JSON.stringify({ decision: "deny", reason: `superfactory: ${reason}` }) + "\n" } : { code: 0 };
  };
  try {
    ev = JSON.parse(input);
  } catch {
    return decide("deny", "the hook input was not JSON");
  }
  if (typeof ev !== "object" || ev === null) return decide("deny", "the hook input was not a JSON object");
  const name = String(ev.toolCall?.name ?? "");
  const args = (ev.toolCall?.args && typeof ev.toolCall.args === "object" ? ev.toolCall.args : {}) as Record<string, unknown>;
  let rules: Rules;
  try {
    rules = loadRules(file, process.env[MCP_ENV] || undefined);
  } catch (e) {
    return decide("deny", `the session's rules could not be read: ${(e as Error).message}`);
  }
  const call = claudeCall(name, args, rules.mcp);
  if (!call) return decide("pass");
  if ("refused" in call) return decide("deny", call.refused);
  const project = process.env[PROJECT_ENV] || (typeof ev.cwd === "string" ? ev.cwd : process.cwd());
  const why = check(rules, call, typeof ev.cwd === "string" && ev.cwd ? ev.cwd : project, project);
  return why ? decide("deny", why) : decide("pass");
}

// agy's global hooks file, and the entry that runs agyHook. The shell test keeps node out of
// every tool call of an agy session that is not superfactory's.
export const agyHooksFile = () => process.env.SF_AGY_HOOKS || join(homedir(), ".gemini", "config", "hooks.json");
const HOOK_KEY = "superfactory-guard";
const hookEntry = () => ({
  PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `[ -z "$${RULES_ENV}" ] || exec ${factoryCommand()} hook agy`, timeout: 30 }] }],
});

// Throws rather than overwrite a hooks file that is not a JSON object.
export function ensureAgyHook(): string {
  const file = agyHooksFile();
  let cur: Record<string, unknown> = {};
  if (existsSync(file)) {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
    cur = v as Record<string, unknown>;
  }
  const want = hookEntry();
  if (JSON.stringify(cur[HOOK_KEY]) === JSON.stringify(want)) return file;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...cur, [HOOK_KEY]: want }, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

// Why agy would not run agyHook, or null. Any factory's entry will do: each reads the rules from
// the file RULES_ENV names, so two factories on one machine need not agree on whose it is.
export function agyHookMissing(): string | null {
  const file = agyHooksFile();
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    const e = v?.[HOOK_KEY];
    const g = Array.isArray(e?.PreToolUse) && e.PreToolUse.length === 1 ? e.PreToolUse[0] : null;
    if (!e || e.enabled === false || !g) return `${file} has no enabled ${HOOK_KEY} entry`;
    const cmd = Array.isArray(g.hooks) && g.hooks.length === 1 ? g.hooks[0]?.command : null;
    return g.matcher === "*" && typeof cmd === "string" && / hook agy$/.test(cmd) ? null : `${file}'s ${HOOK_KEY} entry is not one that runs \`factory hook agy\` on every call`;
  } catch (e) {
    return `${file} cannot be read: ${(e as Error).message}`;
  }
}
