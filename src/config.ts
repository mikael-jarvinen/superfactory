import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse, TomlError } from "smol-toml";
import { FactoryError } from "./util.js";

export const ROLES = ["lead", "builder", "reviewer"] as const;
export type RoleName = (typeof ROLES)[number];

export const STATES = [
  "queued", "building", "pr-open", "agent-review",
  "fixing", "gate", "your-review", "colleague-review", "done", "blocked",
] as const;
export type State = (typeof STATES)[number];

export interface Repo {
  key: string;
  remote: string;
  path: string;
  base: string;
  gateChecks: string[];
  localChecks: string[];
}

export interface Stack {
  key: string;
  repos: string[];
  slots: number;
  reserve: number[];
  pin: Record<string, number>;
  script?: string;
}

export interface Role {
  name: RoleName;
  cwd?: string;
  model?: string;
  effort?: string;
  autocompact?: string;
  permissionMode?: string;
  settings: string;
  extraHooks: string[];
  mcpConfig?: string;
  addDirs: string[];
}

export interface Agent {
  name: string;
  role: RoleName;
  stack?: string;
  repos: string[];
  appendix: string[];
  addDirs?: string[];
  remoteControl: boolean;
}

export interface Tracker {
  kind: "jira" | "none";
  site?: string;
  queueJql?: string;
  keyPattern?: RegExp;
  status: Partial<Record<State, string>>;
}

export interface Config {
  file: string;
  dir: string;
  human: { name: string; legacyMessageKind?: string };
  github: { org?: string; bots: string[] };
  paths: { repos: string; state: string; logs: string };
  repos: Record<string, Repo>;
  stacks: Record<string, Stack>;
  roles: Partial<Record<RoleName, Role>>;
  agents: Agent[];
  tracker: Tracker;
  board: { host: string; port: number };
  gate: { proseRemark?: number };
  watchers: { queueEveryMinutes?: number; roundMinute?: number; model?: string; relayModel?: string };
  worktree: { toolWritten: string[] };
}

export class ConfigError extends FactoryError {
  constructor(file: string, readonly problems: string[]) {
    super(`${file} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n` + problems.map((p) => `  ${p}`).join("\n"));
  }
}

type Table = Record<string, unknown>;

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? "an array" : isTable(v) ? "a table" : String(v));

// Reads one table, recording a problem per bad key. `done` reports the keys nobody asked for.
function reader(problems: string[], where: string, t: Table) {
  const seen = new Set<string>();
  const at = (k: string) => (where ? `${where}.${k}` : k);
  const bad = (k: string, msg: string) => problems.push(`${at(k)}: ${msg}`);
  const get = (k: string, required: boolean): unknown => {
    seen.add(k);
    if (t[k] === undefined && required) bad(k, "missing");
    return t[k];
  };
  const str = (k: string, required = false): string | undefined => {
    const v = get(k, required);
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "") return void bad(k, `must be a non-empty string, got ${show(v)}`);
    return v;
  };
  const int = (k: string, required = false, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    const v = get(k, required);
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
      return void bad(k, `must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}, got ${show(v)}`);
    return v;
  };
  const bool = (k: string): boolean | undefined => {
    const v = get(k, false);
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") return void bad(k, `must be true or false, got ${show(v)}`);
    return v;
  };
  const strs = (k: string, required = false): string[] | undefined => {
    const v = get(k, required);
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === ""))
      return void bad(k, `must be an array of non-empty strings, got ${show(v)}`);
    return v as string[];
  };
  const ints = (k: string): number[] | undefined => {
    const v = get(k, false);
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isInteger(x)))
      return void bad(k, `must be an array of whole numbers, got ${show(v)}`);
    return v as number[];
  };
  const table = (k: string): Table | undefined => {
    const v = get(k, false);
    if (v === undefined) return undefined;
    if (!isTable(v)) return void bad(k, `must be a table, got ${show(v)}`);
    return v;
  };
  const done = () => {
    for (const k of Object.keys(t)) if (!seen.has(k)) bad(k, "unknown key");
  };
  const raw = (k: string): unknown => get(k, false);
  return { at, bad, raw, str, int, bool, strs, ints, table, done };
}

