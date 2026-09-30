#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { agentOrDie, byRole, claudeBin, findSession, fleetLines, lead, type Session, sessionAlive, sessions, stopSession, waitForName } from "./fleet.js";
import { buildAppendix, buildingPrompt, launch, leadPrompt, reviewerPrompt, roleOf } from "./launch.js";
import { KINDS, type Kind, messages, say } from "./messages.js";
import {
  allRecs, appendEvent, BUSY, DISPATCHABLE, KEY_HINT, loadRec, removeRec, saveRec, showRec, transition, validKey,
} from "./state.js";
import { FactoryError, now, pyDumps, pyRepr, run, sleep, squash } from "./util.js";
import { branchPushed, ensureWorktree, git, worktreeDirty } from "./worktree.js";
import { openWorkspace, resolveWorkspace, type Workspace } from "./workspace.js";

const USAGE = `factory: start, stop, dispatch and track a fleet of Claude Code sessions.

usage: factory [--workspace <dir>] <command> [options]

  up [--fresh]                    start the lead (resume its thread if one exists)
  down                            stop every fleet session
  restart-lead [--fresh]          stop the lead, then up
  status [--all]                  sessions joined with the state store
  sessions [--all] [--fleet]      raw \`claude agents --json\`, or one line per fleet member
  dispatch <agent> <KEY> [--repo <repo>] [--prompt-file <f>] [--force]
                                  fresh building session for one item in a per-item worktree.
                                  Dispatch from queued, building or fixing; anywhere else needs
                                  --force. A live session already on KEY keeps its context.
  stop <agent> [--force] [--remove-worktree]
                                  stop a teammate; refuses on uncommitted or unpushed work. Keeps
                                  the worktree unless --remove-worktree.
  review [--name <r>] [--prompt-file <f>] [--force]
                                  a fresh reviewer for one review: the first free one
  state <KEY>                     show one record
  state <KEY> --title "<words>"   what it is about, for the board. No transition.
  state <KEY> <new-state> [--agent A] [--stack S] [--evidence E] [--note N] [--title T]
        [--pr owner/repo#N] [--head SHA] [--reviewed SHA] [--jira STATUS] [--force]
                                  transition
  state --list [--all]            every open item
  drop <LOCAL-key>... [--note N] [--force]
                                  delete a LOCAL record; tracker tickets are never droppable
  say "<text>" [--ticket K] [--link URL] [--kind ${KINDS.join("|")}]
                                  post to the message page and ring the machine
                                  (SF_NOTIFY=0 mutes it, SF_NOTIFY_SOUND names the sound)
  messages [-n 20]                the last n messages. Never read the log whole: it is
                                  append-only and unbounded.

Not built yet: board (phase 3), pr-ready, pr-send, pr-wait, delta-range, pr-comment, pr-media
and demo (phase 4), stack (phase 5), hook (phase 2), doctor (phase 7).

The workspace is --workspace, else $FACTORY_WORKSPACE, else the nearest factory.toml above the
current directory. Only this program writes the state store.

states: queued building pr-open agent-review fixing gate your-review colleague-review done blocked`;

const STUBS: Record<string, [number, string]> = {
  "hook": [2, "hooks as package modules"],
  "board": [3, "the board"],
  "pr-ready": [4, "the gate"],
  "pr-send": [4, "the gate"],
  "pr-wait": [4, "the gate"],
  "delta-range": [4, "the gate"],
  "pr-comment": [4, "the gate"],
  "pr-media": [4, "the gate"],
  "demo": [4, "the gate"],
  "stack": [5, "stacks"],
  "doctor": [7, "doctor"],
};

class UsageError extends FactoryError {
  constructor(message: string) {
    super(message, 2);
  }
}

type Options = NonNullable<ParseArgsConfig["options"]>;

