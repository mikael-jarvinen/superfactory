import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { parse, TomlError } from "smol-toml";
import { capitalize, FactoryError } from "./util.js";

export const ROLES = ["lead", "builder", "reviewer", "assistant", "designer"] as const;
export type RoleName = (typeof ROLES)[number];

export const STATES = [
  "queued", "designing", "design-review", "building", "pr-open", "agent-review",
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
  // A [hosts] key: the checkout is on that machine, and `path` is its absolute path there.
  host?: string;
  // How git reaches GitHub for this checkout: its host's git_over, or "https" for one here.
  gitOver: GitOver;
}

// "https": GitHub over https through gh, whatever the remote says, so no session needs the ssh key.
// "ssh": the checkout's origin as it is, for a host with the key and no gh.
export const GIT_OVER = ["https", "ssh"] as const;
export type GitOver = (typeof GIT_OVER)[number];

export interface Stack {
  key: string;
  label: string;
  repos: string[];
  slots: number;
  reserve: number[];
  pin: Record<string, number>;
  script?: string;
  // What a builder session on this stack gets in its environment, through its settings' env
  env: Record<string, string>;
  pathPrepend: string[];
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
  cwd?: string;
  permissionMode?: string;
  autocompact?: string;
  // A [hosts] key: the agent's sessions run on that machine, through its factory daemon.
  host?: string;
}

// Another machine's factory daemon. remote.ts says what a request carries.
export interface Host {
  name: string;
  url: string;
  tokenFile: string;
  hashFiles: string[];
  gitOver: GitOver;
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
  github: { org?: string; bots: string[]; ownRepos: string[]; leadMerges: string[] };
  paths: { repos: string; state: string; logs: string };
  repos: Record<string, Repo>;
  stacks: Record<string, Stack>;
  hosts: Record<string, Host>;
  roles: Partial<Record<RoleName, Role>>;
  agents: Agent[];
  tracker: Tracker;
  board: { host: string; port: number };
  // false lets a session message a session on another machine with nobody approving each send
  peers: { isolateMachines: boolean };
  gate: { proseRemark?: number; reviewBot?: string };
  watchers: { queueEveryMinutes?: number; roundMinute?: number; model?: string; facts: FactsFile[] };
  worktree: { toolWritten: string[] };
}

