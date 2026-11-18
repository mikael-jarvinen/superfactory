#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { recordAllowClose } from "./allow-close.js";
import { followInbox } from "./board/inbox.js";
import { markHandledMany, queue as waitingQueue, queueTrouble } from "./board/queue.js";
import { boardLine, runBoard, startBoard, stopBoard } from "./board/server.js";
import { doctor } from "./doctor.js";
import { agentOrDie, builderLeft, byRole, findSession, fleetLines, owedNote, owesSession, lead, listing, type Session, stopSession, stopWorktree, waitForName } from "./fleet.js";
import { Unreachable } from "./remote.js";
import { agentSessions, transportFor, transports } from "./transport.js";
import type { Agent } from "./config.js";
import { assistantPrompt, buildAppendix, buildingPrompt, designerPrompt, launch, leadPrompt, reviewerPrompt, roleAppendix, roleOf } from "./launch.js";
import { bringUpLead } from "./lead-up.js";
import { wake, wakeForRound, wokeLine } from "./wake.js";
import { hook as guardHook } from "./hooks/guard.js";
import { hook as noDialogsHook } from "./hooks/no-dialogs.js";
import { hook as noSideChannelsHook } from "./hooks/no-side-channels.js";
import { hook as statusHook } from "./hooks/status.js";
import { hook as wakeHook } from "./hooks/wake.js";
import { idleWork, idleWorkFor } from "./idle.js";
import { comment } from "./gate/comment.js";
import { deltaRange } from "./gate/delta.js";
import { demo, demoInit } from "./gate/demo.js";
import { prNumber, resolveRepo } from "./gate/github.js";
import { media } from "./gate/media.js";
import { openForReview } from "./gate/open.js";
import { ready, report } from "./gate/ready.js";
import { send } from "./gate/send.js";
import { ACCEPT_PROSE, waitAndSend } from "./gate/wait.js";
import { KINDS, type Kind, VIAS, type Via, messages, say } from "./messages.js";
import { type HookName, type HookResult, HOOKS } from "./settings.js";
import { schedule } from "./scheduler/index.js";
import { render } from "./scheduler/launchd.js";
import { runScheduler } from "./scheduler/run.js";
import { cmdStack, STACK_USAGE } from "./stacks/command.js";
import { cmdTicket, cmdWiki, TICKET_USAGE } from "./tickets/cli.js";
import { exportStacks, releaseForReview, slotless, startBoot } from "./stacks/engine.js";
import {
  allRecs, appendEvent, BUSY, OFF, onBoard, DESIGN_DISPATCHABLE, DISPATCHABLE, IN_REVIEW, KEY_HINT, loadRec, type Rec, removePr, removeRec, saveRec, showRec, transition, validKey,
} from "./state.js";
import { chars, FactoryError, now, pyDumps, pyRepr, run, sleep, squash } from "./util.js";
import { failure } from "./failures.js";
import { runQueue } from "./watchers/queue.js";
import { runRound } from "./watchers/round.js";
import { runReviews } from "./watchers/reviews.js";
import { openWorkspace, resolveWorkspace, type Workspace } from "./workspace.js";

