import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type State, STATES } from "./config.js";
import type { Workspace } from "./workspace.js";
import { die, now, pyDumps, pyRepr, pyStr, squash } from "./util.js";

export { STATES, type State };

export const TRANSITIONS: Record<State, ReadonlySet<State>> = {
  "queued": new Set(["building", "blocked"]),
  "building": new Set(["pr-open", "queued", "blocked"]),
  "pr-open": new Set(["pr-open", "agent-review", "blocked"]),
  "agent-review": new Set(["fixing", "gate", "blocked"]),
  "fixing": new Set(["agent-review", "gate", "blocked"]),
  "gate": new Set(["your-review", "fixing", "blocked"]),
  "your-review": new Set(["colleague-review", "done", "fixing", "queued", "blocked"]),
  "colleague-review": new Set(["done", "fixing", "queued", "blocked"]),
  "done": new Set(),
  "blocked": new Set(STATES.filter((s) => s !== "blocked")),
};
export const BUSY: ReadonlySet<string> = new Set(["building", "fixing"]);
export const WAITING_ON_YOU: ReadonlySet<string> = new Set(["your-review", "blocked"]);
// Where a dispatch makes sense without argument. Anywhere else is a judgement, so it needs --force.
export const DISPATCHABLE: ReadonlySet<string | null> = new Set([null, "queued", "building", "fixing"]);

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
  asked_you: { question: string | null; at: string } | null;
  since: string | null;
  created: string;
  blocked_from: State | null;
  title?: string;
  [k: string]: unknown;
}

const LOCAL_RE = /^LOCAL-[a-z0-9][a-z0-9-]{1,40}$/;

export const isLocal = (k: string) => LOCAL_RE.test(k);

// A LOCAL key is factory bookkeeping and never appears on GitHub.
export const branchFor = (k: string) => (isLocal(k) ? k.slice("LOCAL-".length) : k);

export function validKey(ws: Workspace, k: string): boolean {
  return isLocal(k) || (ws.config.tracker.keyPattern?.test(k) ?? false);
}

const TRACKER_LABEL = { jira: "Jira", none: "tracker" } as const;

export const KEY_HINT = "neither a ticket key nor a local key like LOCAL-fix-flaky-login";

// No tracker means no ticket to keep in step, the same as a LOCAL key.
const untracked = (ws: Workspace, k: string) => isLocal(k) || ws.config.tracker.kind === "none";

export function trackerFor(ws: Workspace, s: State): string {
  const st = ws.config.tracker.status;
  return st[s] ?? (s === "blocked" ? "unchanged" : (st.building ?? "unchanged"));
}

export const recPath = (ws: Workspace, ticket: string) => join(ws.stateDir, `${ticket}.json`);

export function loadRec(ws: Workspace, ticket: string): Rec | null {
  const p = recPath(ws, ticket);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Rec) : null;
}

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

export function allRecs(ws: Workspace): Rec[] {
  if (!existsSync(ws.stateDir)) return [];
  return readdirSync(ws.stateDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(ws.stateDir, f), "utf8")) as Rec);
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
}

export function transition(ws: Workspace, ticket: string, next: string, c: Change = {}, out: (line: string) => void = console.log): Rec {
  const human = ws.config.human.name;
  if (!validKey(ws, ticket)) die(`${pyRepr(ticket)} is ${KEY_HINT}`);
  if (!(STATES as readonly string[]).includes(next)) die(`unknown state ${pyRepr(next)}; states: ${STATES.join(", ")}`);
  const to = next as State;
  let rec = loadRec(ws, ticket);
  if (rec === null) {
    if (to !== "queued" && to !== "building") die(`${ticket} has no record; the first state must be queued or building`);
    rec = {
      ticket, state: null, stack: c.stack ?? null, agent: c.agent ?? null,
      jira: untracked(ws, ticket) ? null : trackerFor(ws, "queued"),
      worktree: null, pr: null, asked_you: null, since: null, created: now(), blocked_from: null,
    };
  }
  const old = rec.state;
  if (old !== null && !c.force) {
    const allowed = TRANSITIONS[old];
    if (!allowed.has(to))
      die(`${ticket}: ${old} -> ${to} is not a valid transition. From ${old} you can go to: ` +
        `${[...allowed].sort().join(", ") || "nowhere, it is terminal"}. Use --force if you mean it.`);
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
  if (to === "done" && !c.evidence) warnings.push("done without --evidence (merge sha or PR url). Recorded, but say what you looked at.");
  if ((to === "agent-review" || to === "gate" || to === "colleague-review") && !c.evidence && !c.force)
    warnings.push(`${to} without --evidence. A sha, PR or message reference is what survives a compaction.`);
  if (to === "queued" && (old === "colleague-review" || old === "your-review")) {
    // the next slice of a multi-PR ticket: the old PR belongs to the events log, not the record
    rec.pr = null;
    rec.prs = [];
  }
  if (to === "blocked") {
    rec.blocked_from = old !== "blocked" ? old : rec.blocked_from;
    if (!c.note) warnings.push(`blocked without --note: record the question you asked ${human} so nobody re-asks it`);
    rec.asked_you = { question: c.note ?? null, at: now() };
  } else if (old === "blocked") {
    rec.blocked_from = null;
    rec.asked_you = null;
  }
  if (c.agent) rec.agent = c.agent;
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
  else if (to === "done" || to === "colleague-review" || (to === "building" && (old === null || old === "queued")))
    rec.jira = trackerFor(ws, to);
  if (c.title) rec.title = squash(c.title, 90);
  rec.state = to;
  rec.since = now();
  saveRec(ws, rec);
  appendEvent(ws, {
    t: now(), ticket, from: old, to, agent: rec.agent ?? null,
    evidence: c.evidence ?? null, note: c.note ?? null, pr: rec.pr ?? null,
  });
  const kind = ws.config.tracker.kind;
  const head = `${ticket}: ${old ?? "(new)"} -> ${to}  agent=${pyStr(rec.agent)}`;
  if (untracked(ws, ticket)) {
    out(`${head}  no ${TRACKER_LABEL[kind]} ticket`);
  } else {
    const should = to === "blocked" || (to === "queued" && old !== null) ? rec.jira : trackerFor(ws, to);
    out(`${head}  ${kind} should read: ${pyStr(should)}`);
  }
  for (const w of warnings) out(`  warning: ${w}`);
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
  const wait = s !== null && WAITING_ON_YOU.has(s) ? "you"
    : s !== null && BUSY.has(s) ? pyStr(rec.agent)
    : s === "agent-review" ? (rec["reviewer"] as string | undefined) || "a reviewer"
    : s === "queued" || s === "pr-open" || s === "gate" ? lead
    : s === "colleague-review" ? "colleagues"
    : "-";
  const jira = isLocal(rec.ticket) ? "none" : rec.jira || "?";
  const lines = [
    `  ${rec.ticket.padEnd(12)} ${pyStr(s).padEnd(17)} ${age.padStart(6)}  agent=${(rec.agent || "-").padEnd(8)} ` +
    `jira=${jira.padEnd(12)} pr=${prs.padEnd(40)} waiting on: ${wait}`,
  ];
  if (rec.asked_you?.question) lines.push(`  ${"".padEnd(12)} asked you: ${rec.asked_you.question} (${rec.asked_you.at})`);
  return lines;
}
