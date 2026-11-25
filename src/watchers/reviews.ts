// `factory watch reviews`: new review comments on the PRs of items in review, told to the lead so
// it can dispatch the builder. Its own job, every five minutes by default: the queue watcher reads
// the tracker through a model and stays at its own cadence, and this reads GitHub only. It alerts the factory when a review comes in,
// rather than leaving it until the human mentions it or the gate trips on an unresolved thread.
//
// It reads and tells, nothing more: no code changes, no replies, no resolving. Handling stays with
// the lead (fernandez/CLAUDE.md, "On a PR"). No model either: one GraphQL read for every watched PR,
// and rules for who wrote a comment and what it asks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMarked } from "../gate/comment.js";
import { allRecs, type Rec, recPrs } from "../state.js";
import { squash } from "../util.js";
import type { Workspace } from "../workspace.js";
import { beat, logTo, openLog, watcherGh } from "./job.js";
import { CONFLICT_WATCHED } from "./queue.js";
import { deliver } from "./relay.js";
import { DARK_WAKE, darkWake, markAsleep } from "./power.js";

// What the watcher has read on each PR (owner/repo#n): the id of every comment and review in it,
// told or not. Ids, not a time: a review is published when it is submitted, its inline comments keep
// the draft's time, and two comments can share a second, so a time cursor loses both. In state/, beside the records, because it is what the factory has been told,
// not a log. Not a .json name: every .json file in state/ is read as an item's record. A PR's entry
// from before the ids is a time: what came before it counts as read.
export const reviewCursorsFile = (ws: Workspace) => join(ws.stateDir, "reviews.state");

export type Cursor = string[] | string;

export function loadCursors(ws: Workspace): Record<string, Cursor> {
  try {
    const d = JSON.parse(readFileSync(reviewCursorsFile(ws), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(d).filter((e): e is [string, Cursor] =>
      typeof e[1] === "string" || (Array.isArray(e[1]) && e[1].every((x) => typeof x === "string"))));
  } catch {
    return {};
  }
}

export function saveCursors(ws: Workspace, cursors: Record<string, Cursor>): void {
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
  // null while it sits in a review that is not submitted yet
  publishedAt?: string | null;
  body: string;
  author: Author | null;
}
interface Page<T> {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}
interface Thread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  comments: Page<Comment>;
}
interface Review extends Comment {
  state: string;
  // null until it is submitted
  submittedAt?: string | null;
}
export interface PrNode {
  url: string;
  reviewThreads: Page<Thread>;
  reviews: Page<Review>;
  comments: Page<Comment>;
}

const PAGE = 100;
// A thread's comments in the query for every PR: GitHub refuses a query that declares over 500,000
// nodes, counting each nested connection's first times its parents'. 100 threads of 100 comments
// made 10,300 per PR, so 49 watched PRs were refused, every poll, with no path to say which
//. 10 makes 1,300; readRest reads a longer thread's comments by
// their own query, a page of PAGE at a time.
const THREAD_FIRST_PAGE = 10;
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const FIELDS = "databaseId createdAt publishedAt body author { login __typename }";
const THREAD_COMMENTS = (after?: string) => `comments(first: ${after ? `${PAGE}, after: "${after}"` : THREAD_FIRST_PAGE}) { ${PAGE_INFO} nodes { ${FIELDS} } }`;
const CONNECTIONS = {
  reviewThreads: `id isResolved path line originalLine ${THREAD_COMMENTS()}`,
  reviews: `state submittedAt ${FIELDS}`,
  comments: FIELDS,
} as const;
type Conn = keyof typeof CONNECTIONS;
const connection = (c: Conn, after?: string) => `${c}(first: ${PAGE}${after ? `, after: "${after}"` : ""}) { ${PAGE_INFO} nodes { ${CONNECTIONS[c]} } }`;
const PR_FIELDS = `url ${(Object.keys(CONNECTIONS) as Conn[]).map((c) => connection(c)).join(" ")}`;

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

// The cursor to read a connection's next page after: null when it has no next page, and false when
// its page info cannot be followed: a next page with no cursor (an
// empty `after` reads page one again), or a cursor already read (the same page forever).
function nextCursor(info: Page<unknown>["pageInfo"] | undefined, seen: Set<string>): string | null | false {
  if (!info?.hasNextPage) return null;
  const at = info.endCursor;
  if (typeof at !== "string" || !at || seen.has(at)) return false;
  seen.add(at);
  return at;
}