const USAGE = `factory: start, stop, dispatch and track a fleet of Claude Code sessions.

usage: factory [--workspace <dir>] <command> [options]

  doctor                          what this machine and workspace lack to run the fleet: one
                                  \`ok\` or \`MISSING ... [fix: ...]\` line per check, derived from
                                  config, then each stack script's own doctor. Reads only.
                                  Exit 1 when anything is missing.
  up [--fresh]                    start the board, and the lead (resuming its thread if one exists);
                                  in the background, bring up every stack slot that does not answer
  down                            stop every fleet session and the board
  restart-lead [--fresh]          stop the lead, then up
  status [--all]                  sessions joined with the state store
  sessions [--all] [--fleet]      raw \`claude agents --json\`, or one line per fleet member
  dispatch <agent> <KEY> [--repo <repo>] [--prompt-file <f>] [--force]
                                  fresh building session for one item in a per-item worktree.
                                  Dispatch from the backlog, off the board, building or fixing; anywhere else needs
                                  --force. A live session already on KEY keeps its context, and
                                  so does one that is off, woken unless --force.
                                  For a designer: a design session in the designers' cwd, no
                                  worktree, from the backlog or off the board (records designing) or design-review
                                  (another round).
  wake <agent>                    bring back an agent whose session is off (stopped idle, or retired
                                  by Claude's daemon): respawn its newest session, same conversation,
                                  and wait until it is listed live. Exit 1 when it does not come back.
  stop <agent> [--force] [--remove-worktree]
                                  stop a teammate; refuses on uncommitted or unpushed work. Keeps
                                  the worktree unless --remove-worktree.
  review [--name <r>] [--prompt-file <f>] [--force]
                                  a fresh reviewer for one review: the first free one
  assistant [name] [--prompt-file <f>] [--force]
                                  start a lead assistant (vega or cruz; first free if unnamed) to
                                  take the lead's non-code work, then brief it by message. A named
                                  one that is off is woken on its conversation; --force starts fresh
  state <KEY>                     show one record
  state <KEY> --title "<words>"   what it is about, for the board. No transition.
  state <KEY> --remove-pr owner/repo#N [--note N]
                                  take a PR off the item, e.g. after a split. No transition.
  state <KEY> <new-state> [--agent A] [--stack S] [--evidence E] [--note N] [--title T]
        [--pr owner/repo#N] [--head SHA] [--reviewed SHA] [--jira STATUS] [--force]
        [--canvas URL] [--slides URL] [--approved "<the human's words>"]
                                  transition. design-review needs the canvas and slides links;
                                  design-review -> off is the approval and needs --approved.
                                  The first state is designing or building: work nobody is doing
                                  waits in the backlog, not on the board.
  state <KEY> off [--approved "<words>"] [--note N]
                                  take it off the board and keep the record (an approved design,
                                  the stack, the title) until a dispatch brings it back. From
                                  design-review it is the approval, from building it unassigns,
                                  and from a review it ends the slice, for the next slice of a
                                  multi-PR ticket
  state --list [--all]            every item on the board; --all adds done and off-board ones
  state --off                     every item off the board: key, agent and title
  drop <LOCAL-key>... [--note N] [--force]
                                  delete a LOCAL record; tracker tickets are never droppable
  say "<text>" [--ticket K] [--link URL] [--kind ${KINDS.join("|")}] [--via ${VIAS.join("|")}]
        [--answers ID[,ID...]]
                                  post to the message page and ring the machine. --via telegram
                                  marks a copy of a text the human already got on Telegram
                                  (SF_NOTIFY=0 mutes it, SF_NOTIFY_SOUND names the sound).
                                  --answers marks those queue items handled once it is posted;
                                  an id not in the queue refuses before anything is posted
  queue                           what waits on the human: id, when, ticket, kind and the start
                                  of each open decision or blocked question, oldest first
  handled <id>... [--ticket K]    mark queue items handled, as the page's button does; --ticket
                                  marks every open one on K. An unknown id marks nothing
  messages [-n 20]                the last n messages. Never read the log whole: it is
                                  append-only and unbounded.
  board [--stop]                  start the board in the background, or stop it
  board --serve                   run the board in this process
  board --inbox                   print each new message from the message page, for a monitor in
                                  the lead's session. One holds the inbox at a time.
  pr-ready <repo> <n>
                                  may this PR be sent? Every question about its current head sha; a
                                  missing answer is a failure. <repo> is a key of [repos] or its
                                  owner/repo. Exit 0 sendable, 1 not, 2 unreadable.
  pr-send <repo> <n> <reviewed-sha>
                                  gate the draft, check the head is still the reviewed sha, print
                                  the link and the push text. It leaves the PR a draft.
  pr-open-for-review <TICKET>     open the item's draft PRs for colleague review, each only while its
                                  head is the reviewed sha, then record colleague-review. The one
                                  undraft there is.
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
  allow-close <repo> <n> --words "<the human's words>"
                                  record that the human named this product PR for the lead to
                                  close, in state/allow-close.jsonl; the guard lets the lead's
                                  \`gh pr close <n> -R owner/repo\` through only for a PR recorded there.
                                  Never a merge.
  pr-media <repo> <n> (--dir <media-dir> | --no-visual-change) [--dry-run]
                                  put a demo's screenshots and video into the PR body; media
                                  stamped at the PR's base (demo --before) goes under Before
  demo <KEY> --init               copy the demo template to /tmp/demo/<KEY>/demo.spec.ts
  demo <KEY> <spec.ts> [base-url] run a Playwright demo from the worktree; media in /tmp/demo/<KEY>
  demo --before <KEY> <spec.ts> [base-url]
                                  the same with main's code checked out; media in /tmp/demo/<KEY>-before
  demo --before --base-ref <branch> <KEY> <spec.ts> [base-url]
                                  a PR stacked on <branch>: the same with origin/<branch> checked out
  watch queue                     read the tracker's queue once, and tell the lead about new tickets
                                  waiting there and fresh merges. It makes no records: waiting work
                                  lives in the backlog. What the scheduler runs; prompts/queue.md.
  watch reviews                   read the review comments on the PRs in review once, and tell the
                                  lead about new ones. No model; every 5 minutes by default.
  watch round [--facts]           the round once: facts gathered here, and a note to the lead with
                                  the lines that need it, each told once a day at most.
                                  --facts prints the facts and tells nobody.
  schedule render|install|uninstall|status
                                  the launchd jobs from [watchers]: render them into
                                  logs/run/launchd/, load or unload them for this user, or show
                                  what is installed and loaded
  schedule run [--check-seconds N] [--memory-limit-mb N] [--unanswered-minutes N]
                                  off macOS, the scheduler: run those jobs at their times, serve
                                  the board, and post an alert when the lead has not seen the
                                  human's message for N minutes (12), in the foreground under a
                                  systemd user unit
  hook <${HOOKS.join("|")}> [...]
                                  a Claude Code hook, reading the event on stdin. The rendered
                                  settings in logs/run/ call these; nothing else needs to.
${STACK_USAGE}
${TICKET_USAGE}

The workspace is --workspace, else $FACTORY_WORKSPACE, else the nearest factory.toml above the
current directory. Only this program writes the state store.

states: designing design-review building pr-open agent-review fixing gate your-review colleague-review done blocked
Waiting work lives in the backlog. off takes an item off the board and keeps its record.`;

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
  const { lines, live, unknown } = fleetLines(ws);
  console.log(lines.join("\n"));
  console.log(boardLine(ws));
  console.log("-- tickets (state/) --");
  const recs = v.all ? allRecs(ws) : allRecs(ws).filter(onBoard);
  if (!recs.length) console.log("  none");
  for (const r of recs) {
    for (const l of showRec(ws, r)) console.log(l);
    const note = owedNote(r, live, unknown);
    if (note) console.log(`  ${"".padEnd(12)} ${note.label.mark} ${note.says}${note.label.tail}`);
  }
  console.log("-- waiting --");
  const work = idleWork(recs, ws.config.agents, new Set(live.keys()), unknown);
  if (!work.length) console.log("  none");
  else for (const w of work) console.log(`  ${w}`);
}

