import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSettingsPath } from "./config.js";
import { lead } from "./fleet.js";
import { POLICIES, type Policy, TMP_ROOTS } from "./hooks/guard.js";
import type { Workspace } from "./workspace.js";
import { die } from "./util.js";

export const HOOKS = ["guard", "status", "no-dialogs", "no-side-channels"] as const;
export type HookName = (typeof HOOKS)[number];

export interface HookResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

export const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// This node running this cli.js, so a hook never depends on the PATH its session happens to have.
export const factoryCommand = () => `${shq(process.execPath)} ${shq(CLI)}`;

// A template is templates/<name>.json, or a file of the same shape named by path:
//   hooks           the hooks this role runs; config's extra_hooks are added
//   guard           the guard's policy, when hooks has guard
//   tracker_writes  true for the one role that moves tickets; everyone else is refused them
//   write_dirs      "logs" or "state": where a readonly guard also lets a redirect write
//   settings        Claude Code settings, passed through, with the computed parts below added
interface Template {
  hooks: HookName[];
  guard?: Policy;
  trackerWrites: boolean;
  writeDirs: (keyof typeof WRITE_DIRS)[];
  settings: Record<string, unknown>;
}

const WRITE_DIRS = { logs: (ws: Workspace) => ws.logsDir, state: (ws: Workspace) => ws.stateDir };

export function templateNames(): string[] {
  return readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
}

function loadTemplate(file: string): Template {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return die(`settings template ${file}: ${(e as Error).message}`);
  }
  const problems: string[] = [];
  const known = ["hooks", "guard", "tracker_writes", "write_dirs", "settings"];
  for (const k of Object.keys(doc)) if (!known.includes(k)) problems.push(`${k}: unknown key; keys are ${known.join(", ")}`);
  const hooks = doc.hooks ?? [];
  if (!Array.isArray(hooks) || hooks.some((h) => !(HOOKS as readonly unknown[]).includes(h))) problems.push(`hooks: must be an array of ${HOOKS.join(", ")}`);
  const guard = doc.guard;
  if (guard !== undefined && !(POLICIES as readonly unknown[]).includes(guard)) problems.push(`guard: must be one of ${POLICIES.join(", ")}`);
  if (Array.isArray(hooks) && hooks.includes("guard") && guard === undefined) problems.push("guard: missing, and hooks has guard");
  const writeDirs = doc.write_dirs ?? [];
  if (!Array.isArray(writeDirs) || writeDirs.some((d) => !Object.hasOwn(WRITE_DIRS, d as string))) problems.push(`write_dirs: must be an array of ${Object.keys(WRITE_DIRS).join(", ")}`);
  const settings = doc.settings ?? {};
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) problems.push("settings: must be an object");
  if (problems.length) die(`settings template ${file} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n` + problems.map((p) => `  ${p}`).join("\n"));
  return {
    hooks: hooks as HookName[], guard: guard as Policy | undefined, trackerWrites: doc.tracker_writes === true,
    writeDirs: writeDirs as Template["writeDirs"], settings: settings as Record<string, unknown>,
  };
}

// Set for every session whatever the template says: memory off, and the peer settings the design
// lists under Claude Code integration.
const BASE = { autoMemoryEnabled: false, crossSessionInbound: "accept", isolatePeerMachines: true };

const DIALOGS = "EnterPlanMode|ExitPlanMode|AskUserQuestion";
const CHAT = "mcp__claude_ai_Slack__.*";
// The tracker's write tools, by tracker kind. Reads stay open to everyone.
const TRACKER_WRITES: Record<string, string> = {
  jira: "mcp__claude_ai_Atlassian__(transitionJiraIssue|editJiraIssue|createJiraIssue|addCommentToJiraIssue|addWorklogToJiraIssue|" +
    "createIssueLink|createConfluencePage|updateConfluencePage|createConfluenceFooterComment|createConfluenceInlineComment)",
};
const STATUS_EVENTS = ["UserPromptSubmit", "Stop", "SessionStart", "PreCompact", "SessionEnd"];

// macOS roots nobody's work lives under. Home and the workspace's own trees are added per render.
const SYSTEM_ROOTS = ["/Library", "/System", "/Volumes", "/etc", "/opt", "/usr"];