function args(cmd: string, argv: string[], options: Options, positionals: [min: number, max: number]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(`${cmd}: ${(e as Error).message}`);
  }
  if (parsed.values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const [min, max] = positionals;
  if (parsed.positionals.length < min) throw new UsageError(`${cmd}: missing arguments; see factory --help`);
  if (parsed.positionals.length > max) throw new UsageError(`${cmd}: unexpected ${parsed.positionals.slice(max).map(pyRepr).join(" ")}`);
  return { v: parsed.values as Record<string, string | boolean | undefined>, p: parsed.positionals };
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

function boardLine(ws: Workspace): string {
  const { host, port } = ws.config.board;
  let pid: number | undefined;
  try {
    pid = Number.parseInt(readFileSync(join(ws.logsDir, "board.pid"), "utf8").trim(), 10);
    process.kill(pid, 0);
    if (!run("ps", ["-o", "command=", "-p", String(pid)]).stdout.includes("board.py")) pid = undefined;
  } catch {
    pid = undefined;
  }
  return pid ? `  board      http://${host}:${port} (pid ${pid})` : "  board      not running";
}

function cmdStatus(ws: Workspace, argv: string[]) {
  const { v } = args("status", argv, { all: { type: "boolean" } }, [0, 0]);
  console.log("-- sessions --");
  const { lines, live } = fleetLines(ws);
  console.log(lines.join("\n"));
  console.log(boardLine(ws));
  console.log("-- tickets (state/) --");
  const recs = v.all ? allRecs(ws) : allRecs(ws).filter((r) => r.state !== "done");
  if (!recs.length) console.log("  none");
  for (const r of recs) {
    for (const l of showRec(ws, r)) console.log(l);
    if (r.state && BUSY.has(r.state) && r.agent && !live.has(r.agent))
      console.log(`  ${"".padEnd(12)} !! ${r.agent} has no live session while ${r.ticket} is ${r.state} -- dropped delegation?`);
  }
}

function cmdState(ws: Workspace, argv: string[]) {
  const s = { type: "string" } as const;
  const { v, p } = args("state", argv, {
    list: { type: "boolean" }, all: { type: "boolean" }, force: { type: "boolean" },
    agent: s, stack: s, evidence: s, note: s, title: s, pr: s, head: s, reviewed: s, jira: s,
  }, [0, 2]);
  const [ticket, next] = p;
  if (v.list) {
    const recs = v.all ? allRecs(ws) : allRecs(ws).filter((r) => r.state !== "done");
    for (const r of recs) for (const l of showRec(ws, r)) console.log(l);
    if (!recs.length) console.log("  no open tickets");
    return;
  }
  if (!ticket) throw new FactoryError("state needs a ticket, or --list");
  if (!next) {
    const rec = loadRec(ws, ticket);
    if (!rec) throw new FactoryError(`no record for ${ticket}`);
    const title = str(v.title);
    if (title) {
      rec.title = squash(title, 90);
      saveRec(ws, rec);
    }
    for (const l of showRec(ws, rec)) console.log(l);
    console.log(pyDumps(rec, { indent: 2, sortKeys: true }));
    return;
  }
  transition(ws, ticket, next, {
    agent: str(v.agent), evidence: str(v.evidence), pr: str(v.pr), head: str(v.head), reviewed: str(v.reviewed),
    jira: str(v.jira), stack: str(v.stack), note: str(v.note), force: !!v.force, title: str(v.title),
  });
}

function cmdDispatch(ws: Workspace, argv: string[]) {
  const { v, p } = args("dispatch", argv, { repo: { type: "string" }, "prompt-file": { type: "string" }, force: { type: "boolean" } }, [2, 2]);
  const [name, ticket] = p as [string, string];
  const force = !!v.force;
  const ag = agentOrDie(ws, name);
  if (ag.role !== "builder") throw new FactoryError(`${name} is a ${ag.role}, not a builder. Reviewers are started per review with \`factory review\`.`);
  if (!validKey(ws, ticket)) throw new FactoryError(`${pyRepr(ticket)} is ${KEY_HINT}`);
  const allowed = ag.repos;
  const repoKey = str(v.repo) ?? (allowed[0] as string);
  if (!allowed.includes(repoKey)) throw new FactoryError(`${name} works in [${allowed.map(pyRepr).join(", ")}]; --repo ${repoKey} is another stack`);
  const repo = ws.config.repos[repoKey]!;
  const stack = ag.stack ?? repoKey;
  // A builder keeps its session across the rounds of one work item and is cleared only when it
  // starts a different one. A fix round on the item the live session is already on keeps that
  // session and its context: the brief goes to it by SendMessage, and this only records the state.
  const s = findSession(name);
  if (sessionAlive(s)) {
    const on = basename((s.cwd ?? "").replace(/\/+$/, ""));
    if (on === ticket && !force) {
      if (loadRec(ws, ticket)?.state !== "fixing")
        transition(ws, ticket, "fixing", { agent: name, evidence: `fix round sent to the live session ${s.id}, context kept` });
      console.log(`${name} is still on ${ticket} (${s.id}), so it keeps its context.`);
      console.log(`  next: SendMessage the fix brief to ${name}; no new session was started`);
      return;
    }
    if (force) {
      console.log(`${name} is running (${s.id}); --force given, stopping it`);
      stopSession(s);
    } else {
      throw new FactoryError(`${name} is still on ${on || s.cwd} (${s.id}). Starting ${ticket} is a new work item, which clears ` +
        `the session: \`factory stop ${name}\` first. It checks for uncommitted work.`);
    }
  }
  // One active item per agent, and the store agrees.
  for (const r of allRecs(ws))
    if (r.agent === name && r.state && BUSY.has(r.state) && r.ticket !== ticket)
      throw new FactoryError(`${name} is recorded as ${r.state} on ${r.ticket}. Finish or re-state that first.`);
  const rec = loadRec(ws, ticket);
  const cur = rec?.state ?? null;
  if (!DISPATCHABLE.has(cur) && !force)
    throw new FactoryError(`${ticket} is ${cur}; a dispatch makes no sense there. Use \`factory state\` first, ` +
      `or --force if you mean it (a verification run on a sent PR, say).`);
  const { wt, how } = ensureWorktree(repo.path, ticket, repo.base);
  const appendix = buildAppendix(ws, ag, repo.path);
  const promptFile = str(v["prompt-file"]);
  const prompt = promptFile ? readFileSync(promptFile, "utf8") : buildingPrompt(ws, ag, ticket);
  const started = launch(ws, ag, wt, prompt, appendix, "build");
  if (rec === null || cur === "queued") {
    transition(ws, ticket, "building", { agent: name, stack, worktree: wt, evidence: `building session ${started.id}` });
  } else {
    rec.agent = name;
    rec.worktree = wt;
    saveRec(ws, rec);
    appendEvent(ws, { t: now(), ticket, from: cur, to: cur, agent: name, evidence: `re-dispatched (building session ${started.id})`, note: how, pr: rec.pr ?? null });
  }
  console.log(`${name} started (${started.id}) for ${ticket} as a BUILDING session`);
  console.log(`  worktree ${wt} (${how})`);
  console.log(`  appendix ${appendix ?? "-"}`);
  console.log(`  next: SendMessage to ${name}: what to build or fix, the scope, and notify_when_idle`);
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

function cmdStop(ws: Workspace, argv: string[]) {
  const { v, p } = args("stop", argv, { force: { type: "boolean" }, "remove-worktree": { type: "boolean" }, "keep-worktree": { type: "boolean" } }, [1, 1]);
  const name = p[0] as string;
  const ag = agentOrDie(ws, name);
  const s = findSession(name);
  if (!sessionAlive(s)) {
    console.log(`${name} is not running`);
    return;
  }
  const cwd = s.cwd;
  const builder = ag.role === "builder";
  if (cwd && isDir(cwd) && builder) {
    const left = worktreeDirty(cwd, ws.config.worktree.toolWritten);
    if (left.length && !v.force)
      throw new FactoryError(`${name}'s worktree ${cwd} has uncommitted changes: ${left.slice(0, 4).join(", ")}. Ask them to commit and push, or --force to lose it.`);
    let base = "main";
    for (const r of Object.values(ws.config.repos)) if (cwd.startsWith(r.path + "/")) base = r.base;
    if (!branchPushed(cwd, base) && !v.force) throw new FactoryError(`${name}'s branch in ${cwd} is not fully pushed. Ask them to push, or --force.`);
  }
  stopSession(s);
  console.log(`stopped ${name} (${s.id})`);
  // The worktree stays unless asked for: a worktree can hold a running stack and its database.
  if (cwd && builder && isDir(cwd) && cwd.includes("/.claude/worktrees/")) {
    if (v["remove-worktree"] && !v["keep-worktree"]) {
      const repoDir = cwd.split("/.claude/worktrees/")[0] as string;
      const r = git(repoDir, "worktree", "remove", cwd);
      console.log(r.status === 0 ? "  worktree removed" : `  worktree kept: ${r.stderr.trim()}`);
    } else {
      console.log(`  worktree kept: ${cwd}`);
    }
  }
}

// A review is always a fresh session, because a reviewer carrying a previous diff is the one thing
// that makes two passes agree for the wrong reason. Reviewers are interchangeable, so this takes
// the first free one in config order and refuses only when every one is occupied.
function cmdReview(ws: Workspace, argv: string[]) {
  const { v } = args("review", argv, { "prompt-file": { type: "string" }, name: { type: "string" }, force: { type: "boolean" } }, [0, 0]);
  let names = byRole(ws, "reviewer").map((a) => a.name);
  const want = str(v.name);
  if (want) {
    if (!names.includes(want)) throw new FactoryError(`${pyRepr(want)} is not a reviewer. Reviewers: ${names.join(", ")}`);
    names = [want];
  }
  const promptFile = str(v["prompt-file"]);
  const start = (name: string) => {
    const ag = agentOrDie(ws, name);
    const prompt = promptFile ? readFileSync(promptFile, "utf8") : reviewerPrompt(ws);
    return launch(ws, ag, roleOf(ws, ag).cwd as string, prompt);
  };
  const busy: string[] = [];
  for (const name of names) {
    const s = findSession(name);
    if (sessionAlive(s)) {
      busy.push(`${name} (${s.id})`);
      continue;
    }
    console.log(`${name} started (${start(name).id})`);
    return;
  }
  if (v.force && busy.length) {
    const name = names[0] as string;
    stopSession(findSession(name));
    console.log(`${name} restarted (${start(name).id})`);
    return;
  }
  throw new FactoryError(`every reviewer is busy: ${busy.join(", ")}. Stop one, or pass --force to restart the first.`);
}

function up(ws: Workspace, fresh: boolean) {
  const ld = lead(ws);
  console.log("board: not started; the board arrives in phase 3");
  const s = findSession(ld.name);
  if (sessionAlive(s)) {
    console.log(`${ld.name} already running (${s.id})`);
    return;
  }
  const stamp = (x: Session) => String(x.updatedAt || x.startedAt || x.createdAt || "");
  const old = sessions(true).filter((x) => x.name === ld.name && x.kind === "background");
  // newest first, by whatever timestamp the listing carries; the list order itself is not documented
  old.sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));
  if (old.length && !fresh) {
    const sid = old[0]!.id as string;
    const r = run(claudeBin(), ["respawn", sid]);
    if (r.status === 0 && waitForName(ld.name, 60)) {
      console.log(`${ld.name} respawned from ${sid}: ${r.stdout.trim()}`);
      return;
    }
    console.log(`respawn of ${sid} did not come back (${r.stderr.trim() || r.stdout.trim()}); starting fresh`);
  }
  const cwd = roleOf(ws, ld).cwd as string;
  const started = launch(ws, ld, cwd, leadPrompt(ws));
  console.log(`${ld.name} started (${started.id}) in ${cwd}${ld.remoteControl ? " with Remote Control" : ""}`);
}

