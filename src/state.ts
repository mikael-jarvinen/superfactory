import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type State, STATES } from "./config.js";
import type { Workspace } from "./workspace.js";
import { die, now, pyDumps, pyRepr, pyStr, squash } from "./util.js";

export { STATES, type State };

// `off` is not a state: it takes an item off the board and leaves its record, with state null,
// until a dispatch brings it back. A queued state would only repeat the backlog; the board shows
// only work someone is doing, and waiting work stays in the tracker. The record keeps what the
// tracker has no place for: an approved design, the stack, the title.
export const OFF = "off";
export type Target = State | typeof OFF;

export const TRANSITIONS: Record<State, ReadonlySet<Target>> = {
  // A ticket that changes the UI and has no design is designed first: a designer draws it, the
  // human approves it, and only then is it built. The approval takes it off the board until a
  // builder is dispatched on it.
  "designing": new Set(["design-review", OFF, "blocked"]),
  "design-review": new Set(["designing", OFF, "blocked"]),
  "building": new Set(["pr-open", OFF, "blocked"]),
  "pr-open": new Set(["pr-open", "agent-review", "blocked"]),
  "agent-review": new Set(["fixing", "gate", "blocked"]),
  "fixing": new Set(["agent-review", "gate", "blocked"]),
  "gate": new Set(["your-review", "fixing", "blocked"]),
  "your-review": new Set(["colleague-review", "done", "fixing", OFF, "blocked"]),
  "colleague-review": new Set(["done", "fixing", OFF, "blocked"]),
  "done": new Set(),
  "blocked": new Set([...STATES.filter((s) => s !== "blocked"), OFF]),
};
// Whether this workspace uses a state: every one, but colleague-review only where [gate]
// colleague_review is true. Nothing moves an item into a state the workspace has turned off, --force
// included.
export const usesState = (ws: Workspace, s: State): boolean => s !== "colleague-review" || ws.config.gate.colleagueReview;
const usable = (ws: Workspace, to: Target) => to === OFF || usesState(ws, to);
// Where an item may go from a state, or from off the board, without --force.
const allowedFrom = (ws: Workspace, old: State | null): Target[] => [...(old === null ? FROM_OFF : TRANSITIONS[old])].filter((s) => usable(ws, s));
// blocked -> blocked with --asks links the block to the posted question it waits on, after the fact.
const relinks = (old: State | null, to: string, asks: string | undefined) => old === "blocked" && to === "blocked" && !!asks;
// Whether transition() takes the move without --force.
export const validMove = (ws: Workspace, old: State | null, to: string, asks?: string): boolean =>
  relinks(old, to, asks) || (allowedFrom(ws, old) as string[]).includes(to);
// Items left in a state the workspace has turned off: in colleague-review with colleague_review false.
// The board still shows them, the round names them, and doctor reports them.
export const stranded = <R extends { state: State | null }>(ws: Workspace, recs: readonly R[]): R[] =>
  recs.filter((r) => r.state !== null && !usesState(ws, r.state));
