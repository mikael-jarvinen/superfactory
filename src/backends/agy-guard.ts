// A Claude agent's deny rules and safety hooks, from its rendered settings, applied to agy's tool
// calls. The supervisor's permission handler uses it for every call that asks, and agy's own
// PreToolUse hook (`factory hook agy`) for the reads inside the workspace, which never ask.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hook as guardHook } from "../hooks/guard.js";
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

// agy's call as the Claude tool that does the same, or null when there is none. By name and
// arguments, as agy's hook gets no kind: run_command {CommandLine}, write_file {Path, Content},
// edit_file {Path, Target, Replacement}, read_file {Path}.
export function claudeCall(name: string, args: Record<string, unknown>): ClaudeCall | null {
  const command = str(args.CommandLine) ?? str(args.Command);
  if (command !== null) return { tool_name: "Bash", tool_input: { command } };
  if (name === "ask_question") return { tool_name: "AskUserQuestion", tool_input: args };
  const path = str(args.Path) ?? str(args.AbsolutePath) ?? str(args.TargetFile) ?? str(args.FilePath) ?? str(args.File) ?? str(args.SearchPath) ?? str(args.DirectoryPath);
  if (path === null) return null;
  if (/write|create/.test(name)) return { tool_name: "Write", tool_input: { file_path: path, content: args.Content } };
  if (/edit|replace|patch|delete|move|rename/.test(name)) return { tool_name: "Edit", tool_input: { file_path: path } };
  if (/grep|search/.test(name)) return { tool_name: "Grep", tool_input: { path, glob: str(args.Includes) ?? undefined, output_mode: "content" } };
  if (/read|view/.test(name)) return { tool_name: "Read", tool_input: { file_path: path } };
  return null;
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
}

// A rendered hook command: `<node> <cli.js> [--workspace <dir>] hook <name> <args...>`, quoted by shq.
function words(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replaceAll(`'\\''`, "'") : (m[2] as string));
  return out;
}

export function loadRules(file: string): Rules {
  const s = JSON.parse(readFileSync(file, "utf8")) as { permissions?: { deny?: unknown }; hooks?: { PreToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] } };
  const deny = Array.isArray(s.permissions?.deny) ? s.permissions.deny.filter((r): r is string => typeof r === "string") : [];
  const hooks: Hook[] = [];
  for (const g of s.hooks?.PreToolUse ?? [])
    for (const h of g.hooks ?? []) {
      const w = words(h.command ?? "");
      const at = w.indexOf("hook");
      const name = w[at + 1];
      if (at < 0 || !name || !(name in SAFETY)) continue;
      const ws = w.indexOf("--workspace");
      const m = g.matcher ?? "";
      hooks.push({ matcher: new RegExp(m === "" || m === "*" ? ".*" : `^(?:${m})$`), name, argv: w.slice(at + 2), ...(ws >= 0 && ws < at ? { workspace: w[ws + 1] } : {}) });
    }
  return { file, deny, hooks };
}

// Commands split at the shell's control operators outside quotes, as Claude matches a Bash rule
// against each command of a line.
function commands(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"') cur += line[i++];
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "\\") {
      cur += c + (line[++i] ?? "");
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

const globRe = (g: string, star: string) => g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*/g, (m) => (m === "*" ? star : ".*"));

function bashRule(spec: string, command: string): boolean {
  // `x:*` is the older prefix form; `x *` matches x alone too
  const pat = spec.endsWith(":*") ? `${spec.slice(0, -2)} *` : spec;
  const re = new RegExp(`^${globRe(pat, ".*").replace(/ \.\*$/, "(?: .*)?")}$`, "s");
  return commands(command).some((c) => re.test(c));
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

const WRITES = new Set(["edit", "delete", "move"]);
const art = (k: string) => `${/^[aeiou]/.test(k) ? "an" : "a"} ${k}`;

// Why the supervisor denies a call agy asks about, or null. An edit must name its file and a
// command its command line, or nothing can be checked; any other kind not read-only has no rules.
export function ruling(rules: Rules, kind: unknown, input: { name: string; args: Record<string, unknown> } | undefined, cwd: string): string | null {
  const call = input ? claudeCall(input.name, input.args) : null;
  const k = String(kind ?? "no kind");
  if (WRITES.has(k) && call?.tool_name !== "Write" && call?.tool_name !== "Edit") return `${art(k)} call that names no file to check`;
  if (k === "execute" && call?.tool_name !== "Bash") return "an execute call with no command line to check";
  if (!WRITES.has(k) && k !== "execute" && !readOnly(kind)) return `${art(k)} call, which the rules have nothing for`;
  return call ? check(rules, call, cwd, cwd) : null;
}

export const RULES_ENV = "SF_AGY_RULES";
export const PROJECT_ENV = "SF_AGY_PROJECT";

// `factory hook agy`, agy's PreToolUse hook: a deny, or nothing, which leaves the call to agy and
// the supervisor. An agy session that superfactory did not start has no RULES_ENV, and is left alone.
export function agyHook(_argv: string[], input: string): HookResult {
  const file = process.env[RULES_ENV];
  if (!file) return { code: 0 };
  const deny = (reason: string): HookResult => ({ code: 0, stdout: JSON.stringify({ decision: "deny", reason: `superfactory: ${reason}` }) + "\n" });
  let ev: { toolCall?: { name?: unknown; args?: unknown }; cwd?: unknown };
  try {
    ev = JSON.parse(input);
  } catch {
    return deny("the hook input was not JSON");
  }
  const name = String(ev.toolCall?.name ?? "");
  const args = (ev.toolCall?.args && typeof ev.toolCall.args === "object" ? ev.toolCall.args : {}) as Record<string, unknown>;
  const call = claudeCall(name, args);
  if (!call) return { code: 0 };
  const project = process.env[PROJECT_ENV] || (typeof ev.cwd === "string" ? ev.cwd : process.cwd());
  try {
    const why = check(loadRules(file), call, typeof ev.cwd === "string" && ev.cwd ? ev.cwd : project, project);
    return why ? deny(why) : { code: 0 };
  } catch (e) {
    return deny(`the session's rules could not be read: ${(e as Error).message}`);
  }
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