// A file something outside the factory writes, which the round reads as more facts. A line
// escalates when it has one of the escalate words, or sits under a section whose title starts with
// one of every_line_in. A missing file, or one older than max_age_minutes, escalates too.
export interface FactsFile {
  file: string;
  maxAgeMinutes?: number;
  escalate: string[];
  everyLineIn: string[];
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

// A settings value is a template name unless it looks like a path.
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
  const ownRepos = gh.strs("own_repos") ?? [];
  const notSlug = ownRepos.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
  if (notSlug !== undefined) gh.bad("own_repos", `must name repos as owner/repo, got ${show(notSlug)}`);
  const leadMerges = gh.strs("lead_merges") ?? [];
  const notSlug2 = leadMerges.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
  if (notSlug2 !== undefined) gh.bad("lead_merges", `must name repos as owner/repo, got ${show(notSlug2)}`);
  const github = { org: gh.str("org"), bots: gh.strs("bots") ?? [], ownRepos, leadMerges };
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
    const host = r.str("host");
    const rawPath = r.str("path");
    // A path on another machine: nothing here can expand it, and no default would name it.
    if (host && !(rawPath && isAbsolute(rawPath) && !/[~$]/.test(rawPath)))
      r.bad("path", `${key} lives on host ${host}, so give its checkout's absolute path there, with no ~ or $${rawPath ? `, got ${show(rawPath)}` : ""}`);
    repos[key] = {
      key,
      host,
      gitOver: "https",   // set from the host's git_over once [hosts] is read
      remote: remote ?? "",
      // Normalized: no ., .., doubled or trailing slashes. Symlinks are not resolved; that would need the host.
      path: host ? (rawPath ? posix.normalize(rawPath).replace(/(.)\/+$/, "$1") : "") : (path(r, "path", rawPath ?? key, paths.repos) ?? ""),
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
    for (const k of stackRepos)
      if (repos[k]?.host) r.bad("repos", `repo ${k} lives on host ${repos[k]!.host}, and a stack's slots and script run on this machine`);
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
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(r.table("env") ?? {})) {
      if (name === "PATH") problems.push(`${where}.env.PATH: give path_prepend instead; a session's PATH is built from it`);
      else if (typeof value !== "string") problems.push(`${where}.env.${name}: must be a string, got ${show(value)}`);
      else env[name] = value;
    }
    const pathPrepend = (r.strs("path_prepend") ?? []).flatMap((d) => path(r, "path_prepend", d) ?? []);
    stacks[key] = {
      key, label: r.str("label") ?? capitalize(key), repos: stackRepos, slots, reserve, pin, script: path(r, "script", r.str("script")),
      env, pathPrepend,
    };
    r.done();
  }

  const roles: Partial<Record<RoleName, Role>> = {};
  // As written, for an agent on a host: its cwd is a path there, so nothing here expands it.
  const rolesCwd: Partial<Record<RoleName, string>> = {};
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
    const rawCwd = r.str("cwd", role !== "builder");
    if (rawCwd) rolesCwd[role] = rawCwd;
    const cwd = path(r, "cwd", rawCwd);
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

  const hosts: Record<string, Host> = {};
  for (const [key, v] of Object.entries(top.table("hosts") ?? {})) {
    const where = `hosts.${key}`;
    if (!isTable(v)) {
      problems.push(`${where}: must be a table, got ${show(v)}`);
      continue;
    }
    const r = reader(problems, where, v);
    if (key === "local") problems.push(`${where}: "local" names this machine's own sessions; give the host another name`);
    const url = r.str("url", true);
    if (url && !/^https?:\/\/[^/]+\/?$/.test(url)) r.bad("url", `must be http(s)://host:port, got ${show(url)}`);
    hosts[key] = {
      name: key,
      url: (url ?? "").replace(/\/$/, ""),
      tokenFile: path(r, "token_file", r.str("token_file") ?? "~/.config/factory/token") ?? "",
      hashFiles: (r.strs("hash_files", true) ?? []).map((f) => path(r, "hash_files", f) ?? ""),
      gitOver: "https",
    };
    const over = r.str("git_over");
    if (over !== undefined) {
      if ((GIT_OVER as readonly string[]).includes(over)) hosts[key]!.gitOver = over as GitOver;
      else r.bad("git_over", `must be one of ${GIT_OVER.join(", ")}, got ${show(over)}`);
    }
    if (Array.isArray(v.hash_files) && v.hash_files.length !== 2)
      r.bad("hash_files", `must name two files, the daemon's config then the workspace config, got ${v.hash_files.length}`);
    r.done();
  }
  for (const repo of Object.values(repos))
    if (repo.host && hosts[repo.host]) repo.gitOver = hosts[repo.host]!.gitOver;
  for (const repo of Object.values(repos))
    if (repo.host && !hosts[repo.host])
      problems.push(`repos.${repo.key}.host: no host ${show(repo.host)}; hosts: ${Object.keys(hosts).join(", ") || "none"}`);

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
    const rawCwd = r.str("cwd");
    const host = r.str("host");
    const cwd = host ? rawCwd : path(r, "cwd", rawCwd);
    if (role === "builder" && cwd) r.bad("cwd", "a builder starts in its worktree, so it takes no cwd");
    const there = rawCwd ?? (role ? rolesCwd[role] : undefined);
    if (host && there !== undefined && !(isAbsolute(there) && !/[~$]/.test(there)))
      r.bad(rawCwd ? "cwd" : "host", `${name} runs on host ${host}, so ${rawCwd ? "its cwd" : `roles.${role}.cwd`} must be an absolute path there, with no ~ or $, got ${show(there)}`);
    if (host && !hosts[host]) r.bad("host", `no host ${show(host)}; hosts: ${Object.keys(hosts).join(", ") || "none"}`);
    const workRepos = stack ? (stacks[stack]?.repos ?? []) : (agentRepos ?? []);
    // A builder runs where its worktrees are, and they are under its repos' checkouts.
    if (role === "builder") {
      const away = workRepos.find((k) => repos[k] && repos[k]!.host !== host);
      if (away !== undefined) {
        const rh = repos[away]!.host;
        r.bad(host ? "host" : stack ? "stack" : "repos",
          `repo ${away} lives on ${rh ? `host ${rh}` : "this machine"}, and a builder runs where its worktrees are, so ${name} needs ${rh ? `host = ${show(rh)}` : "no host"}`);
      }
      if (host)
        for (const a of appendix.filter((x) => x.startsWith("repo:")))
          r.bad("appendix", `${a} is read from the checkout on this machine, and ${name}'s checkouts are on host ${host}`);
    }
    // An --add-dir is a path on the machine that runs the session.
    for (const k of addDirs ?? (role ? roles[role]?.addDirs : undefined) ?? [])
      if (repos[k]?.host && repos[k]!.host !== host)
        r.bad(addDirs ? "add_dirs" : "role", `repo ${k} lives on host ${repos[k]!.host}, and ${name} runs ${host ? `on host ${host}` : "on this machine"}, so it cannot be an --add-dir${addDirs ? "" : ` (from roles.${role}.add_dirs)`}`);
    agents.push({
      name,
      role,
      stack,
      repos: workRepos,
      appendix: resolved,
      addDirs,
      remoteControl: r.bool("remote_control") ?? false,
      cwd,
      permissionMode: r.str("permission_mode"),
      autocompact: r.str("autocompact"),
      host,
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

  const pe = reader(problems, "peers", top.table("peers") ?? {});
  const peers = { isolateMachines: pe.bool("isolate_machines") ?? true };
  pe.done();

  const g = reader(problems, "gate", top.table("gate") ?? {});
  const gate = { proseRemark: g.int("prose_remark", false, 1), reviewBot: g.str("review_bot") };
  g.done();

  const w = reader(problems, "watchers", top.table("watchers") ?? {});
  const watchers = {
    queueEveryMinutes: w.int("queue_every_minutes", false, 1),
    roundMinute: w.int("round_minute", false, 0, 59),
    model: w.str("model"),
    facts: [] as FactsFile[],
  };
  const factsV = w.raw("facts");
  if (factsV !== undefined && !Array.isArray(factsV)) problems.push(`watchers.facts: must be an array of tables ([[watchers.facts]]), got ${show(factsV)}`);
  (Array.isArray(factsV) ? factsV : []).forEach((v, i) => {
    const where = `watchers.facts[${i}]`;
    if (!isTable(v)) return void problems.push(`${where}: must be a table, got ${show(v)}`);
    const f = reader(problems, where, v);
    const file = path(f, "file", f.str("file", true));
    const ff = { file: file ?? "", maxAgeMinutes: f.int("max_age_minutes", false, 1), escalate: f.strs("escalate") ?? [], everyLineIn: f.strs("every_line_in") ?? [] };
    f.done();
    if (file) watchers.facts.push(ff);
  });
  w.done();

  const wt = reader(problems, "worktree", top.table("worktree") ?? {});
  const worktree = { toolWritten: wt.strs("tool_written") ?? [] };
  wt.done();

  top.done();
  if (problems.length) throw new ConfigError(file, problems);
  return {
    file: resolve(file), dir,
    human: { name: humanName, legacyMessageKind },
    github, paths, repos, stacks, hosts, roles, agents, tracker, board, peers, gate, watchers, worktree,
  };
}