function cmdIdleWork(ws: Workspace, argv: string[]) {
  args("idle-work", argv, {}, [0, 0]);
  const work = idleWorkFor(ws);
  if (!work.length) console.log("  none");
  else for (const w of work) console.log(`  ${w}`);
}

function cmdState(ws: Workspace, argv: string[]) {
  const s = { type: "string" } as const;
  const { v, p } = args("state", argv, {
    list: { type: "boolean" }, all: { type: "boolean" }, off: { type: "boolean" }, force: { type: "boolean" },
    agent: s, stack: s, evidence: s, note: s, title: s, pr: s, head: s, reviewed: s, jira: s, canvas: s, slides: s, approved: s,
    "remove-pr": s,
  }, [0, 2]);
  const [ticket, next] = p;
  if (v.off) {
    // Items taken off the board: waiting work with no ticket to wait in, LOCAL- above all, is found here.
    const recs = allRecs(ws).filter((r) => r.state === null);
    for (const r of recs) console.log(`  ${r.ticket.padEnd(12)} agent=${(r.agent || "-").padEnd(8)} ${r.title ?? "(no title)"}`);
    if (!recs.length) console.log("  nothing off the board");
    return;
  }
  if (v.list) {
    const all = allRecs(ws);
    const recs = v.all ? all : all.filter(onBoard);
    for (const r of recs) for (const l of showRec(ws, r)) console.log(l);
    if (!recs.length) console.log("  no open tickets");
    const off = all.filter((r) => r.state === null).length;
    if (off && !v.all) console.log(`  and ${off} off the board: factory state --off`);
    return;
  }
  if (!ticket) throw new FactoryError("state needs a ticket, or --list");
  const removing = str(v["remove-pr"]);
  if (removing) {
    if (next) throw new FactoryError("--remove-pr is not a transition; run it without a new state");
    removePr(ws, ticket, removing, str(v.note));
    return;
  }
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
    canvas: str(v.canvas), slides: str(v.slides), approved: str(v.approved),
  });
  if (IN_REVIEW.has(next)) releaseForReview(ws, ticket);
}

