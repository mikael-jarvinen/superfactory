import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { type Agent, isSettingsPath, type Role } from "./config.js";
import { claudeBin, lead, type Session, waitForName } from "./fleet.js";
import { branchFor, isLocal } from "./state.js";
import type { Workspace } from "./workspace.js";
import { capitalize, die, run } from "./util.js";

export type Phase = "build" | undefined;

export function roleOf(ws: Workspace, agent: Agent): Role {
  const role = ws.config.roles[agent.role];
  if (!role) return die(`roles.${agent.role} is not configured`);
  return role;
}

// Phase 1 takes a settings file path; templates are rendered from phase 2 on.
export function settingsFile(ws: Workspace, agent: Agent): string {
  const s = roleOf(ws, agent).settings;
  if (!isSettingsPath(s))
    die(`roles.${agent.role}.settings = ${JSON.stringify(s)} names a template, and templates are rendered from phase 2. Give the path of a settings file for now.`);
  return s;
}

export function buildAppendix(ws: Workspace, agent: Agent, repoDir: string | undefined): string | null {
  const parts: string[] = [];
  for (const item of agent.appendix) {
    let p = item;
    if (item.startsWith("repo:")) {
      if (!repoDir) die(`${agent.name}: appendix ${item} names a repo file, and ${agent.name} has no repo`);
      p = join(repoDir, item.slice("repo:".length));
    }
    let size = 0;
    try {
      const st = statSync(p);
      size = st.isFile() ? st.size : 0;
    } catch {
      size = 0;
    }
    if (size === 0)
      die(`${agent.name}: appendix file ${p} is missing or empty. A session that starts without its brief looks fine and behaves like a stranger, so this refuses.`);
    const label = p.startsWith(ws.dir + sep) ? relative(ws.dir, p) : p;
    parts.push(`<!-- ${label} -->\n` + readFileSync(p, "utf8").trimEnd() + "\n");
  }
  if (!parts.length) return null;
  const path = join(tmpdir(), `sf-${agent.name}-${randomBytes(4).toString("hex")}.md`);
  writeFileSync(path, parts.join("\n\n"), { flag: "wx" });
  return path;
}

const addDirs = (ws: Workspace, agent: Agent) =>
  (agent.addDirs ?? roleOf(ws, agent).addDirs).map((k) => ws.config.repos[k]!.path);

// ORDER MATTERS. `--add-dir` is variadic and eats every following bare word, including the prompt,
// so it comes before the single-valued flags and the prompt always follows one of those.
export function commonFlags(ws: Workspace, agent: Agent, phase: Phase): string[] {
  const role = roleOf(ws, agent);
  const settings = ["--settings", settingsFile(ws, agent)];
  const flags: string[] = [];
  if (agent.role !== "builder") flags.push(...settings);
  for (const d of addDirs(ws, agent)) flags.push("--add-dir", d);
  if (agent.remoteControl) flags.push("--remote-control", agent.name);
  if (agent.role === "builder") flags.push(...settings);
  if (phase === "build" && agent.role === "builder" && role.mcpConfig) flags.push("--mcp-config", role.mcpConfig);
  flags.push("--name", agent.name);
  if (role.model) flags.push("--model", role.model);
  if (role.effort) flags.push("--effort", role.effort);
  if (role.autocompact) flags.push("--autocompact", role.autocompact);
  if (role.permissionMode) flags.push("--permission-mode", role.permissionMode);
  return flags;
}

export function launchArgs(ws: Workspace, agent: Agent, prompt: string, appendixPath: string | null, phase: Phase): string[] {
  const args = ["--bg", ...commonFlags(ws, agent, phase)];
  if (appendixPath) args.push("--append-system-prompt-file", appendixPath);
  args.push(prompt);
  return args;
}

// GitHub over https with gh's credential helper, whatever the remote says, set through the
// environment so the clone's own config is untouched.
export const GIT_HTTPS_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_0: "git@github.com:",
};

export function launch(ws: Workspace, agent: Agent, cwd: string, prompt: string, appendixPath: string | null = null, phase: Phase = undefined): Session {
  const args = launchArgs(ws, agent, prompt, appendixPath, phase);
  const r = run(claudeBin(), args, { cwd, env: { ...process.env, ...GIT_HTTPS_ENV } });
  if (r.status !== 0) die(`claude --bg failed: ${r.stderr.trim() || r.stdout.trim()}`);
  const sid = /backgrounded · (\w+) · /.exec(r.stdout)?.[1] ?? "?";
  const s = waitForName(agent.name);
  if (!s) die(`${agent.name} did not appear in \`claude agents\` within 90s (launch id ${sid}). Check \`claude logs ${sid}\`.`);
  return s;
}

const leadName = (ws: Workspace) => capitalize(lead(ws).name);

export function buildingPrompt(ws: Workspace, agent: Agent, ticket: string): string {
  let p = `You are ${capitalize(agent.name)}. Your work item is ${ticket}. This is a BUILDING session in ` +
    `the worktree on branch ${branchFor(ticket)}. Read the repo rules in this directory, then reply exactly ` +
    `READY and wait for ${leadName(ws)}'s brief. The brief is the whole specification: there is no plan ` +
    `artifact and nothing else is coming. Do not start before it arrives.`;
  if (isLocal(ticket))
    p += " This item has no tracker ticket, and its key is factory bookkeeping: leave it out of the " +
      "PR title and the commit message, which are the description alone.";
  return p;
}

export const reviewerPrompt = (ws: Workspace) =>
  `You are one of ${leadName(ws)}'s reviewers. Read CLAUDE.md, reply exactly READY, and wait for the review brief.`;

export const leadPrompt = (ws: Workspace) =>
  `You are ${leadName(ws)}. Read CLAUDE.md, then run \`factory status\` and read every record in ` +
  `state/. Say in one message what is in flight and what is waiting on ${ws.config.human.name}. Then wait for messages.`;