// Where a human reads the PR: an item that has been in one keeps its PR open from then on.
const REVIEW_STATES = ["your-review", "colleague-review"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
const isReview = (s: unknown): s is ReviewState => REVIEW_STATES.includes(s as ReviewState);
// A PR is a draft in every column but colleague review, and open there; once an item has been with
// colleagues its PR stays open through the fix rounds after. With colleague review off, your-review
// is where the human undrafts a PR to merge.
export const undrafting = (ws: Workspace): ReviewState => (usesState(ws, "colleague-review") ? "colleague-review" : "your-review");
// An item that has been where its PR is undrafted keeps it open from then on. Colleague-review counts
// with the switch off too: an item there before the switch went off has had its PR opened.
export const keptOpen = (ws: Workspace, rec: Rec): boolean =>
  (rec.reached ?? []).some((s) => s === "colleague-review" || s === undrafting(ws));
export const COLLEAGUE_REVIEW_OFF =
  "colleague review is off in this workspace ([gate] colleague_review = false); from your-review an item goes to done";

// Where an item off the board goes back on, and where a new one starts.
export const FROM_OFF: ReadonlySet<Target> = new Set(["designing", "building", "blocked"]);
const FIRST: ReadonlySet<Target> = new Set(["designing", "building"]);
export const BUSY: ReadonlySet<string> = new Set(["designing", "building", "fixing"]);
// A design sent for approval frees its designer, as a PR in review frees its builder.
export const WAITING_ON_YOU: ReadonlySet<string> = new Set(["design-review", "your-review", "blocked"]);
// States that move only when the lead moves them, so an item can sit in one for days unless
// something ages them.
export const WAITING_ON_LEAD: ReadonlySet<string> = new Set(["pr-open", "agent-review", "gate"]);
// An item in review frees its builder and its stack slot, so both can work on something else.
export const IN_REVIEW: ReadonlySet<string> = new Set(["your-review", "colleague-review"]);
// Where a dispatch makes sense without argument. Anywhere else is a judgement, so it needs --force.
// The states a dispatch on the item's own session redoes: before review, the state stays.
export const REDO: ReadonlySet<string | null> = new Set(["building", "pr-open"]);
export const DISPATCHABLE: ReadonlySet<string | null> = new Set([null, ...REDO, "fixing"]);
// The same for a designer: a new design, or another round on one the human sent back.
export const DESIGN_DISPATCHABLE: ReadonlySet<string | null> = new Set([null, "designing", "design-review"]);

// The design a ticket was drawn to. `approved` is the human's own words, and a builder's brief
// carries the design only once it is set.
export interface Design {
  canvas: string | null;
  slides: string | null;
  approved: string | null;
  approved_at: string | null;
}

export interface Pr {
  repo?: string;
  number?: number;
  head?: string;
  reviewed_sha?: string;
  [k: string]: unknown;
}

export interface Rec {
  ticket: string;
  state: State | null;
  stack: string | null;
  agent: string | null;
  jira: string | null;
  worktree: string | null;
  pr: Pr | null;
  prs?: Pr[];
  // message: the queue id of the posted question this block waits on, when it was posted without the ticket
  asked_you: { question: string | null; at: string; message?: string | null } | null;
  // A slot an assistant brought up for this item with `factory stack up --slot N` (screenshots for
  // release messaging, an old-code "before" stack); cleared when the slot is destroyed.
  assistant_slot?: { agent: string; stack: string; slot: number; at: string } | null;
  since: string | null;
  created: string;
  blocked_from: State | null;
  title?: string;
  design?: Design;
  // the designer session this item was last dispatched to, so a second round can keep its context
  session?: string;
  // the builder session the latest fix round started fresh in
  fix_session?: string;
  // The review states this item has ever entered, set as it enters one and never cleared. A PR is
  // kept open from then on (keptOpen). Records older than the field are given it on load (migrated).
  reached?: ReviewState[];
  [k: string]: unknown;
}

const LOCAL_RE = /^LOCAL-[a-z0-9][a-z0-9-]{1,40}$/;

export const isLocal = (k: string) => LOCAL_RE.test(k);

// A LOCAL key is factory bookkeeping and never appears on GitHub.
export const branchFor = (k: string) => (isLocal(k) ? k.slice("LOCAL-".length) : k);

export function validKey(ws: Workspace, k: string): boolean {
  return isLocal(k) || (ws.config.tracker.keyPattern?.test(k) ?? false);
}

const TRACKER_LABEL = { jira: "Jira", none: "tracker", local: "tracker" } as const;

export const KEY_HINT = "neither a ticket key nor a local key like LOCAL-fix-flaky-login";

// No tracker means no ticket to keep in step, the same as a LOCAL key. A local tracker's tickets
// are not kept in step from records yet, so its records are untracked too.
const untracked = (ws: Workspace, k: string) => isLocal(k) || ws.config.tracker.kind !== "jira";

export function trackerFor(ws: Workspace, s: State | "queued"): string {
  const st = ws.config.tracker.status;
  return st[s] ?? (s === "blocked" ? "unchanged" : (st.building ?? "unchanged"));
}

export const recPath = (ws: Workspace, ticket: string) => join(ws.stateDir, `${ticket}.json`);

export function loadRec(ws: Workspace, ticket: string): Rec | null {
  const p = recPath(ws, ticket);
  return existsSync(p) ? migrated(ws, JSON.parse(readFileSync(p, "utf8")) as Rec) : null;
}

// A record written while queued was a state is off the board, with everything else it carries kept:
// an approved design above all, which a builder's brief reads. A record written before `reached`
// gets it from the whole events log and its own state. The file is rewritten at its next save.
function migrated(ws: Workspace, rec: Rec): Rec {
  if ((rec.state as string) === "queued") rec.state = null;
  if ((rec.blocked_from as string | null) === "queued") rec.blocked_from = null;
  if (!Array.isArray(rec.reached)) {
    const seen = new Set(reachedByEvents(ws).get(rec.ticket));
    if (isReview(rec.state)) seen.add(rec.state);
    rec.reached = REVIEW_STATES.filter((s) => seen.has(s));
  }
  return rec;
}

// Each ticket's review states by the whole events log, not a tail of it: the log is never rotated,
// so a tail loses the oldest entries. Only records written before `reached` ask, and a record that
// never moves again is never saved with the field, so this asks on every load. The log is stat'd
// first and read only when its inode, size or mtime has changed since the last read in this process.
let reachedMemo: { key: string; map: Map<string, Set<ReviewState>> } | null = null;
function reachedByEvents(ws: Workspace): Map<string, Set<ReviewState>> {
  let key: string;
  try {
    const s = statSync(ws.events);
    key = `${ws.events}\0${s.ino}\0${s.size}\0${s.mtimeMs}`;
  } catch {
    return new Map(); // no events yet
  }
  if (reachedMemo?.key === key) return reachedMemo.map;
  const map = new Map<string, Set<ReviewState>>();
  eachEvent(readFileSync(ws.events, "utf8"), (e) => {
    if (typeof e.ticket !== "string" || !isReview(e.to)) return;
    const s = map.get(e.ticket) ?? new Set<ReviewState>();
    s.add(e.to);
    map.set(e.ticket, s);
  });
  reachedMemo = { key, map };
  return map;
}

// An item on the board: one with a state, done aside.
export const onBoard = (r: Rec): boolean => r.state !== null && r.state !== "done";

export function saveRec(ws: Workspace, rec: Rec): void {
  mkdirSync(ws.stateDir, { recursive: true });
  const p = recPath(ws, rec.ticket);
  writeFileSync(p + ".tmp", pyDumps(rec, { indent: 2, sortKeys: true }) + "\n");
  renameSync(p + ".tmp", p);
}

export function removeRec(ws: Workspace, ticket: string): void {
  unlinkSync(recPath(ws, ticket));
}

export function appendEvent(ws: Workspace, ev: Record<string, unknown>): void {
  mkdirSync(ws.stateDir, { recursive: true });
  appendFileSync(ws.events, pyDumps(ev, { sortKeys: true }) + "\n");
}

// Each event in the text of an events log, in order. A line torn by a crash costs that event only.
export function eachEvent(text: string, f: (e: Record<string, unknown>) => void): void {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e && typeof e === "object" && !Array.isArray(e)) f(e as Record<string, unknown>);
  }
}

