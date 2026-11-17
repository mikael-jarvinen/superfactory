// `factory watch reviews`: new review comments on the PRs of items in review, told to the lead so
// it can dispatch the builder. Its own job, every five minutes by default: the queue watcher reads
// the tracker through a model and stays at its own cadence, and this reads GitHub only. Mikael, 2026-11-17, after a colleague's factory answered his
// review comment on their PR by itself: "I need this feature in my factory ... So basically I need a
// script that alerts our factory when we get reviews". Until now nothing said a comment had come
// in until Mikael mentioned it or the gate tripped on an unresolved thread.
//
// It reads and tells, nothing more: no code changes, no replies, no resolving. Handling stays with
// the lead (fernandez/CLAUDE.md, "On a PR"). No model either: one GraphQL read for every watched PR,
// and rules for who wrote a comment and what it asks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER } from "../gate/comment.js";
import { allRecs, type Rec, recPrs } from "../state.js";
import { squash } from "../util.js";
import type { Workspace } from "../workspace.js";
import { beat, logTo, openLog, watcherGh } from "./job.js";
import { CONFLICT_WATCHED } from "./queue.js";
import { deliver } from "./relay.js";

// The newest comment time seen on each PR (owner/repo#n -> ISO time). In state/, beside the
// records, because it is what the factory has been told, not a log. Not a .json name: every .json
// file in state/ is read as an item's record.
export const reviewCursorsFile = (ws: Workspace) => join(ws.stateDir, "reviews.state");