// Where a readonly session may not Edit: every home directory, the workspace, the checkouts, and
// the system. Deny beats allow, so a root that held /tmp would take /tmp with it; none does.
function editDenyRoots(ws: Workspace): string[] {
  const home = homedir();
  const homes = dirname(home) === "/" ? home : dirname(home);
  const all = [...new Set([homes, ws.dir, ws.config.paths.repos, ...Object.values(ws.config.repos).map((r) => r.path), ...SYSTEM_ROOTS])];
  return all.filter((p) => !all.some((q) => q !== p && p.startsWith(q + "/")));
}

interface HookEntry {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout: number }[];
}

export interface SessionSettings {
  name: string;
  role: string;
  template: string;
  extraHooks?: string[];
  permissionMode?: string;
}

// Renders one session's settings into logs/run/settings-<name>.json and returns the path. Every
// hook command carries what the hook needs to know about the session, the guard's role above all,
// so no hook reads it from anywhere else.
export function renderSettings(ws: Workspace, s: SessionSettings): string {
  const file = isSettingsPath(s.template) ? s.template : join(TEMPLATES_DIR, `${s.template}.json`);
  if (!existsSync(file))
    die(isSettingsPath(s.template) ? `settings for ${s.name}: ${file} does not exist`
      : `settings for ${s.name}: no template ${JSON.stringify(s.template)}; templates are ${templateNames().join(", ")}`);
  const t = loadTemplate(file);
  for (const h of s.extraHooks ?? [])
    if (!(HOOKS as readonly string[]).includes(h)) die(`settings for ${s.name}: extra hook ${JSON.stringify(h)} is not a hook; hooks are ${HOOKS.join(", ")}`);
  const names = [...new Set([...t.hooks, ...((s.extraHooks ?? []) as HookName[])])];

  const out: Record<string, unknown> = { ...BASE };
  for (const [k, v] of Object.entries(structuredClone(t.settings))) if (!(k in BASE)) out[k] = v;

  const perms = (out.permissions ?? {}) as { deny?: string[]; allow?: string[]; defaultMode?: string };
  const org = ws.config.github.org;
  const fill = (rules: string[] = []) => rules.flatMap((r) => (!r.includes("{org}") ? [r] : org ? [r.replaceAll("{org}", org)] : []));
  const deny = fill(perms.deny);
  const allow = fill(perms.allow);
  if (t.guard === "readonly") {
    deny.push(...editDenyRoots(ws).map((p) => `Edit(/${p}/**)`));
    allow.unshift(...TMP_ROOTS.map((p) => `Edit(/${p}/**)`));
  }
  if (deny.length) perms.deny = deny;
  else delete perms.deny;
  if (allow.length) perms.allow = allow;
  else delete perms.allow;
  // --permission-mode does not survive every restart path; the settings file does
  if (s.permissionMode) perms.defaultMode = s.permissionMode;
  if (Object.keys(perms).length) out.permissions = perms;

  const hooks = (out.hooks ?? {}) as Record<string, HookEntry[]>;
  const add = (event: string, matcher: string | undefined, args: string[], timeout: number) =>
    (hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${factoryCommand()} ${args.map(shq).join(" ")}`, timeout }] });
  const leadName = lead(ws).name;
  for (const h of names) {
    if (h === "guard") {
      const dirs = t.writeDirs.flatMap((d) => ["--write-dir", WRITE_DIRS[d](ws)]);
      add("PreToolUse", "Bash", ["hook", "guard", "--role", s.role, "--policy", t.guard as Policy, ...dirs], 10);
    } else if (h === "no-dialogs") {
      add("PreToolUse", DIALOGS, ["hook", "no-dialogs", "--lead", leadName], 5);
    } else if (h === "no-side-channels") {
      add("PreToolUse", CHAT, ["hook", "no-side-channels", "--lead", leadName], 5);
      const writes = TRACKER_WRITES[ws.config.tracker.kind];
      if (writes && !t.trackerWrites) add("PreToolUse", writes, ["hook", "no-side-channels", "--lead", leadName], 5);
    } else {
      // The inbox is the lead's, so only the lead's stop is held for it.
      const args = ["--workspace", ws.dir, "hook", "status", "--agent", s.name, ...(s.role === "lead" ? ["--inbox"] : [])];
      add("PreToolUse", "*", args, 5);
      add("PostToolUse", "*", args, 5);
      for (const ev of STATUS_EVENTS) add(ev, undefined, args, 5);
    }
  }
  if (Object.keys(hooks).length) out.hooks = hooks;

  mkdirSync(ws.runDir, { recursive: true });
  const path = join(ws.runDir, `settings-${s.name}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  return path;
}