export function allRecs(ws: Workspace): Rec[] {
  if (!existsSync(ws.stateDir)) return [];
  return readdirSync(ws.stateDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => migrated(ws, JSON.parse(readFileSync(join(ws.stateDir, f), "utf8")) as Rec));
}

export interface Change {
  agent?: string;
  evidence?: string;
  pr?: string;
  head?: string;
  reviewed?: string;
  jira?: string;
  stack?: string;
  worktree?: string;
  note?: string;
  force?: boolean;
  title?: string;
  canvas?: string;
  slides?: string;
  approved?: string;
  // blocked: the queue id of the posted question this block waits on (see board/queue.ts)
  asks?: string;
}

const isUrl = (s: string | undefined) => !!s && /^https?:\/\/\S+$/.test(s);

export function transition(ws: Workspace, ticket: string, next: string, c: Change = {}, out: (line: string) => void = console.log): Rec {
  const human = ws.config.human.name;
  if (!validKey(ws, ticket)) die(`${pyRepr(ticket)} is ${KEY_HINT}`);
  if (next !== OFF && !(STATES as readonly string[]).includes(next))
    die(`unknown state ${pyRepr(next)}; states: ${STATES.join(", ")}, or ${OFF} to take it off the board`);
  const to = next as Target;
  if (!usable(ws, to)) die(`${ticket}: ${to} refused -- ${COLLEAGUE_REVIEW_OFF}`);
  let rec = loadRec(ws, ticket);
  const isNew = rec === null;
  if (rec === null) {
    // Work that waits with no tracker backlog to wait in, LOCAL- work above all, is recorded off
    // the board, with a title so `state --off` says what it is.
    if (to === OFF && !c.title)
      die(`${ticket} has no record; a new item goes off the board only with --title "<what it is>", so \`state --off\` can show it`);
    if (to !== OFF && !FIRST.has(to))
      die(`${ticket} has no record; the first state must be designing or building, or off with --title for work ` +
        `that waits with no backlog to wait in. A ticket nobody is doing yet waits in the backlog.`);
    rec = {
      ticket, state: null, stack: c.stack ?? null, agent: c.agent ?? null, jira: null,
      worktree: null, pr: null, asked_you: null, since: null, created: now(), blocked_from: null, reached: [],
    };
  }
  const old = rec.state;
  // How the item stood: an old state, off the board, or nothing yet.
  const was = isNew ? null : old ?? OFF;
  const relink = relinks(old, to, c.asks);
  if (!isNew && !c.force && !validMove(ws, old, to, c.asks)) {
    const allowed = allowedFrom(ws, old);
    die(`${ticket}: ${old ?? OFF} -> ${to} is not a valid transition. From ${old ?? OFF} you can go to: ` +
        `${allowed.sort().join(", ") || "nowhere, it is terminal"}. Use --force if you mean it.`);
  }
  const warnings: string[] = [];
  // Evidence rules. Refuse where a wrong claim reaches the human; warn elsewhere.
  if (to === "pr-open" && !(c.pr && c.head))
    die("pr-open needs --pr owner/repo#N and --head <sha>: the PR number and head sha are the evidence");
  if (to === "your-review") {
    const cur = rec.pr ?? {};
    if (!rec.pr || Object.keys(cur).length === 0) die("your-review with no PR recorded; record pr-open with --pr and --head first");
    const head = c.head || cur.head || "";
    const reviewed = c.reviewed || (old === "blocked" ? cur.reviewed_sha : undefined);
    if (!reviewed) die("your-review needs --reviewed <sha>: the sha the reviewer reviewed, which the gate also checked");
    if (head && !(head.startsWith(reviewed) || reviewed.startsWith(head.slice(0, 7))))
      die(`reviewed sha ${reviewed} does not match the head ${head}. Pass --head if it moved, and get the delta reviewed first.`);
  }
  // A design goes to the human as two links, and only the human's own words approve it.
  const design: Design = rec.design ?? { canvas: null, slides: null, approved: null, approved_at: null };
  for (const [flag, v] of [["--canvas", c.canvas], ["--slides", c.slides]] as const)
    if (v !== undefined && !isUrl(v)) die(`${flag} must be the artifact's URL, got ${pyRepr(v)}`);
  if (to === "design-review" && !((c.canvas || design.canvas) && (c.slides || design.slides)))
    die(`design-review needs --canvas <url> and --slides <url>: the published design and the slideset ${human} reads`);
  if (c.approved !== undefined && !(old === "design-review" && to === OFF))
    die(`--approved records ${human}'s approval of a design, so it belongs on design-review -> ${OFF}`);
  if (old === "design-review" && to === OFF && !c.approved && !c.force)
    die(`design-review -> ${OFF} is ${human}'s approval: pass --approved "<${human}'s words>". ` +
      `To send the design back for changes, go to designing.`);
  if (to === "done" && !c.evidence) warnings.push("done without --evidence (merge sha or PR url). Recorded, but say what you looked at.");
  if ((to === "agent-review" || to === "gate" || to === "colleague-review") && !c.evidence && !c.force)
    warnings.push(`${to} without --evidence. A sha, PR or message reference is what survives a compaction.`);
  if (to === OFF && (old === "colleague-review" || old === "your-review")) {
    // the next slice of a multi-PR ticket: the old PR belongs to the events log, not the record
    rec.pr = null;
    rec.prs = [];
  }
  if (to === "blocked") {
    rec.blocked_from = old !== "blocked" ? old : rec.blocked_from;
    if (!c.note) warnings.push(`blocked without --note: record the question you asked ${human} so nobody re-asks it`);
    rec.asked_you = relink && rec.asked_you
      ? { ...rec.asked_you, question: c.note ?? rec.asked_you.question, message: c.asks }
      : { question: c.note ?? null, at: now(), ...(c.asks ? { message: c.asks } : {}) };
  } else if (old === "blocked") {
    rec.blocked_from = null;
    rec.asked_you = null;
  }
  if (c.agent) rec.agent = c.agent;
  // Off the board from building, the builder is free and the next dispatch picks one. From
  // design-review the designer stays on the record, for the next round.
  const left = rec.agent ?? null;
  if (to === OFF && old === "building" && !c.agent) rec.agent = null;
  if (c.stack) rec.stack = c.stack;
  if (c.worktree) rec.worktree = c.worktree;
  if (c.pr || c.head || c.reviewed) {
    // rec.pr is the PR in focus; rec.prs holds every PR of this slice. --pr on a new repo#N appends.
    const prs: Pr[] = rec.prs?.length ? rec.prs : rec.pr ? [rec.pr] : [];
    const cur = rec.pr ?? {};
    // the focused PR is the element of prs with the same repo#number, never a detached copy
    let p: Pr = prs.find((x) => x.repo === cur.repo && x.number === cur.number) ?? cur;
    if (c.pr) {
      const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(c.pr);
      if (!m) die("--pr must look like owner/repo#N");
      const repo = m[1] as string;
      const number = Number(m[2]);
      const existing = prs.find((x) => x.repo === repo && x.number === number);
      if (existing) p = existing;
      else {
        p = { repo, number };
        prs.push(p);
      }
    }
    if (c.head) p.head = c.head;
    if (c.reviewed) p.reviewed_sha = c.reviewed;
    if (Object.keys(p).length && !prs.includes(p)) prs.push(p);
    rec.pr = p;
    rec.prs = prs;
  }
  if (untracked(ws, ticket)) rec.jira = null;
  else if (c.jira) rec.jira = c.jira;
  else if (to === OFF) rec.jira = ws.config.tracker.status.queued ?? rec.jira;
  else if (to === "done" || to === "colleague-review" || ((to === "building" || to === "designing") && old === null))
    rec.jira = trackerFor(ws, to);
  if (c.title) rec.title = squash(c.title, 90);
  if (c.canvas) design.canvas = c.canvas;
  if (c.slides) design.slides = c.slides;
  // a design drawn again is not the design that was approved
  if (to === "designing") [design.approved, design.approved_at] = [null, null];
  if (c.approved) [design.approved, design.approved_at] = [c.approved, now()];
  if (rec.design || to === "designing" || c.canvas || c.slides) rec.design = design;
  rec.state = to === OFF ? null : to;
  rec.since = now();
  if (isReview(to) && !rec.reached?.includes(to)) rec.reached = REVIEW_STATES.filter((s) => s === to || rec.reached?.includes(s));
  saveRec(ws, rec);
  appendEvent(ws, {
    t: now(), ticket, from: was, to, agent: rec.agent ?? left,
    evidence: c.evidence ?? c.approved ?? null, note: c.note ?? null, pr: rec.pr ?? null,
    ...(rec.design && (c.canvas || c.slides || c.approved) ? { design: rec.design } : {}),
  });
  const kind = ws.config.tracker.kind;
  const head = `${ticket}: ${was ?? "(new)"} -> ${to}  agent=${rec.agent || "-"}`;
  if (untracked(ws, ticket)) {
    out(`${head}  no ${TRACKER_LABEL[kind]} ticket`);
  } else {
    const should = to === "blocked" || to === OFF ? rec.jira : trackerFor(ws, to);
    out(`${head}  ${kind} should read: ${pyStr(should)}`);
  }
  for (const w of warnings) out(`  warning: ${w}`);
  return rec;
}