function cmdUp(ws: Workspace, argv: string[]) {
  const { v } = args("up", argv, { fresh: { type: "boolean" } }, [0, 0]);
  up(ws, !!v.fresh);
}

function cmdDown(ws: Workspace, argv: string[]) {
  args("down", argv, {}, [0, 0]);
  const names = new Set(ws.config.agents.map((a) => a.name));
  for (const s of sessions())
    if (s.name && names.has(s.name) && s.kind === "background") {
      console.log(`stopping ${s.name} (${s.id})`);
      stopSession(s, false);
    }
  console.log("board: not stopped; the board arrives in phase 3");
}

function cmdRestartLead(ws: Workspace, argv: string[]) {
  const { v } = args("restart-lead", argv, { fresh: { type: "boolean" } }, [0, 0]);
  const name = lead(ws).name;
  const s = findSession(name);
  if (sessionAlive(s)) {
    stopSession(s, false);
    // wait for the supervisor to report it stopped, or up sees it as running
    for (let i = 0; i < 20 && sessionAlive(findSession(name)); i++) sleep(1000);
    console.log(`stopped ${name}`);
  }
  up(ws, !!v.fresh);
}

function cmdSessions(ws: Workspace, argv: string[]) {
  const { v } = args("sessions", argv, { all: { type: "boolean" }, fleet: { type: "boolean" } }, [0, 0]);
  if (v.fleet) console.log(fleetLines(ws).lines.join("\n"));
  else console.log(pyDumps(sessions(!!v.all), { indent: 2 }));
}