function cmdDispatch(ws: Workspace, argv: string[]) {
  const { v, p } = args("dispatch", argv, { repo: { type: "string" }, "prompt-file": { type: "string" }, force: { type: "boolean" } }, [2, 2]);
  const [name, ticket] = p as [string, string];
  const force = !!v.force;
  const ag = agentOrDie(ws, name);
  if (!validKey(ws, ticket)) throw new FactoryError(`${pyRepr(ticket)} is ${KEY_HINT}`);
  if (ag.role === "designer") {
    if (str(v.repo)) throw new FactoryError(`a designer reads every repo and works in none, so it takes no --repo`);
    return dispatchDesigner(ws, ag, ticket, force, str(v["prompt-file"]));
  }
  if (ag.role !== "builder") throw new FactoryError(`${name} is a ${ag.role}, not a builder or a designer. Reviewers are started per review with \`factory review\`.`);
  const allowed = ag.repos;
  const repoKey = str(v.repo) ?? (allowed[0] as string);
  if (!allowed.includes(repoKey)) throw new FactoryError(`${name} works in [${allowed.map(pyRepr).join(", ")}]; --repo ${repoKey} is another stack`);
  const repo = ws.config.repos[repoKey]!;
  const stack = ag.stack ?? repoKey;
  // The brief and the prompt file, read before any session is stopped or started: a missing one
  // refuses with the live session kept. The read is lazy, done once at the first stop or the start,
  // so a fix round on the live session and the "still on" refusal never need either.
  const promptFile = str(v["prompt-file"]);
  let read: { appendix: ReturnType<typeof buildAppendix>; given: string | null } | undefined;
  const inputs = () => (read ??= { appendix: buildAppendix(ws, ag, repo.path), given: promptFile ? readFileSync(promptFile, "utf8") : null });
  // A builder keeps its session across the rounds of one work item and is cleared only when it
  // starts a different one. A fix round on the item the live session is already on keeps that
  // session and its context: the brief goes to it by SendMessage, and this only records the state.
  // A session whose item is in review holds the builder no longer: a new item stops it here, with
  // the checks `factory stop` makes.
  const t = transportFor(ws, ag);
  const onItem = (x: Session) => basename((x.cwd ?? "").replace(/\/+$/, "")) === ticket;
  let s = findSession(t, name);
  // A session on KEY that was stopped idle comes back for the fix round.
  if (!t.alive(s) && !force) s = wakeForRound(ws, ag, t, onItem) ?? s;
  if (t.alive(s)) {
    const on = basename((s.cwd ?? "").replace(/\/+$/, ""));
    if (on === ticket && !force) {
      if (loadRec(ws, ticket)?.state !== "fixing")
        transition(ws, ticket, "fixing", { agent: name, evidence: `fix round sent to the live session ${s.id}, context kept` });
      console.log(`${name} is still on ${ticket} (${s.id}), so it keeps its context.`);
      const noSlot = ag.host ? null : slotless(ws, stack, ticket, s.cwd ?? "");
      if (noSlot) console.log(`  warning: ${noSlot}\n  Put that in the fix brief.`);
      console.log(`  next: SendMessage the fix brief to ${name}; no new session was started`);
      return;
    }
    const onState = on ? loadRec(ws, on)?.state : null;
    if (force) {
      inputs();
      console.log(`${name} is running (${s.id}); --force given, stopping it`);
      stopSession(t, s);
    } else if (onState && IN_REVIEW.has(onState)) {
      const left = builderLeft(ws, ag, t, s.cwd);
      if (left) throw new FactoryError(`${on} is ${onState}, so ${name} is free for ${ticket}, but ${left}`);
      inputs();
      stopSession(t, s);
      console.log(`${name}'s item ${on} is ${onState}, so ${name} is free: stopped ${s.id}, worktree kept: ${s.cwd}`);
    } else {
      throw new FactoryError(`${name} is still on ${on || s.cwd} (${s.id}). Starting ${ticket} is a new work item, which clears ` +
        `the session: \`factory stop ${name}\` first. It checks for uncommitted work.`);
    }
  }
  // One active item per agent, and the store agrees.
  for (const r of allRecs(ws))
    if (owesSession(r) && r.agent === name && r.ticket !== ticket)
      throw new FactoryError(`${name} is recorded as ${r.state} on ${r.ticket}. Finish or re-state that first.`);
  const rec = loadRec(ws, ticket);
  const cur = rec?.state ?? null;
  if (!DISPATCHABLE.has(cur) && !force)
    throw new FactoryError(`${ticket} is ${cur}; a dispatch makes no sense there. Use \`factory state\` first, ` +
      `or --force if you mean it (a verification run on a sent PR, say).`);
  const { appendix, given } = inputs();
  const { wt, how } = t.worktree({ agent: ag, repo, ticket, toolWritten: ws.config.worktree.toolWritten });
  // A hosted builder has no stack, so there is no slot to check.
  const noSlot = ag.host ? null : slotless(ws, stack, ticket, wt);
  if (noSlot) console.log(`  warning: ${noSlot}`);
  const prompt = (given ?? buildingPrompt(ws, ag, ticket)) + (noSlot ? `\n\n${noSlot}` : "");
  const started = launch(ws, ag, wt, prompt, appendix?.text ?? null, "build");
  if (rec === null || cur === null) {
    transition(ws, ticket, "building", { agent: name, stack, worktree: wt, evidence: `building session ${started.id}` });
  } else {
    rec.agent = name;
    rec.worktree = wt;
    saveRec(ws, rec);
    appendEvent(ws, { t: now(), ticket, from: cur, to: cur, agent: name, evidence: `re-dispatched (building session ${started.id})`, note: how, pr: rec.pr ?? null });
  }
  console.log(`${name} started (${started.id}) for ${ticket} as a BUILDING session`);
  console.log(`  worktree ${wt} (${how})`);
  console.log(`  appendix ${appendix ? appendix.labels.join(", ") : "-"}`);
  const d = rec?.design;
  if (d?.approved) console.log(`  design approved by ${ws.config.human.name} (${d.approved_at}): slides ${d.slides} canvas ${d.canvas}. The brief carries it.`);
  else if (d) console.log(`  warning: ${ticket} has a design ${ws.config.human.name} has not approved (${d.slides ?? d.canvas ?? "no link"})`);
  console.log(`  next: SendMessage to ${name}: what to build or fix, the scope, and notify_when_idle`);
}

// Reads the prompt and the appendix, and refuses on either, before anything is stopped; the launch
// it returns starts the session in the role's cwd with both.
function onDemand(ws: Workspace, ag: Agent, prompt: () => string): () => Session {
  const text = prompt();
  const appendix = roleAppendix(ws, ag);
  return () => launch(ws, ag, roleOf(ws, ag).cwd as string, text, appendix);
}

