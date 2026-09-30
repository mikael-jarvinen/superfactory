#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { followInbox } from "./board/inbox.js";
import { boardLine, runBoard, startBoard, stopBoard } from "./board/server.js";
import { doctor } from "./doctor.js";
import { agentOrDie, byRole, claudeBin, findSession, fleetLines, lead, type Session, sessionAlive, sessions, stopSession, waitForName } from "./fleet.js";
import { buildAppendix, buildingPrompt, launch, leadPrompt, reviewerPrompt, roleOf } from "./launch.js";
import { hook as guardHook } from "./hooks/guard.js";
import { hook as noDialogsHook } from "./hooks/no-dialogs.js";
import { hook as noSideChannelsHook } from "./hooks/no-side-channels.js";
import { hook as statusHook } from "./hooks/status.js";
import { comment } from "./gate/comment.js";
import { deltaRange } from "./gate/delta.js";
import { demo, demoInit } from "./gate/demo.js";
import { prNumber, resolveRepo } from "./gate/github.js";
import { media } from "./gate/media.js";
import { ready, report } from "./gate/ready.js";
import { send } from "./gate/send.js";
import { ACCEPT_PROSE, waitAndSend } from "./gate/wait.js";
import { KINDS, type Kind, messages, say } from "./messages.js";
import { type HookName, type HookResult, HOOKS } from "./settings.js";
import { install, render, status as scheduleStatus, uninstall } from "./scheduler/launchd.js";
import { cmdStack, STACK_USAGE } from "./stacks/command.js";
import { exportStacks } from "./stacks/engine.js";
import {
  allRecs, appendEvent, BUSY, DISPATCHABLE, KEY_HINT, loadRec, removeRec, saveRec, showRec, transition, validKey,
} from "./state.js";
import { FactoryError, now, pyDumps, pyRepr, run, sleep, squash } from "./util.js";
import { failure } from "./watchers/job.js";
import { runQueue } from "./watchers/queue.js";
import { relay } from "./watchers/relay.js";
import { runRound } from "./watchers/round.js";
import { branchPushed, ensureWorktree, git, worktreeDirty } from "./worktree.js";
import { openWorkspace, resolveWorkspace, type Workspace } from "./workspace.js";

const USAGE = `factory: start, stop, dispatch and track a fleet of Claude Code sessions.

usage: factory [--workspace <dir>] <command> [options]

  doctor                          what this machine and workspace lack to run the fleet: one
                                  \`ok\` or \`MISSING ... [fix: ...]\` line per check, derived from
                                  config, then each stack script's own doctor. Reads only.
                                  Exit 1 when anything is missing.
  up [--fresh]                    start the board, and the lead (resuming its thread if one exists)
  down                            stop every fleet session and the board
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
  board [--stop]                  start the board in the background, or stop it
  board --serve                   run the board in this process
  board --inbox                   print each new message from the message page, for a monitor in
                                  the lead's session. One holds the inbox at a time.
  pr-ready <repo> <n> [--allow-draft]
                                  may this PR be sent? Every question about its current head sha; a
                                  missing answer is a failure. <repo> is a key of [repos] or its
                                  owner/repo. Exit 0 sendable, 1 not, 2 unreadable.
  pr-send <repo> <n> <reviewed-sha>
                                  gate, undraft, check the head did not move, print the link and
                                  the push text. The only undraft there is.
  pr-wait <repo> <n> <reviewed-sha>
                                  wait while what is left is running or pending, then pr-send. Stops
                                  at once on anything waiting cannot clear, and before sending when
                                  the gate remarks on prose volume unless ${ACCEPT_PROSE}=1.
  delta-range <repo> <n> <base-sha>
                                  may this fix range go to a reviewer? Refuses an empty range and a
                                  base the PR head has never been.
  pr-comment <repo> <n> <agent> <body-file> <bot-comment-id> [--dry-run]
                                  reply inside a bot's review thread; never a standalone comment,
                                  never to a person. The bots are github.bots.
  pr-media <repo> <n> (--dir <media-dir> | --no-visual-change) [--dry-run]
                                  put a demo's screenshots and video into the PR body
  demo <KEY> --init               copy the demo template to /tmp/demo/<KEY>/demo.spec.ts
  demo <KEY> <spec.ts> [base-url] run a Playwright demo from the worktree; media in /tmp/demo/<KEY>
  watch queue                     read the tracker's queue once, and tell the lead about new queued
                                  tickets and fresh merges. What the scheduler runs; prompts/queue.md.
  watch round [--facts]           the round once: facts gathered here, judged by a disposable session
                                  that tells the lead what needs judgement; prompts/round.md.
                                  --facts prints the facts and runs nothing.
  schedule render|install|uninstall|status
                                  the launchd jobs from [watchers]: render them into
                                  logs/run/launchd/, load or unload them for this user, or show
                                  what is installed and loaded
  hook <${HOOKS.join("|")}> [...]
                                  a Claude Code hook, reading the event on stdin. The rendered
                                  settings in logs/run/ call these; nothing else needs to.
${STACK_USAGE}

The workspace is --workspace, else $FACTORY_WORKSPACE, else the nearest factory.toml above the
current directory. Only this program writes the state store.

states: queued building pr-open agent-review fixing gate your-review colleague-review done blocked`;

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
  // the board's stacks panel reads this export, so write it before the board's first check
  exportStacks(ws);
  startBoard(ws, true);
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
  stopBoard(ws, true);
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