// A tracker ticket is never droppable: its record is the factory's half of something that exists
// outside the factory.
function cmdDrop(ws: Workspace, argv: string[]) {
  const { v, p } = args("drop", argv, { note: { type: "string" }, force: { type: "boolean" } }, [1, Infinity]);
  for (const ticket of p) {
    if (!ticket.startsWith("LOCAL-"))
      throw new FactoryError(`${ticket} is not a LOCAL key. Only ad-hoc local items can be dropped; a tracker ticket's record follows the ticket.`);
    const rec = loadRec(ws, ticket);
    if (!rec) {
      console.log(`  ${ticket}: no record`);
      continue;
    }
    if ((rec.state === "building" || rec.state === "fixing") && !v.force)
      throw new FactoryError(`${ticket} is ${rec.state} with agent=${rec.agent ?? "None"}. Stop the teammate first, or pass --force.`);
    appendEvent(ws, { ticket, at: now(), event: "dropped", from_state: rec.state, note: str(v.note) ?? null });
    removeRec(ws, ticket);
    console.log(`  dropped ${ticket} (was ${rec.state})`);
  }
}

function cmdSay(ws: Workspace, argv: string[]) {
  const s = { type: "string" } as const;
  const { v, p } = args("say", argv, { ticket: s, link: s, kind: s }, [1, Infinity]);
  const kind = str(v.kind) ?? "note";
  if (!(KINDS as readonly string[]).includes(kind))
    throw new UsageError(`say: --kind: invalid choice: ${pyRepr(kind)} (choose from ${KINDS.map(pyRepr).join(", ")})`);
  say(ws, p, { ticket: str(v.ticket), link: str(v.link), kind: kind as Kind });
}