// A designer reads every repo and writes none, so it has no worktree or stack: one session in the
// designers' shared cwd per item. Another round on the same item, after the human sent the design
// back, goes to the live session if it is still the one that drew it, so it keeps its context.
function dispatchDesigner(ws: Workspace, ag: Agent, ticket: string, force: boolean, promptFile: string | undefined) {
  const name = ag.name;
  const rec = loadRec(ws, ticket);
  const cur = rec?.state ?? null;
  if (!DESIGN_DISPATCHABLE.has(cur) && !force)
    throw new FactoryError(`${ticket} is ${cur}; a design starts from the backlog or off the board, or goes another round from design-review. ` +
      `Use \`factory state\` first, or --force if you mean it.`);
  for (const r of allRecs(ws))
    if (r.agent === name && r.state === "designing" && r.ticket !== ticket)
      throw new FactoryError(`${name} is recorded as designing ${r.ticket}. Finish or re-state that first.`);
  const human = ws.config.human.name;
  const d = rec?.design;
  const links = d && (d.canvas || d.slides) ? `  the last round: canvas ${d.canvas ?? "-"} slides ${d.slides ?? "-"}` : "";
  const ready = () => onDemand(ws, ag, () => (promptFile ? readFileSync(promptFile, "utf8") : designerPrompt(ws, ag, ticket)));
  let go: (() => Session) | undefined;
  const t = transportFor(ws, ag);
  let s = findSession(t, name);
  // The session that drew the last round, stopped idle since, is woken for this one.
  if (!t.alive(s) && !force && rec?.agent === name && rec.session) s = wakeForRound(ws, ag, t, (x) => x.id === rec.session) ?? s;
  if (t.alive(s)) {
    const on = allRecs(ws).find((r) => r.agent === name && r.session === s.id);
    if (on?.ticket === ticket && !force) {
      if (cur !== "designing") transition(ws, ticket, "designing", { agent: name, evidence: `another round sent to the live session ${s.id}, context kept` });
      console.log(`${name} is still on ${ticket} (${s.id}), so it keeps its context.`);
      if (links) console.log(links);
      console.log(`  next: SendMessage to ${name}: what ${human} asked to change, word for word`);
      return;
    }
    if (on?.state === "designing" && !force)
      throw new FactoryError(`${name} is still designing ${on.ticket} (${s.id}). Use another designer, or --force.`);
    go = ready();
    stopSession(t, s);
    console.log(`${name} stopped (${s.id})${on ? `: ${on.ticket} is ${on.state}, so ${name} is free` : ""}`);
  }
  const started = (go ?? ready())();
  if (cur === "designing") {
    const r = rec as Rec;
    r.agent = name;
    saveRec(ws, r);
    appendEvent(ws, { t: now(), ticket, from: cur, to: cur, agent: name, evidence: `re-dispatched (design session ${started.id})`, note: null, pr: null });
  } else transition(ws, ticket, "designing", { agent: name, evidence: `design session ${started.id}`, force });
  const after = loadRec(ws, ticket) as Rec;
  after.session = started.id;
  saveRec(ws, after);
  console.log(`${name} started (${started.id}) for ${ticket} as a DESIGN session`);
  if (links) console.log(links);
  console.log(`  next: SendMessage to ${name}: the design brief (the delegate-design skill), and notify_when_idle`);
}

const via = (ws: Workspace, name: string) => transportFor(ws, agentOrDie(ws, name));

function cmdWake(ws: Workspace, argv: string[]): number {
  const { p } = args("wake", argv, {}, [1, 1]);
  const name = p[0] as string;
  const w = wake(ws, agentOrDie(ws, name));
  switch (w.is) {
    case "live":
      console.log(`${name} is already live (${w.s.id})`);
      return 0;
    case "woke":
      console.log(`${name} woke: ${w.from} respawned, live as ${w.s.id}, same conversation`);
      return 0;
    case "none":
      console.error(`${name} has no session to wake; start it the factory way`);
      return 1;
    case "failed":
    case "unknown":
      console.error(`${name} did not wake: ${w.why}`);
      return 1;
  }
}

function cmdStop(ws: Workspace, argv: string[]) {
  const { v, p } = args("stop", argv, { force: { type: "boolean" }, "remove-worktree": { type: "boolean" }, "keep-worktree": { type: "boolean" } }, [1, 1]);
  const name = p[0] as string;
  const ag = agentOrDie(ws, name);
  const t = transportFor(ws, ag);
  const s = findSession(t, name);
  if (!t.alive(s)) {
    console.log(`${name} is not running`);
    return;
  }
  const cwd = s.cwd;
  const builder = ag.role === "builder";
  if (builder && !v.force) {
    const left = builderLeft(ws, ag, t, cwd);
    if (left) throw new FactoryError(left);
  }
  stopSession(t, s);
  console.log(`stopped ${name} (${s.id})`);
  const remove = !!v["remove-worktree"] && !v["keep-worktree"];
  // The worktree stays unless asked for: a worktree can hold a running stack and its database.
  const said = builder ? stopWorktree(ws, ag, t, cwd, remove) : null;
  if (said) console.log(`  ${said}`);
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
  const ready = (name: string) => onDemand(ws, agentOrDie(ws, name), () => (promptFile ? readFileSync(promptFile, "utf8") : reviewerPrompt(ws)));
  const busy: string[] = [];
  for (const name of names) {
    const t = via(ws, name);
    const s = findSession(t, name);
    if (t.alive(s)) {
      busy.push(`${name} (${s.id})`);
      continue;
    }
    console.log(`${name} started (${ready(name)().id})`);
    return;
  }
  if (v.force && busy.length) {
    const name = names[0] as string;
    const go = ready(name);
    const t = via(ws, name);
    stopSession(t, findSession(t, name));
    console.log(`${name} restarted (${go().id})`);
    return;
  }
  throw new FactoryError(`every reviewer is busy: ${busy.join(", ")}. Stop one, or pass --force to restart the first.`);
}