function cmdBoard(ws: Workspace, argv: string[]) {
  const { v } = args("board", argv, { stop: { type: "boolean" }, serve: { type: "boolean" }, inbox: { type: "boolean" } }, [0, 0]);
  if ([v.stop, v.serve, v.inbox].filter(Boolean).length > 1) throw new UsageError("board: give one of --stop, --serve or --inbox");
  if (v.inbox) followInbox(ws);
  // The courier carries a page line to the lead while no inbox monitor is armed.
  else if (v.serve) runBoard(ws, { relay });
  else if (v.stop) stopBoard(ws);
  else startBoard(ws);
}

function cmdMessages(ws: Workspace, argv: string[]) {
  const { v } = args("messages", argv, { n: { type: "string", short: "n" } }, [0, 0]);
  const n = v.n === undefined ? 20 : Number(v.n);
  if (!Number.isInteger(n)) throw new UsageError(`messages: -n: invalid int value: ${pyRepr(String(v.n))}`);
  messages(ws, n);
}

function cmdPrReady(ws: Workspace, argv: string[]): number {
  const { v, p } = args("pr-ready", argv, { "allow-draft": { type: "boolean" } }, [2, 2]);
  const verdict = ready(ws, resolveRepo(ws, p[0] as string), prNumber(p[1] as string), { allowDraft: !!v["allow-draft"] });
  for (const l of report(verdict)) console.log(l);
  return verdict.sendable ? 0 : 1;
}

function cmdPrSend(ws: Workspace, argv: string[]) {
  const { p } = args("pr-send", argv, {}, [3, 3]);
  send(ws, resolveRepo(ws, p[0] as string), prNumber(p[1] as string), p[2] as string);
}

function cmdPrWait(ws: Workspace, argv: string[]) {
  const { p } = args("pr-wait", argv, {}, [3, 3]);
  waitAndSend(ws, resolveRepo(ws, p[0] as string), prNumber(p[1] as string), p[2] as string);
}

function cmdDeltaRange(ws: Workspace, argv: string[]): number {
  const { p } = args("delta-range", argv, {}, [3, 3]);
  return deltaRange(resolveRepo(ws, p[0] as string), prNumber(p[1] as string), p[2] as string);
}

function cmdPrComment(ws: Workspace, argv: string[]) {
  const { v, p } = args("pr-comment", argv, { "dry-run": { type: "boolean" } }, [5, 5]);
  const [repo, n, agent, bodyFile, replyTo] = p as [string, string, string, string, string];
  comment(ws, resolveRepo(ws, repo), prNumber(n), { agent, bodyFile, replyTo, dryRun: !!v["dry-run"] });
}

// The upload is a fetch, so this one finishes after main returns; its failure is reported the way
// main's own would be.
function cmdPrMedia(ws: Workspace, argv: string[]) {
  const { v, p } = args("pr-media", argv, { dir: { type: "string" }, "no-visual-change": { type: "boolean" }, "dry-run": { type: "boolean" } }, [2, 2]);
  if (!!v.dir === !!v["no-visual-change"]) throw new UsageError("pr-media: give --dir <media-dir> or --no-visual-change");
  const repo = resolveRepo(ws, p[0] as string);
  media(repo, prNumber(p[1] as string), { dir: str(v.dir), noVisualChange: !!v["no-visual-change"], dryRun: !!v["dry-run"] }).catch((e: unknown) => {
    if (!(e instanceof FactoryError)) throw e;
    console.error(`factory: ${e.message}`);
    process.exitCode = e.code;
  });
}