// A PR split off into its own item stays on both cards: --pr adds a PR to an item, and this takes
// one off. If it was the PR in focus, the focus moves to the last one left.
export function removePr(ws: Workspace, ticket: string, ref: string, note?: string, out: (line: string) => void = console.log): Rec {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  if (!m) die("--remove-pr must look like owner/repo#N");
  const [repo, number] = [m[1] as string, Number(m[2])];
  const rec = loadRec(ws, ticket);
  if (!rec) die(`no record for ${ticket}`);
  const prs = recPrs(rec);
  const same = (p: Pr) => p.repo === repo && p.number === number;
  if (!prs.some(same)) die(`${ticket} has no PR ${ref}; it has: ${prs.map((p) => `${p.repo}#${p.number}`).join(", ") || "none"}`);
  rec.prs = prs.filter((p) => !same(p));
  if (!rec.pr || same(rec.pr)) rec.pr = rec.prs.at(-1) ?? null;
  saveRec(ws, rec);
  appendEvent(ws, {
    t: now(), ticket, from: rec.state ?? OFF, to: rec.state ?? OFF, agent: rec.agent ?? null,
    evidence: `removed PR ${ref}`, note: note ?? null, pr: rec.pr ?? null,
  });
  out(`${ticket}: removed PR ${ref}; PRs now: ${rec.prs.map((p) => `${p.repo}#${p.number}`).join(", ") || "none"}`);
  return rec;
}

export function recPrs(rec: Rec): Pr[] {
  return rec.prs?.length ? rec.prs : rec.pr ? [rec.pr] : [];
}

export function showRec(ws: Workspace, rec: Rec, at = new Date()): string[] {
  let age = "";
  if (rec.since) age = `${Math.floor((at.getTime() - Date.parse(rec.since)) / 60000)}m`;
  const prs = recPrs(rec)
    .map((x) => `${(x.repo ?? "").split("/").pop()}#${x.number ?? ""}@${(x.head || "").slice(0, 7)}`)
    .join(", ") || "-";
  const s = rec.state;
  const lead = ws.config.agents.find((a) => a.role === "lead")?.name ?? "the lead";
  const wait = s === null ? "the backlog"
    : WAITING_ON_YOU.has(s) ? "you"
    : BUSY.has(s) ? pyStr(rec.agent)
    : s === "agent-review" ? (rec["reviewer"] as string | undefined) || "a reviewer"
    : s === "pr-open" || s === "gate" ? lead
    : s === "colleague-review" ? "colleagues"
    : "-";
  const d = rec.design;
  const jira = isLocal(rec.ticket) ? "none" : rec.jira || "?";
  const lines = [
    `  ${rec.ticket.padEnd(12)} ${(s ?? OFF).padEnd(17)} ${age.padStart(6)}  agent=${(rec.agent || "-").padEnd(8)} ` +
    `jira=${jira.padEnd(12)} pr=${prs.padEnd(40)} waiting on: ${wait}`,
  ];
  if (rec.asked_you?.question) lines.push(`  ${"".padEnd(12)} asked you: ${rec.asked_you.question} (${rec.asked_you.at})`);
  if (d && (d.slides || d.canvas))
    lines.push(`  ${"".padEnd(12)} design: slides ${d.slides ?? "-"} canvas ${d.canvas ?? "-"} ` +
      (d.approved ? `approved: ${d.approved} (${d.approved_at})` : "not approved"));
  return lines;
}
