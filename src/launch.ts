import { readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Agent, GitOver, Role } from "./config.js";
import { lead, pollForName, type Session } from "./fleet.js";
import { Unreachable } from "./remote.js";
import { renderSettings } from "./settings.js";
import { branchFor, isLocal } from "./state.js";
import { clearEnded } from "./stopped.js";
import { withLock } from "./tickets/lock.js";
import { type Transport, transportFor } from "./transport.js";
import type { Workspace } from "./workspace.js";
import { capitalize, die } from "./util.js";

export type Phase = "build" | undefined;

// The agent's own cwd, model, effort, permission_mode and autocompact win over its role's.
export function roleOf(ws: Workspace, agent: Agent): Role {
  const role = ws.config.roles[agent.role];
  if (!role) return die(`roles.${agent.role} is not configured`);
  return {
    ...role,
    cwd: agent.cwd ?? role.cwd,
    model: agent.model ?? role.model,
    effort: agent.effort ?? role.effort,
    permissionMode: agent.permissionMode ?? role.permissionMode,
    autocompact: agent.autocompact ?? role.autocompact,
  };
}

// A builder's stack environment. Claude Code takes a settings env value literally and sets it on the
// session's own process too, so PATH is written out whole: the stack's directories, then the PATH of
// the factory that launches the session. A PATH that lost the launcher's entries would cost the
// session its keychain, and with it its login.
// What a stack put first on a session's PATH, so the next render can take exactly that back out.
export const PREPENDED = "SF_PATH_PREPEND";

export function sessionEnv(ws: Workspace, agent: Agent, path = process.env.PATH ?? "", sent = process.env[PREPENDED] ?? ""): Record<string, string> | undefined {
  const stack = agent.stack ? ws.config.stacks[agent.stack] : undefined;
  const prepend = stack?.pathPrepend ?? [];
  const env: Record<string, string> = { ...stack?.env };
  // path is this process's, and a wake renders a recipient's settings in its sender's hook, whose
  // PATH starts with what the sender's stack prepended. Exactly that run comes out, and nothing
  // else: a render never dedupes, so a directory a stack shares with the system PATH,
  // /usr/local/bin say, keeps its system copy and survives the next render. A recipient that
  // prepends nothing, on a stack or none, still loses the sender's run.
  if (prepend.length || sent) {
    env.PATH = [...prepend, ...withoutRun(path.split(":").filter(Boolean), sent.split(":").filter(Boolean))].join(":");
    env[PREPENDED] = prepend.join(":");
  }
  return Object.keys(env).length ? env : undefined;
}

// dirs without the first place where run appears whole, in order; dirs as they are if it never does.
function withoutRun(dirs: string[], run: string[]): string[] {
  if (!run.length) return dirs;
  for (let i = 0; i + run.length <= dirs.length; i++)
    if (run.every((d, j) => dirs[i + j] === d)) return [...dirs.slice(0, i), ...dirs.slice(i + run.length)];
  return dirs;
}

// Rendered at every launch from the role's template and config, into logs/run/.
export function settingsFile(ws: Workspace, agent: Agent): string {
  const role = roleOf(ws, agent);
  return renderSettings(ws, {
    name: agent.name, role: agent.role, template: role.settings, cwd: role.cwd, extraHooks: role.extraHooks, permissionMode: role.permissionMode,
    env: sessionEnv(ws, agent), ...(agent.host ? { host: agent.host } : {}),
  });
}

export function buildAppendix(ws: Workspace, agent: Agent, repoDir: string | undefined): { text: string; labels: string[] } | null {
  const parts: string[] = [];
  const labels: string[] = [];
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
    labels.push(label);
    parts.push(`<!-- ${label} -->\n` + readFileSync(p, "utf8").trimEnd() + "\n");
  }
  return parts.length ? { text: parts.join("\n\n"), labels } : null;
}

// The appendix of a session that starts in its role's cwd, with no checkout: every role but a builder.
export const roleAppendix = (ws: Workspace, agent: Agent): string | null => buildAppendix(ws, agent, undefined)?.text ?? null;

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
  // A builder's browser is for its build; a designer's is how it renders frames and today's screens.
  if (role.mcpConfig && (agent.role !== "builder" || phase === "build")) flags.push("--mcp-config", role.mcpConfig);
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
// What a session's environment adds for git on a machine whose [hosts] git_over is `over`: nothing
// for "ssh", so its pushes use the checkout's origin and the machine's own key.
export const gitEnv = (over: GitOver = "https"): Record<string, string> => (over === "ssh" ? {} : GIT_HTTPS_ENV);

// One start of an agent at a time: a start, its wait to be listed and its removal of the agent's
// ended rows run under this lock, so two starts never make two sessions under one name and the
// removal never takes a start that is not yet live. A caller that checks for a live session first
// (wake) takes it around the check, and passes locked. Known limit: the lock is local, in
// ws.runDir. A hosted agent woken from the primary (over the remote transport) and from its host at
// once is under two locks, and the daemon's start route takes none, so those two can still race.
export const startLock = (ws: Workspace, name: string) => join(ws.runDir, `start-${name}.lock`);
const START_LOCK_WAIT_MS = 150_000;