export function expandPath(value: string, base: string, env: NodeJS.ProcessEnv = process.env): string {
  let p = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b) as string;
    const v = env[name];
    if (v === undefined) throw new Error(`$${name} is not set`);
    return v;
  });
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

// A settings value is a template name (rendered in phase 2) unless it looks like a path.
export const isSettingsPath = (s: string) => s.includes("/") || s.endsWith(".json");

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Config {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new FactoryError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let doc: Table;
  try {
    doc = parse(text) as Table;
  } catch (e) {
    const msg = e instanceof TomlError ? e.message.split("\n")[0] : String(e);
    throw new ConfigError(file, [`not valid TOML: ${msg}`]);
  }
  return validate(doc, file, env);
}

export function validate(doc: Table, file: string, env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const dir = dirname(resolve(file));
  const top = reader(problems, "", doc);

  const path = (r: ReturnType<typeof reader>, k: string, v: string | undefined, base = dir): string | undefined => {
    if (v === undefined) return undefined;
    try {
      return expandPath(v, base, env);
    } catch (e) {
      r.bad(k, (e as Error).message);
      return undefined;
    }
  };

  const human = reader(problems, "human", top.table("human") ?? {});
  const humanName = human.str("name", true) ?? "";
  const legacyMessageKind = human.str("legacy_message_kind");
  human.done();

  const gh = reader(problems, "github", top.table("github") ?? {});
  const github = { org: gh.str("org"), bots: gh.strs("bots") ?? [] };
  gh.done();

  const p = reader(problems, "paths", top.table("paths") ?? {});
  const paths = {
    repos: path(p, "repos", p.str("repos")) ?? dir,
    state: path(p, "state", p.str("state")) ?? join(dir, "state"),
    logs: path(p, "logs", p.str("logs")) ?? join(dir, "logs"),
  };
  p.done();

  const repos: Record<string, Repo> = {};
  for (const [key, v] of Object.entries(top.table("repos") ?? {})) {
    const where = `repos.${key}`;
    if (!isTable(v)) {
      problems.push(`${where}: must be a table, got ${show(v)}`);
      continue;
    }
    const r = reader(problems, where, v);
    const remote = r.str("remote", true);
    if (remote && !/^[\w.-]+\/[\w.-]+$/.test(remote)) r.bad("remote", `must look like owner/repo, got ${show(remote)}`);
    repos[key] = {
      key,
      remote: remote ?? "",
      path: path(r, "path", r.str("path") ?? key, paths.repos) ?? "",
      base: r.str("base") ?? "main",
      gateChecks: r.strs("gate_checks") ?? [],
      localChecks: r.strs("local_checks") ?? [],
    };
    r.done();
  }
  const repoKeys = (r: ReturnType<typeof reader>, k: string, keys: string[] | undefined) => {
    for (const x of keys ?? []) if (!repos[x]) r.bad(k, `no repo ${show(x)}; repos: ${Object.keys(repos).join(", ") || "none"}`);
    return keys;
  };

  const stacks: Record<string, Stack> = {};
  for (const [key, v] of Object.entries(top.table("stacks") ?? {})) {
    const where = `stacks.${key}`;
    if (!isTable(v)) {
      problems.push(`${where}: must be a table, got ${show(v)}`);
      continue;
    }
    const r = reader(problems, where, v);
    const stackRepos = repoKeys(r, "repos", r.strs("repos", true)) ?? [];
    if (r.strs("repos") && stackRepos.length === 0) r.bad("repos", "must name at least one repo");
    const slots = r.int("slots", true, 1) ?? 1;
    const reserve = r.ints("reserve") ?? [];
    for (const n of reserve) if (n < 0 || n > slots) r.bad("reserve", `slot ${n} is outside 0..${slots}`);
    const pinT = r.table("pin") ?? {};
    const pin: Record<string, number> = {};
    for (const [name, n] of Object.entries(pinT)) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > slots) {
        problems.push(`${where}.pin.${name}: must be a slot from 0 to ${slots}, got ${show(n)}`);
        continue;
      }
      if (reserve.includes(n)) problems.push(`${where}.pin.${name}: slot ${n} is reserved`);
      pin[name] = n;
    }
    stacks[key] = { key, repos: stackRepos, slots, reserve, pin, script: path(r, "script", r.str("script")) };
    r.done();
  }

  const roles: Partial<Record<RoleName, Role>> = {};
  const rolesT = top.table("roles") ?? {};
  for (const [name, v] of Object.entries(rolesT)) {
    const where = `roles.${name}`;
    if (!(ROLES as readonly string[]).includes(name)) {
      problems.push(`${where}: unknown role; roles are ${ROLES.join(", ")}`);
      continue;
    }
    if (!isTable(v)) {
      problems.push(`${where}: must be a table, got ${show(v)}`);
      continue;
    }
    const r = reader(problems, where, v);
    const role = name as RoleName;
    const cwd = path(r, "cwd", r.str("cwd", role !== "builder"));
    if (role === "builder" && cwd) r.bad("cwd", "a builder starts in its worktree, so it takes no cwd");
    const settings = r.str("settings", true) ?? "";
    roles[role] = {
      name: role,
      cwd,
      model: r.str("model"),
      effort: r.str("effort"),
      autocompact: r.str("autocompact"),
      permissionMode: r.str("permission_mode"),
      settings: isSettingsPath(settings) ? (path(r, "settings", settings) ?? "") : settings,
      extraHooks: r.strs("extra_hooks") ?? [],
      mcpConfig: path(r, "mcp_config", r.str("mcp_config")),
      addDirs: repoKeys(r, "add_dirs", r.strs("add_dirs")) ?? [],
    };
    r.done();
  }

  const agents: Agent[] = [];
  const agentsV = top.raw("agents");
  const names = new Set<string>();
  if (agentsV !== undefined && !Array.isArray(agentsV)) problems.push(`agents: must be an array of tables ([[agents]]), got ${show(agentsV)}`);
  const agentList = Array.isArray(agentsV) ? agentsV : [];
  agentList.forEach((v, i) => {
    const where = `agents[${i}]`;
    if (!isTable(v)) {
      problems.push(`${where}: must be a table, got ${show(v)}`);
      return;
    }
    const r = reader(problems, where, v);
    const name = r.str("name", true) ?? "";
    if (name && !/^[a-z][a-z0-9-]*$/.test(name)) r.bad("name", `must be lower case letters, digits and dashes, got ${show(name)}`);
    if (name && names.has(name)) r.bad("name", `${show(name)} is used by another agent`);
    names.add(name);
    const roleV = r.str("role", true);
    if (roleV && !(ROLES as readonly string[]).includes(roleV)) r.bad("role", `must be one of ${ROLES.join(", ")}, got ${show(roleV)}`);
    const role = roleV as RoleName;
    const stack = r.str("stack");
    const agentRepos = repoKeys(r, "repos", r.strs("repos"));
    if (stack && !stacks[stack]) r.bad("stack", `no stack ${show(stack)}; stacks: ${Object.keys(stacks).join(", ") || "none"}`);
    if (role === "builder") {
      if (stack && agentRepos) r.bad("repos", "give stack or repos, not both");
      if (!stack && !agentRepos) r.bad("stack", "a builder needs stack or repos");
      if (agentRepos && agentRepos.length === 0) r.bad("repos", "must name at least one repo");
    } else {
      if (stack) r.bad("stack", "only a builder has a stack");
      if (agentRepos) r.bad("repos", "only a builder has repos");
    }
    const appendix = r.strs("appendix") ?? [];
    const resolved = appendix.map((a) => (a.startsWith("repo:") ? a : (path(r, "appendix", a) ?? a)));
    const addDirs = repoKeys(r, "add_dirs", r.strs("add_dirs"));
    agents.push({
      name,
      role,
      stack,
      repos: stack ? (stacks[stack]?.repos ?? []) : (agentRepos ?? []),
      appendix: resolved,
      addDirs,
      remoteControl: r.bool("remote_control") ?? false,
    });
    r.done();
  });
  const leads = agents.filter((a) => a.role === "lead");
  if (leads.length !== 1)
    problems.push(`agents: exactly one agent needs role = "lead", found ${leads.length}${leads.length ? ` (${leads.map((a) => a.name).join(", ")})` : ""}`);
  for (const role of ROLES) {
    const user = agents.find((a) => a.role === role);
    if (user && !roles[role]) problems.push(`roles.${role}: missing, and agent ${show(user.name)} has that role`);
  }
  for (const s of Object.values(stacks))
    for (const name of Object.keys(s.pin)) {
      const a = agents.find((x) => x.name === name);
      if (!a || a.role !== "builder" || a.stack !== s.key) problems.push(`stacks.${s.key}.pin.${name}: no builder ${show(name)} on stack ${show(s.key)}`);
    }

  const t = reader(problems, "tracker", top.table("tracker") ?? {});
  const kind = t.str("kind") ?? "none";
  if (kind !== "jira" && kind !== "none") t.bad("kind", `must be "jira" or "none", got ${show(kind)}`);
  const patternS = t.str("key_pattern", kind === "jira");
  let keyPattern: RegExp | undefined;
  if (patternS) {
    try {
      keyPattern = new RegExp(patternS);
    } catch (e) {
      t.bad("key_pattern", `not a valid regular expression: ${(e as Error).message}`);
    }
  }
  const statusT = t.table("status") ?? {};
  const status: Partial<Record<State, string>> = {};
  for (const [s, v] of Object.entries(statusT)) {
    if (!(STATES as readonly string[]).includes(s)) problems.push(`tracker.status.${s}: unknown state; states: ${STATES.join(", ")}`);
    else if (typeof v !== "string" || v === "") problems.push(`tracker.status.${s}: must be a non-empty string, got ${show(v)}`);
    else status[s as State] = v;
  }
  if (kind === "jira")
    for (const s of ["queued", "building", "colleague-review", "done"] as const)
      if (statusT[s] === undefined) problems.push(`tracker.status.${s}: missing; the tracker needs a status for it`);
  const tracker: Tracker = { kind: kind as Tracker["kind"], site: t.str("site"), queueJql: t.str("queue_jql"), keyPattern, status };
  t.done();

  const b = reader(problems, "board", top.table("board") ?? {});
  const board = { host: b.str("host") ?? "localhost", port: b.int("port", false, 1, 65535) ?? 8787 };
  b.done();

  const g = reader(problems, "gate", top.table("gate") ?? {});
  const gate = { proseRemark: g.int("prose_remark", false, 1) };
  g.done();

  const w = reader(problems, "watchers", top.table("watchers") ?? {});
  const watchers = {
    queueEveryMinutes: w.int("queue_every_minutes", false, 1),
    roundMinute: w.int("round_minute", false, 0, 59),
    model: w.str("model"),
    relayModel: w.str("relay_model"),
  };
  w.done();

  const wt = reader(problems, "worktree", top.table("worktree") ?? {});
  const worktree = { toolWritten: wt.strs("tool_written") ?? [] };
  wt.done();

  top.done();
  if (problems.length) throw new ConfigError(file, problems);
  return {
    file: resolve(file), dir,
    human: { name: humanName, legacyMessageKind },
    github, paths, repos, stacks, roles, agents, tracker, board, gate, watchers, worktree,
  };
}