// An assistant is started on demand to take a piece of the lead's non-code work -- managing PRs,
// fixing factory state or config, a computer task, research. Like a reviewer it is a fresh session,
// started with the role's settings/model/effort/permission-mode and the shared assistants/ cwd, no
// stack. Named vega or cruz; with no name it takes the first free one. The lead then sends the task
// by message and stops the session with `factory stop <name>` when it is done.
function cmdAssistant(ws: Workspace, argv: string[]) {
  const { v, p } = args("assistant", argv, { "prompt-file": { type: "string" }, name: { type: "string" }, force: { type: "boolean" } }, [0, 1]);
  let names = byRole(ws, "assistant").map((a) => a.name);
  if (!names.length) throw new FactoryError(`no assistants are configured.`);
  const want = (p[0] as string | undefined) ?? str(v.name);
  if (want) {
    if (!names.includes(want)) throw new FactoryError(`${pyRepr(want)} is not an assistant. Assistants: ${names.join(", ")}`);
    names = [want];
  }
  const promptFile = str(v["prompt-file"]);
  // A named assistant that was stopped idle is mid-conversation with the lead, so it is woken. One
  // that does not wake is not started fresh, which would lose that conversation, unless --force.
  if (want && !v.force) {
    const ag = agentOrDie(ws, want);
    const w = wake(ws, ag);
    if (w.is === "woke") {
      console.log(wokeLine(want, w.from));
      console.log(`  next: send it the task by message, or pass --force for a fresh session`);
      return;
    }
    if (w.is === "failed" || w.is === "unknown") throw new FactoryError(`${want} was off and did not wake: ${w.why}. Nothing was started, so its conversation is kept; \`factory wake ${want}\` tries again, and --force starts a fresh session without it.`);
  }
  const ready = (name: string) => onDemand(ws, agentOrDie(ws, name), () => (promptFile ? readFileSync(promptFile, "utf8") : assistantPrompt(ws)));
  const busy: string[] = [];
  for (const name of names) {
    const t = via(ws, name);
    const s = findSession(t, name);
    if (t.alive(s)) {
      busy.push(`${name} (${s.id})`);
      continue;
    }
    console.log(`${name} started (${ready(name)().id})`);
    return;
  }
  if (v.force && busy.length) {
    const name = names[0] as string;
    const go = ready(name);
    const t = via(ws, name);
    stopSession(t, findSession(t, name));
    console.log(`${name} restarted (${go().id})`);
    return;
  }
  // A named assistant already running is not an error: the lead just messages the live session.
  if (want) {
    const t = via(ws, want);
    const s = findSession(t, want);
    console.log(`${want} is already running${t.alive(s) ? ` (${s.id})` : ""}; send it the task by message, or pass --force to restart it.`);
    return;
  }
  throw new FactoryError(`every assistant is busy: ${busy.join(", ")}. Message one, or pass --force to restart the first.`);
}

function up(ws: Workspace, fresh: boolean) {
  const ld = lead(ws);
  // the board's stacks panel reads this export, so write it before the board's first check
  exportStacks(ws);
  startBoard(ws, true);
  const boot = startBoot(ws);
  if (boot) console.log(`stacks: any slot that does not answer comes up in the background; see ${boot}`);
  bringUpLead(ws, ld, transportFor(ws, ld), fresh);
}

function cmdUp(ws: Workspace, argv: string[]) {
  const { v } = args("up", argv, { fresh: { type: "boolean" } }, [0, 0]);
  up(ws, !!v.fresh);
}

// Prints each host that could not be asked, and returns 1 if there was any.
function sayUnknown(rows: Iterable<Session[] | Unreachable>, so: string): number {
  let code = 0;
  for (const r of rows)
    if (r instanceof Unreachable) {
      console.error(`${r.message}; ${so}`);
      code = 1;
    }
  return code;
}

function cmdDown(ws: Workspace, argv: string[]) {
  args("down", argv, {}, [0, 0]);
  const rows = new Map(transports(ws).map((t) => [t.where, listing(t)]));
  const code = sayUnknown(rows.values(), "its sessions are left as they are");
  for (const { t, hits } of agentSessions(ws, (where) => rows.get(where)))
    for (const s of hits) {
      console.log(`stopping ${s.name} (${s.id})`);
      stopSession(t, s, false);
    }
  stopBoard(ws, true);
  return code;
}

function cmdRestartLead(ws: Workspace, argv: string[]) {
  const { v } = args("restart-lead", argv, { fresh: { type: "boolean" } }, [0, 0]);
  const name = lead(ws).name;
  const t = via(ws, name);
  const s = findSession(t, name);
  if (t.alive(s)) {
    stopSession(t, s, false);
    // wait for the supervisor to report it stopped, or up sees it as running
    for (let i = 0; i < 20 && t.alive(findSession(t, name)); i++) sleep(1000);
    console.log(`stopped ${name}`);
  }
  up(ws, !!v.fresh);
}

function cmdSessions(ws: Workspace, argv: string[]) {
  const { v } = args("sessions", argv, { all: { type: "boolean" }, fleet: { type: "boolean" } }, [0, 0]);
  if (v.fleet) console.log(fleetLines(ws).lines.join("\n"));
  else {
    const rows = transports(ws).map((t) => listing(t, !!v.all));
    const code = sayUnknown(rows, "its sessions are not listed");
    console.log(pyDumps(rows.flatMap((r) => (Array.isArray(r) ? r : [])), { indent: 2 }));
    return code;
  }
  return 0;
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
    if (rec.state && BUSY.has(rec.state) && !v.force)
      throw new FactoryError(`${ticket} is ${rec.state} with agent=${rec.agent ?? "None"}. Stop the teammate first, or pass --force.`);
    appendEvent(ws, { ticket, at: now(), event: "dropped", from_state: rec.state ?? OFF, note: str(v.note) ?? null });
    removeRec(ws, ticket);
    console.log(`  dropped ${ticket} (was ${rec.state ?? OFF})`);
  }
}