function cmdMessages(ws: Workspace, argv: string[]) {
  const { v } = args("messages", argv, { n: { type: "string", short: "n" } }, [0, 0]);
  const n = v.n === undefined ? 20 : Number(v.n);
  if (!Number.isInteger(n)) throw new UsageError(`messages: -n: invalid int value: ${pyRepr(String(v.n))}`);
  messages(ws, n);
}

const COMMANDS: Record<string, (ws: Workspace, argv: string[]) => void> = {
  "up": cmdUp,
  "down": cmdDown,
  "restart-lead": cmdRestartLead,
  "status": cmdStatus,
  "sessions": cmdSessions,
  "dispatch": cmdDispatch,
  "stop": cmdStop,
  "review": cmdReview,
  "state": cmdState,
  "drop": cmdDrop,
  "say": cmdSay,
  "messages": cmdMessages,
};

export function main(argv: string[]): number {
  let workspace: string | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (a === "--workspace") {
      workspace = argv[++i];
      if (workspace === undefined) throw new UsageError("--workspace needs a directory");
    } else if (a.startsWith("--workspace=")) workspace = a.slice("--workspace=".length);
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}; see factory --help`);
    else break;
  }
  const cmd = argv[i];
  const rest = argv.slice(i + 1);
  if (!cmd) {
    console.error(USAGE);
    return 2;
  }
  const stub = STUBS[cmd];
  if (stub) {
    console.error(`factory ${cmd}: not built yet; ${stub[1]} arrives in phase ${stub[0]}`);
    return 1;
  }
  const fn = COMMANDS[cmd];
  if (!fn) throw new UsageError(`unknown command ${pyRepr(cmd)}; see factory --help`);
  const ws = openWorkspace(resolveWorkspace({ flag: workspace }));
  // Every session and job started from here resolves to the same workspace, and memory is off
  // fleet-wide: the env var beats any settings file.
  process.env.FACTORY_WORKSPACE = ws.dir;
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  fn(ws, rest);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof FactoryError)) throw e;
  console.error(`factory: ${e.message}`);
  process.exitCode = e.code;
}