function cmdDemo(ws: Workspace, argv: string[]): number | void {
  const { v, p } = args("demo", argv, { init: { type: "boolean" } }, [1, 3]);
  const [key, spec, base] = p as [string, string | undefined, string | undefined];
  if (v.init) {
    if (spec) throw new UsageError("demo: --init takes only the key");
    return demoInit(ws, key);
  }
  if (!spec) throw new UsageError("demo: which spec? factory demo <KEY> <spec.ts> [base-url], or --init for the template");
  return demo(ws, key, spec, base);
}

// A scheduled run that dies before it starts leaves a line where the round looks, not only in the
// launchd log nobody reads.
function cmdWatch(ws: Workspace, argv: string[]): number {
  const { v, p } = args("watch", argv, { facts: { type: "boolean" } }, [1, 1]);
  const job = p[0] as string;
  if (job !== "queue" && job !== "round") throw new UsageError(`watch: ${pyRepr(job)} is not a watcher; watchers are queue, round`);
  if (v.facts && job !== "round") throw new UsageError("watch: --facts is for the round");
  try {
    return job === "queue" ? runQueue(ws) : runRound(ws, { factsOnly: !!v.facts });
  } catch (e) {
    if (e instanceof FactoryError && !v.facts) failure(ws, `${job} FAILED: ${e.message.split("\n")[0]}`);
    throw e;
  }
}

function cmdSchedule(ws: Workspace, argv: string[]): number {
  const { p } = args("schedule", argv, {}, [1, 1]);
  const verb = p[0] as string;
  if (verb === "render") {
    for (const r of render(ws)) console.log(`rendered ${r.path}`);
    return 0;
  }
  if (verb === "install") return install(ws);
  if (verb === "uninstall") return uninstall(ws);
  if (verb === "status") return scheduleStatus(ws);
  throw new UsageError(`schedule: ${pyRepr(verb)}; give render, install, uninstall or status`);
}

// The board port check binds, which is asynchronous, so this one finishes after main returns.
function cmdDoctor(ws: Workspace, argv: string[]) {
  args("doctor", argv, {}, [0, 0]);
  doctor(ws).then((code) => {
    if (code) console.error("factory: something is missing; each MISSING line says how to fix it");
    process.exitCode = code;
  }, (e: unknown) => {
    if (!(e instanceof FactoryError)) throw e;
    console.error(`factory: ${e.message}`);
    process.exitCode = e.code;
  });
}

const COMMANDS: Record<string, (ws: Workspace, argv: string[]) => number | void> = {
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
  "board": cmdBoard,
  "pr-ready": cmdPrReady,
  "pr-send": cmdPrSend,
  "pr-wait": cmdPrWait,
  "delta-range": cmdDeltaRange,
  "pr-comment": cmdPrComment,
  "pr-media": cmdPrMedia,
  "demo": cmdDemo,
  "stack": cmdStack,
  "watch": cmdWatch,
  "schedule": cmdSchedule,
  "doctor": cmdDoctor,
};

const HOOK_FNS: Record<HookName, (argv: string[], input: string, workspace?: string) => HookResult> = {
  "guard": guardHook,
  "status": statusHook,
  "no-dialogs": noDialogsHook,
  "no-side-channels": noSideChannelsHook,
};

// Runs before the workspace is opened: everything a hook needs is on its command line, and a
// guard must answer even when factory.toml does not load. Exit 2 blocks the tool call.
function cmdHook(argv: string[], workspace: string | undefined): number {
  const [name, ...rest] = argv;
  const fn = HOOK_FNS[name as HookName];
  if (!fn) throw new UsageError(`hook: ${name ? `no hook ${pyRepr(name)}` : "which hook?"}; hooks are ${HOOKS.join(", ")}`);
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    input = "";
  }
  const r = fn(rest, input, workspace);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.code;
}

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
  if (cmd === "hook") return cmdHook(rest, workspace);
  const fn = COMMANDS[cmd];
  if (!fn) throw new UsageError(`unknown command ${pyRepr(cmd)}; see factory --help`);
  const ws = openWorkspace(resolveWorkspace({ flag: workspace }));
  // Every session and job started from here resolves to the same workspace, and memory is off
  // fleet-wide: the env var beats any settings file.
  process.env.FACTORY_WORKSPACE = ws.dir;
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return fn(ws, rest) ?? 0;
}

// A reader that stops early, such as `factory messages | head`, closes the pipe under a write. That
// is the reader being done, so it ends the command quietly instead of as an unhandled error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
  process.exit(0);
});

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof FactoryError)) throw e;
  console.error(`factory: ${e.message}`);
  process.exitCode = e.code;
}