function cmdSay(ws: Workspace, argv: string[]) {
  const s = { type: "string" } as const;
  const { v, p } = args("say", argv, { ticket: s, link: s, kind: s, via: s, answers: { type: "string", multiple: true } }, [1, Infinity]);
  const kind = str(v.kind) ?? "note";
  if (!(KINDS as readonly string[]).includes(kind))
    throw new UsageError(`say: --kind: invalid choice: ${pyRepr(kind)} (choose from ${KINDS.map(pyRepr).join(", ")})`);
  const via = str(v.via);
  if (via !== undefined && !(VIAS as readonly string[]).includes(via))
    throw new UsageError(`say: --via: invalid choice: ${pyRepr(via)} (choose from ${VIAS.map(pyRepr).join(", ")})`);
  // --answers names the queue items this message settles. They are checked before anything is
  // posted, so a wrong id posts nothing, and marked handled once the message is in the log.
  const answers = queueIds((v.answers as unknown as string[] | undefined) ?? []);
  if (answers.length) {
    const pre = markHandledMany(ws, answers, true);
    if (!pre.ok) throw new FactoryError(`say: --answers: ${pre.error}; nothing posted`);
  }
  say(ws, p, { ticket: str(v.ticket), link: str(v.link), kind: kind as Kind, via: via as Via | undefined });
  if (answers.length) {
    const r = markHandledMany(ws, answers);
    if (!r.ok) throw new FactoryError(`say: posted, but could not mark ${answers.join(", ")} handled: ${r.error}`);
    handledLines(r);
  }
}

// Ids given as separate words or comma-separated, in order, each once.
const queueIds = (words: string[]) => [...new Set(words.flatMap((w) => w.split(",")).map((w) => w.trim()).filter(Boolean))];

function handledLines(r: { marked: string[]; already: string[] }) {
  for (const id of r.marked) console.log(`  handled ${id}`);
  for (const id of r.already) console.log(`  ${id} was already handled`);
}

// When an item was asked, in this machine's time, to the minute.
function askedAt(at: string | null): string {
  const d = at ? new Date(at) : null;
  if (!d || !Number.isFinite(d.getTime())) return "-";
  const n = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${n(d.getMonth() + 1)}-${n(d.getDate())} ${n(d.getHours())}:${n(d.getMinutes())}`;
}

// What waits on the human, oldest first, one line each, for the lead to read and clear.
function cmdQueue(ws: Workspace, argv: string[]) {
  args("queue", argv, {}, [0, 0]);
  const trouble = queueTrouble(ws);
  if (trouble) console.error(`factory: ${trouble}`);
  const items = waitingQueue(ws);
  if (!items.length) {
    console.log("nothing waiting on the human");
    return;
  }
  for (const i of items) {
    const text = squash(i.text, 101);
    const head = chars(text).slice(0, 100).join("");
    console.log(`${i.id}  ${askedAt(i.at)}  ${i.ticket ?? "-"}  ${i.kind}  ${head}${head.length < text.length ? "…" : ""}`);
  }
}

// Mark queue items handled, by id or every open one on a ticket. An unknown id refuses the whole call.
function cmdHandled(ws: Workspace, argv: string[]) {
  const { v, p } = args("handled", argv, { ticket: { type: "string" } }, [0, Infinity]);
  const ticket = str(v.ticket);
  if (!p.length && !ticket) throw new UsageError("handled: give the queue ids, or --ticket K");
  const ids = queueIds(p);
  if (ticket) {
    const on = waitingQueue(ws).filter((i) => i.ticket === ticket).map((i) => i.id);
    if (!on.length) console.log(`  nothing open on ${ticket}`);
    for (const id of on) if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return;
  const r = markHandledMany(ws, ids);
  if (!r.ok) throw new FactoryError(`handled: ${r.error}; nothing marked`, r.retry ? 2 : 1);
  handledLines(r);
}

function cmdBoard(ws: Workspace, argv: string[]) {
  const { v } = args("board", argv, { stop: { type: "boolean" }, serve: { type: "boolean" }, inbox: { type: "boolean" } }, [0, 0]);
  if ([v.stop, v.serve, v.inbox].filter(Boolean).length > 1) throw new UsageError("board: give one of --stop, --serve or --inbox");
  if (v.inbox) followInbox(ws);
  else if (v.serve) runBoard(ws);
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
  const { p } = args("pr-ready", argv, {}, [2, 2]);
  const verdict = ready(ws, resolveRepo(ws, p[0] as string), prNumber(p[1] as string));
  for (const l of report(verdict)) console.log(l);
  return verdict.sendable ? 0 : 1;
}

function cmdPrSend(ws: Workspace, argv: string[]) {
  const { p } = args("pr-send", argv, {}, [3, 3]);
  send(ws, resolveRepo(ws, p[0] as string), prNumber(p[1] as string), p[2] as string);
}

function cmdPrOpenForReview(ws: Workspace, argv: string[]) {
  const { p } = args("pr-open-for-review", argv, {}, [1, 1]);
  openForReview(ws, p[0] as string);
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

function cmdAllowClose(ws: Workspace, argv: string[]) {
  const { v, p } = args("allow-close", argv, { words: { type: "string" } }, [2, 2]);
  const words = str(v.words)?.trim();
  if (!words) throw new UsageError(`allow-close: --words "<${ws.config.human.name}'s words>" is the permission; give them`);
  const repo = resolveRepo(ws, p[0] as string);
  if (!repo.remote) throw new FactoryError(`repo ${pyRepr(repo.key)} has no remote in factory.toml`, 2);
  const rec = recordAllowClose(ws, repo.remote, prNumber(p[1] as string), words);
  console.log(`${rec.repo}#${rec.number} may be closed by the lead (gh pr close ${rec.number} -R ${rec.repo}); ${ws.config.human.name}: ${pyRepr(rec.words)}`);
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
  const { v, p } = args("demo", argv, { init: { type: "boolean" }, before: { type: "boolean" }, "base-ref": { type: "string" } }, [1, 3]);
  const [key, spec, base] = p as [string, string | undefined, string | undefined];
  const baseRef = v["base-ref"] as string | undefined;
  if (v.init) {
    if (spec || v.before || baseRef !== undefined) throw new UsageError("demo: --init takes only the key");
    return demoInit(ws, key);
  }
  if (baseRef !== undefined && !v.before) throw new UsageError("demo: --base-ref goes with --before");
  if (!spec) throw new UsageError("demo: which spec? factory demo [--before [--base-ref <branch>]] <KEY> <spec.ts> [base-url], or --init for the template");
  return demo(ws, key, spec, base, undefined, !!v.before, baseRef);
}