// wait, for a caller with a deadline: how long to wait for the session to be listed live (90 s),
// the epoch ms of the last listing, and how long the start itself may take.
export function launch(ws: Workspace, agent: Agent, cwd: string, prompt: string, appendix: string | null = null, phase: Phase = undefined, t: Transport = transportFor(ws, agent),
  wait: { waitS?: number; pollMs?: number; lastPollAt?: number; startMs?: number; locked?: boolean } = {}): Session {
  if (!wait.locked)
    return withLock(startLock(ws, agent.name), () => launch(ws, agent, cwd, prompt, appendix, phase, t, { ...wait, locked: true }), START_LOCK_WAIT_MS);
  const sid = t.start({
    agent, cwd, prompt, appendix, phase, runDir: ws.runDir,
    args: (appendixPath) => launchArgs(ws, agent, prompt, appendixPath, phase),
    env: { ...process.env, ...GIT_HTTPS_ENV },
    ...(wait.startMs ? { timeoutMs: wait.startMs } : {}),
  });
  const waitS = wait.waitS ?? 90;
  const s = pollForName(t, agent.name, waitS, wait.pollMs, wait.lastPollAt);
  // Started, and then the listing could not be had: the session may well be up, so this is
  // unknown, not a failed start.
  if (s instanceof Unreachable) throw new Unreachable(s.host, s.why, `${agent.name} was started (launch id ${sid}), and then ${s.message}`);
  if (!s) {
    const there = agent.host ? ` on host ${t.where}` : "";
    const also = agent.host ? ` there, and \`factory doctor\` for whether ${t.where} answers` : "";
    die(`${agent.name} did not appear in \`claude agents\`${there} within ${Math.round(waitS)}s (launch id ${sid}). Check \`claude logs ${sid}\`${also}.`);
  }
  // The agent's ended rows go once a start is up (stopped.ts); a caller with a deadline (the hook's
  // wake) has no time for the listing and the removals, and leaves them to the next start.
  if (wait.lastPollAt === undefined || wait.lastPollAt === Infinity) clearEnded(agent.name, t, s.id);
  return s;
}

const leadName = (ws: Workspace) => capitalize(lead(ws).name);

// The handoff a build session leaves for its fix round: beside the worktree, so never committed.
export const handoffPath = (wt: string) => `${wt.replace(/\/+$/, "")}.handoff.md`;

const localNote = (ticket: string) => isLocal(ticket)
  ? " This item has no tracker ticket, and its key is factory bookkeeping: leave it out of the " +
    "PR title and the commit message, which are the description alone."
  : "";

export function buildingPrompt(ws: Workspace, agent: Agent, ticket: string, handoff?: string): string {
  return `You are ${capitalize(agent.name)}. Your work item is ${ticket}. This is a BUILDING session in ` +
    `the worktree on branch ${branchFor(ticket)}. Read the repo rules in this directory, then reply exactly ` +
    `READY and wait for ${leadName(ws)}'s brief. The brief is the whole specification: there is no plan ` +
    `artifact and nothing else is coming. Do not start before it arrives.` +
    (handoff ? ` When you open the PR, write the handoff for the fix round to ${handoff}: what was built, ` +
      `decisions and why, where things are, how to run the checks, what is open.` : "") +
    localNote(ticket);
}

// A fix round starts fresh in the build's worktree and comes back in through the handoff, which the
// build session wrote when it opened the PR: what it built, never the findings, which come by message.
export function fixingPrompt(ws: Workspace, agent: Agent, ticket: string, handoff: string): string {
  return `You are ${capitalize(agent.name)}. Your work item is ${ticket}, and this is its FIX ROUND, in a fresh ` +
    `session in the worktree on branch ${branchFor(ticket)}. Read the repo rules in this directory and the ` +
    `handoff at ${handoff}, which the build session wrote when it opened the PR: what it built, decisions, ` +
    `where things are and how to run the checks. It can be missing, for an item built before handoffs. The ` +
    `review findings are not in it: they come by message, from the reviewer or ${leadName(ws)}. Reply exactly ` +
    `READY and wait for them. Then fix them, run the tests and lint as one command, push, and send the new sha ` +
    `straight to the reviewer. Later rounds come to this session.` + localNote(ticket);
}

export const reviewerPrompt = (ws: Workspace) =>
  `You are one of ${leadName(ws)}'s reviewers. Read CLAUDE.md, reply exactly READY, and wait for the review brief.`;

export const assistantPrompt = (ws: Workspace) =>
  `You are one of ${leadName(ws)}'s assistants. Read CLAUDE.md, reply exactly READY, and wait for a task from ${leadName(ws)}.`;

export const designerPrompt = (ws: Workspace, agent: Agent, ticket: string) =>
  `You are ${capitalize(agent.name)}, one of ${leadName(ws)}'s designers. Your work item is ${ticket}. Read ` +
  `CLAUDE.md, reply exactly READY, and wait for ${leadName(ws)}'s design brief. Do not start before it arrives.`;

export const leadPrompt = (ws: Workspace) =>
  `You are ${leadName(ws)}. Read CLAUDE.md, then run \`factory status\` and read every record in ` +
  `state/. Say in one message what is in flight and what is waiting on ${ws.config.human.name}. Then wait for messages.`;