// The rest of a PR's connections past their first page, and of each thread's comments past its
// first, read into node. False when a page cannot be read, or its page info does not move on: then
// nothing of the PR is taken as read.
function readRest(key: string, node: PrNode, query: (q: string) => Record<string, unknown> | undefined): boolean {
  const [repo, n] = key.split("#") as [string, string];
  const [, owner, name] = repo.match(OWNER_REPO) as [string, string, string];
  for (const c of Object.keys(CONNECTIONS) as Conn[]) {
    const conn = node[c] as Page<unknown>;
    const seen = new Set<string>();
    for (let at = nextCursor(conn.pageInfo, seen); at !== null; at = nextCursor(conn.pageInfo, seen)) {
      if (at === false) return false;
      const d = query(`query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${n}) { ${connection(c, at)} } } }`);
      const next = ((d?.repository as Record<string, unknown> | undefined)?.pullRequest as Record<string, Page<unknown>> | undefined)?.[c];
      // a fetched page without its page info cannot say the connection is complete
      if (!next || !Array.isArray(next.nodes) || !next.pageInfo) return false;
      conn.nodes.push(...next.nodes);
      conn.pageInfo = next.pageInfo;
    }
  }
  for (const t of node.reviewThreads.nodes) {
    const seen = new Set<string>();
    for (let at = nextCursor(t.comments.pageInfo, seen); at !== null; at = nextCursor(t.comments.pageInfo, seen)) {
      if (at === false) return false;
      const d = query(`query { node(id: "${t.id}") { ... on PullRequestReviewThread { ${THREAD_COMMENTS(at)} } } }`);
      const next = (d?.node as { comments?: Page<Comment> } | undefined)?.comments;
      if (!next || !Array.isArray(next.nodes) || !next.pageInfo) return false;
      t.comments.nodes.push(...next.nodes);
      t.comments.pageInfo = next.pageInfo;
    }
  }
  return true;
}

// The review bots whose comments are findings. Every other bot (sync-label, sonarcloud, codecov,
// CodeRabbit's walkthrough) reports a status and asks nothing, so it is not news.
const REVIEW_BOTS = /^(coderabbitai|copilot|aikido)/i;

export type Kind = "bot" | "colleague" | "human";
export type Shape = "finding" | "suggestion" | "question" | "change request" | "approval";

// What a body says once the machinery is gone: HTML comments, folded <details>, every other tag,
// bold markers and quoted lines. CodeRabbit opens a finding with an <img> icon inside bold, and
// the note's 200 characters went on markup before a word of the finding.
export function prose(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\*\*|__/g, "")
    .split("\n").filter((l) => !l.startsWith(">")).join("\n")
    .trim();
}

// Who wrote it: a review bot, a colleague, or the human (the token's own login, without the
// factory's marker). null is a comment that is not news: the factory's own, a bot trigger the gate
// posted, or a bot that only reports.
// The factory's own: its sessions post under the human's login, marked (the guard holds them to it).
export const isAgents = isMarked;