// A scheduled run that dies before it starts leaves a line where the round looks, not only in the
// launchd log nobody reads.
function cmdWatch(ws: Workspace, argv: string[]): number {
  const { v, p } = args("watch", argv, { facts: { type: "boolean" } }, [1, 1]);
  const job = p[0] as string;
  if (job !== "queue" && job !== "round" && job !== "reviews") throw new UsageError(`watch: ${pyRepr(job)} is not a watcher; watchers are queue, reviews, round`);
  if (v.facts && job !== "round") throw new UsageError("watch: --facts is for the round");
  try {
    return job === "queue" ? runQueue(ws) : job === "reviews" ? runReviews(ws) : runRound(ws, { factsOnly: !!v.facts });
  } catch (e) {
    if (e instanceof FactoryError && !v.facts) failure(ws, `${job} FAILED: ${e.message.split("\n")[0]}`);
    throw e;
  }
}

function cmdSchedule(ws: Workspace, argv: string[]): number {
  const { v, p } = args("schedule", argv, { "check-seconds": { type: "string" }, "memory-limit-mb": { type: "string" }, "unanswered-minutes": { type: "string" } }, [1, 1]);
  const verb = p[0] as string;
  if (verb !== "run" && (v["check-seconds"] !== undefined || v["memory-limit-mb"] !== undefined || v["unanswered-minutes"] !== undefined))
    throw new UsageError("schedule: --check-seconds, --memory-limit-mb and --unanswered-minutes are for run");
  if (verb === "run") {
    const num = (k: string, d: number) => {
      const n = v[k] === undefined ? d : Number(v[k]);
      if (!(Number.isInteger(n) && n > 0)) throw new UsageError(`schedule run: --${k}: want a whole number above 0, not ${pyRepr(String(v[k]))}`);
      return n;
    };
    const opts = { checkSeconds: num("check-seconds", 30), memoryLimitMb: num("memory-limit-mb", 512), unansweredMinutes: num("unanswered-minutes", 12) };
    runScheduler(ws, opts).catch((e: unknown) => {
      console.error(`factory: schedule run: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(e instanceof FactoryError ? e.code : 1);
    });
    return 0;
  }
  if (verb === "render") {
    for (const r of render(ws)) console.log(`rendered ${r.path}`);
    return 0;
  }
  if (verb === "install" || verb === "uninstall" || verb === "status") return schedule(ws, verb);
  throw new UsageError(`schedule: ${pyRepr(verb)}; give render, install, uninstall, status or run`);
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

const COMMANDS: Record<string, (ws: Workspace, argv: string[]) => number | void | Promise<number>> = {
  "up": cmdUp,
  "down": cmdDown,
  "restart-lead": cmdRestartLead,
  "status": cmdStatus,
  "idle-work": cmdIdleWork,
  "sessions": cmdSessions,
  "dispatch": cmdDispatch,
  "stop": cmdStop,
  "wake": cmdWake,
  "review": cmdReview,
  "assistant": cmdAssistant,
  "state": cmdState,
  "drop": cmdDrop,
  "say": cmdSay,
  "queue": cmdQueue,
  "handled": cmdHandled,
  "messages": cmdMessages,
  "board": cmdBoard,
  "pr-ready": cmdPrReady,
  "pr-send": cmdPrSend,
  "pr-wait": cmdPrWait,
  "pr-open-for-review": cmdPrOpenForReview,
  "delta-range": cmdDeltaRange,
  "pr-comment": cmdPrComment,
  "allow-close": cmdAllowClose,
  "pr-media": cmdPrMedia,
  "demo": cmdDemo,
  "stack": cmdStack,
  "ticket": cmdTicket,
  "wiki": cmdWiki,
  "watch": cmdWatch,
  "schedule": cmdSchedule,
  "doctor": cmdDoctor,
};

const HOOK_FNS: Record<HookName, (argv: string[], input: string, workspace?: string) => HookResult> = {
  "guard": guardHook,
  "status": statusHook,
  "no-dialogs": noDialogsHook,
  "no-side-channels": noSideChannelsHook,
  "wake": wakeHook,
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

export function main(argv: string[]): number | Promise<number> {
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

const failed = (e: unknown): number => {
  if (!(e instanceof FactoryError)) throw e;
  console.error(`factory: ${e.message}`);
  return e.code;
};
try {
  const r = main(process.argv.slice(2));
  if (typeof r === "number") process.exitCode = r;
  else
    r.then((code) => (process.exitCode = code), (e: unknown) => (process.exitCode = failed(e))).catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
} catch (e) {
  process.exitCode = failed(e);
}