export function loadCursors(ws: Workspace): Record<string, string> {
  try {
    const d = JSON.parse(readFileSync(reviewCursorsFile(ws), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(d).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export function saveCursors(ws: Workspace, cursors: Record<string, string>): void {
  if (!existsSync(ws.stateDir)) mkdirSync(ws.stateDir, { recursive: true });
  writeFileSync(reviewCursorsFile(ws), JSON.stringify(cursors, Object.keys(cursors).sort(), 2) + "\n");
}

interface Author {
  login: string;
  __typename?: string;
}
interface Comment {
  databaseId: number;
  createdAt: string;
  body: string;
  author: Author | null;
}
interface Thread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  comments: { nodes: Comment[] };
}
interface Review extends Comment {
  state: string;
}
interface PrNode {
  url: string;
  reviewThreads: { nodes: Thread[] };
  reviews: { nodes: Review[] };
  comments: { nodes: Comment[] };
}

const FIELDS = "databaseId createdAt body author { login __typename }";
const PR_FIELDS = `url
  reviewThreads(first: 100) { nodes { id isResolved path line originalLine comments(first: 50) { nodes { ${FIELDS} } } } }
  reviews(last: 50) { nodes { state ${FIELDS} } }
  comments(last: 50) { nodes { ${FIELDS} } }`;

const OWNER_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

// Every watched PR in one query, a repository alias per repo and a pullRequest alias per number,
// and the viewer: the token's login, which is the human's own.
export function reviewQuery(keys: string[]): string {
  const repos = new Map<string, number[]>();
  for (const k of keys) {
    const [repo, n] = k.split("#") as [string, string];
    repos.set(repo, [...(repos.get(repo) ?? []), Number(n)]);
  }
  const parts = [...repos].map(([repo, ns], i) => {
    const [, owner, name] = repo.match(OWNER_REPO) as [string, string, string];
    return `r${i}: repository(owner: "${owner}", name: "${name}") { ${ns.map((n) => `p${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join(" ")} }`;
  });
  return `query { viewer { login } rateLimit { cost remaining resetAt } ${parts.join(" ")} }`;
}

// The review bots whose comments are findings. Every other bot (sync-label, sonarcloud, codecov,
// CodeRabbit's walkthrough) reports a status and asks nothing, so it is not news.
const REVIEW_BOTS = /^(coderabbitai|copilot|aikido)/i;

export type Kind = "bot" | "colleague" | "human";
export type Shape = "finding" | "suggestion" | "question" | "change request" | "approval";

// What a body says once the machinery is gone: HTML comments, folded <details> and quoted lines.
function prose(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .split("\n").filter((l) => !l.startsWith(">")).join("\n")
    .trim();
}

// Who wrote it: a review bot, a colleague, or the human (the token's own login, without the
// factory's marker). null is a comment that is not news: the factory's own, a bot trigger the gate
// posted, or a bot that only reports.
export function kindOf(author: Author | null, body: string, viewer: string): Kind | null {
  if (body.startsWith(MARKER) || /^@coderabbitai\b/.test(body.trim())) return null;
  const login = (author?.login ?? "").replace(/\[bot\]$/, "");
  if (!login) return null;
  if (REVIEW_BOTS.test(login)) return "bot";
  if (author?.__typename === "Bot" || author?.login.endsWith("[bot]")) return null;
  return login === viewer ? "human" : "colleague";
}

// What it asks: a suggestion block, a question (its prose ends in '?'), or a change request. A
// bot's comment without a suggestion block is a finding. A review that only approves is that.
export function shapeOf(kind: Kind, body: string, reviewState?: string): Shape {
  if (/```suggestion\b/.test(body)) return "suggestion";
  if (kind === "bot") return "finding";
  const text = prose(body.replace(/```[\s\S]*?```/g, ""));
  if (text.endsWith("?")) return "question";
  if (reviewState === "APPROVED") return "approval";
  return "change request";
}

export interface Item {
  kind: Kind;
  shape: Shape;
  author: string;
  where: string;
  text: string;
  ids: string;
  at: string;
}

const TEXT_MAX = 200;

// The new items of one PR: comments after the cursor. A thread the factory answered last is handled
// (pr-comment replies to bots only). With no cursor yet (a PR the watcher has not seen), only the
// open threads count, so the first run after a PR comes into review says what is outstanding
// rather than its whole history.
export function newItems(pr: PrNode, viewer: string, cursor: string | undefined): { items: Item[]; newest: string | undefined } {
  const items: Item[] = [];
  let newest = cursor;
  const seen = (at: string) => {
    if (!newest || at > newest) newest = at;
    return !cursor || at > cursor;
  };
  const add = (c: Comment, where: string, ids: string, reviewState?: string) => {
    const kind = kindOf(c.author, c.body ?? "", viewer);
    if (!kind) return;
    const text = squash(prose(c.body ?? ""), TEXT_MAX + 1);
    if (!text && reviewState !== "APPROVED") return;
    items.push({
      kind, shape: shapeOf(kind, c.body ?? "", reviewState), author: c.author?.login ?? "", where, ids, at: c.createdAt,
      text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 3)}...` : text,
    });
  };
  for (const t of pr.reviewThreads?.nodes ?? []) {
    const cs = t.comments?.nodes ?? [];
    const answered = (cs.at(-1)?.body ?? "").startsWith(MARKER);
    const where = `${t.path ?? "?"}:${t.line ?? t.originalLine ?? "?"}`;
    for (const c of cs) {
      if (!seen(c.createdAt)) continue;
      if (answered || (!cursor && t.isResolved)) continue;
      add(c, where, `thread ${t.id}, comment ${c.databaseId}`);
    }
  }
  for (const r of pr.reviews?.nodes ?? []) if (seen(r.createdAt) && cursor) add(r, "review", `review ${r.databaseId}`, r.state);
  for (const c of pr.comments?.nodes ?? []) if (seen(c.createdAt) && cursor) add(c, "top-level", `comment ${c.databaseId}`);
  items.sort((a, b) => a.at.localeCompare(b.at));
  return { items, newest };
}

const KIND_LABEL: Record<Kind, string> = { bot: "bot", colleague: "colleague", human: "you" };

// The note's lines for one PR: a head line, and one line per item.
export function prLines(rec: Rec, key: string, url: string, items: Item[], human: string): string[] {
  const [remote, n] = key.split("#") as [string, string];
  return [
    `review: ${rec.ticket} ${remote.split("/").pop()}#${n} (${rec.state}) ${url}`,
    ...items.map((i) => `  - ${i.kind === "human" ? human : `${KIND_LABEL[i.kind]} ${i.author}`}, ${i.shape}, ${i.where}: "${i.text}" [${i.ids}]`),
  ];
}

export interface ReviewRead {
  // false when GitHub could not be read: no cursor moves, and the next run reads the same comments
  ok: boolean;
  lines: string[];
  cursors: Record<string, string>;
  prs: number;
  calls: number;
  // GitHub's GraphQL budget after the call, as it reported it
  rate?: { cost: number; remaining: number; resetAt: string };
}

// The new review comments on every watched PR, and the cursors to keep once the note is left. A
// read that fails says so in the log and moves no cursor, so the next run reads the same comments.
export function reviewComments(ws: Workspace, recs: Rec[], log: string): ReviewRead {
  const prev = loadCursors(ws);
  const watched = new Map<string, Rec>();
  for (const rec of recs.filter((r) => CONFLICT_WATCHED.has(r.state ?? "")))
    for (const p of recPrs(rec))
      if (p.repo && OWNER_REPO.test(p.repo) && typeof p.number === "number") watched.set(`${p.repo}#${p.number}`, rec);
  if (!watched.size) return { ok: true, lines: [], cursors: {}, prs: 0, calls: 0 };
  const keys = [...watched.keys()];
  // A PR seen for the first time with nothing on it yet starts its cursor here, so the first
  // comment after is news wherever it is written.
  const asked = new Date().toISOString();
  const r = watcherGh(["api", "graphql", "-f", `query=${reviewQuery(keys)}`]);
  let data: Record<string, unknown> | undefined;
  try {
    data = JSON.parse(r.stdout)?.data;
  } catch {
    // below
  }
  const viewer = (data?.viewer as { login?: string } | undefined)?.login;
  if (!data || !viewer) {
    logTo(log, `reviews: cannot read the review comments${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
    return { ok: false, lines: [], cursors: prev, prs: watched.size, calls: 1 };
  }
  const repos = [...new Set(keys.map((k) => k.split("#")[0] as string))];
  const lines: string[] = [];
  const cursors: Record<string, string> = {};
  for (const key of keys) {
    const [repo, n] = key.split("#") as [string, string];
    const node = (data[`r${repos.indexOf(repo)}`] as Record<string, PrNode | null> | undefined)?.[`p${n}`];
    if (!node) {
      if (prev[key]) cursors[key] = prev[key];
      continue;
    }
    const { items, newest } = newItems(node, viewer, prev[key]);
    cursors[key] = newest ?? asked;
    if (items.length) lines.push(...prLines(watched.get(key) as Rec, key, node.url, items, ws.config.human.name));
  }
  return { ok: true, lines, cursors, prs: watched.size, calls: 1, rate: data.rateLimit as ReviewRead["rate"] };
}

// One run: read, leave the lead a note when something is new, and move the cursors only once the
// note is left. The heartbeat says GitHub was read; the round reads it.
export function runReviews(ws: Workspace, out: (line: string) => void = console.log): number {
  const log = openLog(ws, "reviews");
  const t0 = Date.now();
  const r = reviewComments(ws, allRecs(ws), log);
  const delivered = r.lines.length ? deliver(ws, ["[review watcher]", ...r.lines].join("\n")) : true;
  if (r.ok && delivered) saveCursors(ws, r.cursors);
  if (r.ok) beat(ws, "reviews");
  const outcome = !r.ok ? "unreadable" : r.lines.length ? "reported" : "quiet";
  const rate = r.rate ? ` graphql_cost=${r.rate.cost} graphql_remaining=${r.rate.remaining}` : "";
  logTo(log, `outcome=${outcome} prs=${r.prs} gh_calls=${r.calls}${rate} ms=${Date.now() - t0}${r.lines.length ? ` delivered=${delivered}` : ""}`);
  for (const l of r.lines) out(l);
  out(`reviews: ${outcome}`);
  return r.ok && delivered ? 0 : 1;
}