export function kindOf(author: Author | null, body: string, viewer: string): Kind | null {
  if (isAgents(body) || /^@coderabbitai\b/.test(body.trim())) return null;
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

// The new items of one PR: comments and reviews it has not read before, and the ids it has read now.
// A thread the factory answered last is handled (pr-comment replies to bots only). With no cursor
// yet (a PR the watcher has not seen), only the open threads count, so the first run after a PR
// comes into review says what is outstanding rather than its whole history. A review, or a comment
// in one, that is not submitted yet is not read: it is read when it is.
export function newItems(pr: PrNode, viewer: string, cursor: Cursor | undefined): { items: Item[]; read: string[] } {
  const items: Item[] = [];
  const read: string[] = [];
  const before = new Set(Array.isArray(cursor) ? cursor : []);
  // the first read of a PR, or, from a time cursor, what came before it
  const old = (id: string, at: string) => (typeof cursor === "string" ? at <= cursor : before.has(id));
  const fresh = (id: string, at: string) => {
    read.push(id);
    return !old(id, at);
  };
  const add = (c: Comment, at: string, where: string, ids: string, reviewState?: string) => {
    const kind = kindOf(c.author, c.body ?? "", viewer);
    if (!kind) return;
    const text = squash(prose(c.body ?? ""), TEXT_MAX + 1);
    if (!text && reviewState !== "APPROVED") return;
    items.push({
      kind, shape: shapeOf(kind, c.body ?? "", reviewState), author: c.author?.login ?? "", where, ids, at,
      text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 3)}...` : text,
    });
  };
  for (const t of pr.reviewThreads?.nodes ?? []) {
    const cs = (t.comments?.nodes ?? []).filter((c) => c.publishedAt !== null);
    const answered = isAgents(cs.at(-1)?.body ?? "");
    const where = `${t.path ?? "?"}:${t.line ?? t.originalLine ?? "?"}`;
    for (const c of cs) {
      const at = c.publishedAt ?? c.createdAt;
      if (!fresh(`c${c.databaseId}`, at)) continue;
      // the factory's answer handles the bot's findings above it, not a colleague's or the human's
      if ((answered && kindOf(c.author, c.body ?? "", viewer) === "bot") || (cursor === undefined && t.isResolved)) continue;
      add(c, at, where, `thread ${t.id}, comment ${c.databaseId}`);
    }
  }
  // A bot's review body is its summary ("Actionable comments posted: 3"); its findings are the
  // inline comments, listed above.
  for (const r of pr.reviews?.nodes ?? []) {
    if (r.state === "PENDING" || r.submittedAt === null) continue;
    const at = r.submittedAt ?? r.createdAt;
    if (fresh(`r${r.databaseId}`, at) && cursor !== undefined && kindOf(r.author, r.body ?? "", viewer) !== "bot") add(r, at, "review", `review ${r.databaseId}`, r.state);
  }
  for (const c of pr.comments?.nodes ?? []) if (fresh(`i${c.databaseId}`, c.createdAt) && cursor !== undefined) add(c, c.createdAt, "top-level", `comment ${c.databaseId}`);
  items.sort((a, b) => a.at.localeCompare(b.at));
  return { items, read: [...new Set(read)].sort() };
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
  cursors: Record<string, Cursor>;
  prs: number;
  calls: number;
  // PRs GitHub did not return, or not every page of: their cursors stay, and the read is not clean
  unread: string[];
  // why each unread PR was not read, as GitHub said it when it did
  why?: Record<string, string>;
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
  if (!watched.size) return { ok: true, lines: [], cursors: {}, prs: 0, calls: 0, unread: [] };
  const keys = [...watched.keys()];
  const r = watcherGh(["api", "graphql", "-f", `query=${reviewQuery(keys)}`]);
  let calls = 1;
  const repos = [...new Set(keys.map((k) => k.split("#")[0] as string))];
  let data: Record<string, unknown> | undefined;
  let errs: GqlError[] = [];
  try {
    const d = JSON.parse(r.stdout);
    data = d?.data;
    errs = Array.isArray(d?.errors) ? d.errors : [];
  } catch {
    // below
  }
  // GitHub returns what it could beside its errors, and gh then exits nonzero. An error whose path
  // names a PR (r<i>.p<n>) leaves that PR unread, and one naming a repo (r<i>: gone, moved, or the
  // token lost access) leaves that repo's PRs unread; the rest are read. Any other error, or a
  // failed exit with no error to say why, leaves the whole read unread.
  const why: Record<string, string> = {};
  let whole = r.status !== 0 && !errs.length;
  for (const e of errs) {
    const [rk, pk] = (Array.isArray(e?.path) ? e.path : []).map(String);
    const repo = /^r\d+$/.test(rk ?? "") ? repos[Number((rk as string).slice(1))] : undefined;
    const hit = !repo ? [] : /^p\d+$/.test(pk ?? "") ? [`${repo}#${(pk as string).slice(1)}`].filter((k) => watched.has(k))
      : keys.filter((k) => k.startsWith(`${repo}#`));
    if (!hit.length) whole = true;
    for (const k of hit) why[k] = `${repo}${pk && /^p\d+$/.test(pk) ? ` #${pk.slice(1)}` : ""}: ${e?.message ?? "error"}`;
  }
  const viewer = (data?.viewer as { login?: string } | undefined)?.login;
  if (!data || !viewer || whole) {
    const why = errs.length ? errs.map((e) => e?.message ?? "?").join("; ") : r.stderr.trim();
    logTo(log, `reviews: cannot read the review comments${why ? `: ${why}` : ""}`);
    return { ok: false, lines: [], cursors: prev, prs: watched.size, calls, unread: keys };
  }
  if (errs.length) logTo(log, `reviews: GitHub answered with errors: ${errs.map((e) => e?.message ?? "?").join("; ")}`);
  const more = (q: string) => {
    calls++;
    const m = watcherGh(["api", "graphql", "-f", `query=${q}`]);
    try {
      const d = JSON.parse(m.stdout);
      const e = graphqlErrors(d);
      // a page with errors may be partial: it is not read
      if (e || m.status !== 0) {
        logTo(log, `reviews: cannot read a page: ${e || m.stderr.trim() || `gh exited ${m.status}`}`);
        return undefined;
      }
      return d?.data as Record<string, unknown> | undefined;
    } catch {
      logTo(log, `reviews: cannot read a page${m.stderr.trim() ? `: ${m.stderr.trim()}` : ""}`);
      return undefined;
    }
  };
  const unread: string[] = [];
  const lines: string[] = [];
  const cursors: Record<string, Cursor> = {};
  for (const key of keys) {
    const [repo, n] = key.split("#") as [string, string];
    const node = (data[`r${repos.indexOf(repo)}`] as Record<string, PrNode | null> | undefined)?.[`p${n}`];
    if (!node || why[key] || !readRest(key, node, more)) {
      logTo(log, `reviews: cannot read ${key}${node ? " past its first page" : ""}; it is read again next run`);
      unread.push(key);
      if (prev[key]) cursors[key] = prev[key];
      continue;
    }
    const { items, read } = newItems(node, viewer, prev[key]);
    cursors[key] = read;
    if (items.length) lines.push(...prLines(watched.get(key) as Rec, key, node.url, items, ws.config.human.name));
  }
  return { ok: true, lines, cursors, prs: watched.size, calls, unread, why, rate: data.rateLimit as ReviewRead["rate"] };
}

interface GqlError {
  message?: string;
  path?: unknown[];
}

const graphqlErrors = (d: unknown): string => {
  const e = (d as { errors?: { message?: string }[] } | null)?.errors;
  return Array.isArray(e) && e.length ? e.map((x) => x?.message ?? "?").join("; ") : "";
};

// One run: read, leave the lead a note when something is new, and move the cursors only once the
// note is left. The heartbeat says GitHub was read; the round reads it.
export function runReviews(ws: Workspace, out: (line: string) => void = console.log): number {
  const log = openLog(ws, "reviews");
  if (darkWake()) {
    logTo(log, `outcome=${DARK_WAKE}`);
    markAsleep(ws, "reviews");
    out("reviews: dark-wake");
    return 0;
  }
  const t0 = Date.now();
  const r = reviewComments(ws, allRecs(ws), log);
  const delivered = r.lines.length ? deliver(ws, ["[review watcher]", ...r.lines].join("\n")) : true;
  if (r.ok && delivered) saveCursors(ws, r.cursors);
  // A PR that was not read is not a clean read: no heartbeat, so the round sees it.
  const clean = r.ok && !r.unread.length;
  if (clean) beat(ws, "reviews");
  const outcome = !r.ok ? "unreadable" : r.unread.length ? "partial" : r.lines.length ? "reported" : "quiet";
  const rate = r.rate ? ` graphql_cost=${r.rate.cost} graphql_remaining=${r.rate.remaining}` : "";
  logTo(log, `outcome=${outcome} prs=${r.prs} gh_calls=${r.calls}${rate} ms=${Date.now() - t0}${r.unread.length ? ` unread=${r.unread.join(",")}` : ""}${r.lines.length ? ` delivered=${delivered}` : ""}`);
  for (const l of r.lines) out(l);
  if (r.ok) for (const k of r.unread) out(`reviews: cannot read ${k}${r.why?.[k] ? ` (${r.why[k]})` : ""}; it is read again next run`);
  out(`reviews: ${outcome}`);
  return clean && delivered ? 0 : 1;
}
