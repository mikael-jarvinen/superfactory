// PR and review traffic across the watched repos, for the board's GitHub page.
//
// Mikael, 2026-11-23: "I want to analyse PR traffic all together from all the repos I choose to
// watch ... how many reviews happen per day, how many PRs get approved per day and grouped by
// person."
//
// GitHub is read with GraphQL search, a page of PRs per call with their reviews inside, never a call
// per PR. The answers are kept on disk in logs/github-analytics.json and fetched again only from
// where the last fetch left off (`updated:>=`), at most every 15 minutes. Counting is a pure function
// of that cache, so the page's filters cost no GitHub calls. Days are Europe/Helsinki days.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../workspace.js";
import { isMarked } from "../gate/comment.js";
import { ghBin } from "../gate/github.js";
import { MAX_OUTPUT } from "../util.js";

export const TZ = "Europe/Helsinki";
export const RANGES = [7, 30, 90] as const;
// What the cache keeps: the longest range and a week. The first read covers it in steps of
// STEP_DAYS, each saved when done, so a read cut short resumes where it stopped.
const KEEP_DAYS = 97;
const STEP_DAYS = 10;
const REFRESH_MS = 15 * 60_000;
// GitHub's search answers at most this many results for one query; a wider window is split.
const SEARCH_CAP = 1000;

// The review-bot accounts. GraphQL types most of them as Bot; the names cover one that comes back as
// a User. The workspace's github.bots are added to these.
const BOTS = ["coderabbitai", "copilot", "copilot-pull-request-reviewer", "aikido-pr-checks", "github-actions", "sonarcloud", "codecov"];

export interface Person {
  login: string;
  name: string;
  avatar: string;
  bot: boolean;
}

export interface Review {
  state: string;
  at: string;
  author: Person | null;
  // posted by the factory under the human's login, as its comment marker says
  factory: boolean;
}

export interface Pr {
  repo: string;
  number: number;
  title: string;
  url: string;
  created: string;
  // the first time it was marked ready, when it was opened as a draft
  ready: string | null;
  merged: string | null;
  closed: string | null;
  state: string;
  draft: boolean;
  updated: string;
  // lines added and removed, as GitHub counts them when read: lockfiles and generated files included
  additions?: number;
  deletions?: number;
  author: Person | null;
  reviews: Review[];
}

// A cache written before a field the page counts was read, re-read once from the start of the kept
// window: version 2 brought the lines each PR changes.
const CACHE_VERSION = 2;

export interface Cache {
  version?: number;
  // per repo remote: read up to `fetched`, whether the first read is done (every step, and the open
  // PRs older than the kept window), and its PRs by number
  repos: Record<string, { fetched: string; complete?: boolean; prs: Record<string, Pr> }>;
}

// ---------------------------------------------------------------- reading GitHub

const PERSON = "login __typename avatarUrl(size: 40) ... on User { name }";
const QUERY = `query($q: String!, $after: String, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url createdAt updatedAt mergedAt closedAt state isDraft additions deletions
      author { ${PERSON} }
      timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT], first: 1) {
        nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } }
      }
      reviews(first: 100) { nodes { state submittedAt body author { ${PERSON} } } }
    } }
  }
  rateLimit { remaining resetAt }
}`;

interface RawPerson {
  login?: string;
  __typename?: string;
  avatarUrl?: string;
  name?: string | null;
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: string;
  isDraft: boolean;
  additions?: number;
  deletions?: number;
  author: RawPerson | null;
  timelineItems?: { nodes: { __typename?: string; createdAt?: string }[] };
  reviews?: { nodes: { state: string; submittedAt: string | null; body: string | null; author: RawPerson | null }[] };
}

export type Graphql = (query: string, vars: Record<string, string>) => Promise<string>;

const ghGraphql: Graphql = (query, vars) =>
  new Promise((resolve) => {
    const args = ["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-F", `${k}=${v}`])];
    // gh prints GitHub's JSON answer, errors included. Anything else (nothing, or a gateway's HTML
    // error page) becomes an error carrying what gh said, "HTTP 502" or a timeout, so a failed read
    // says why and ask() can tell a passing failure.
    execFile(ghBin(), args, { timeout: 120_000, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      try {
        JSON.parse(stdout);
        resolve(stdout);
      } catch {
        resolve(JSON.stringify({ errors: [{ message: String(stderr || err?.message || "gh printed no JSON").trim().split("\n")[0] }] }));
      }
    });
  });

export function person(p: RawPerson | null | undefined, bots: Set<string>): Person | null {
  if (!p?.login) return null;
  const login = p.login;
  const bot = p.__typename === "Bot" || login.endsWith("[bot]") || bots.has(login.toLowerCase()) || bots.has(login.replace(/\[bot\]$/, "").toLowerCase());
  return { login, name: p.name?.trim() || login, avatar: p.avatarUrl ?? "", bot };
}

export function toPr(repo: string, n: RawPr, bots: Set<string>): Pr {
  const first = n.timelineItems?.nodes?.[0];
  return {
    repo,
    number: n.number,
    title: n.title,
    url: n.url,
    created: n.createdAt,
    // opened as a draft when the first draft event is the one that made it ready
    ready: first?.__typename === "ReadyForReviewEvent" ? first.createdAt ?? null : null,
    merged: n.mergedAt,
    closed: n.closedAt,
    state: n.state,
    draft: n.isDraft,
    updated: n.updatedAt,
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    author: person(n.author, bots),
    reviews: (n.reviews?.nodes ?? []).filter((r) => r.submittedAt).map((r) => ({
      state: r.state,
      at: r.submittedAt as string,
      author: person(r.author, bots),
      factory: isMarked(r.body ?? ""),
    })),
  };
}

// A page costs 2 points. Asking for each review's first comment, to tell a reply in a thread from a
// review, made it 52 (rateLimit dryRun, 2026-11-23), so reviews are counted per person, PR and day
// instead (see report()), which folds a reviewer's replies into their review that day.
//
// GitHub's secondary rate limit refuses a run of heavy searches fired back to back ("API rate limit
// exceeded", type RATE_LIMITED, with points to spare): on 2026-11-23 a first read of five repos was
// cut off by it after ten minutes. So pages are paced, and a refused page waits and is asked again.
// A page of 100 PRs with their line counts can also time out behind GitHub's gateway (HTTP 502, the
// same day, an hour of classic with 400 PRs updated in it), or come back cut short (gh: "unexpected end of
// JSON input"): that page is asked again at half the size.
export const pacing = { pageMs: 1500, limitedMs: 60_000, failedMs: 5_000, tries: 4, reserve: 1500, page: 100, minPage: 10 };

// The GraphQL points are the whole fleet's: the gate, the review watcher and the board's badges all
// spend them. A read stops while fewer than pacing.reserve are left, and goes on at a later refresh.
export class BudgetLow extends Error {}
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(gql: Graphql, asked: Record<string, string>): Promise<{ data?: Record<string, unknown> }> {
  const vars = { first: String(pacing.page), ...asked };
  for (let i = 1; ; i++) {
    const raw = await gql(QUERY, vars);
    let d: { data?: Record<string, unknown>; errors?: { type?: string; message?: string }[] } = {};
    try {
      d = JSON.parse(raw || "{}");
    } catch {
      // not JSON: gh itself failed; asked again below like a refusal
    }
    const limited = !d.data && (!raw || (d.errors ?? []).some((e) => e.type === "RATE_LIMITED" || /rate limit/i.test(e.message ?? "")));
    const passing = !d.data && !limited && (d.errors ?? []).some((e) => /HTTP 5\d\d|time(d)? ?out|ETIMEDOUT|ECONNRESET|no JSON|something went wrong|unexpected (end of JSON|EOF)/i.test(e.message ?? ""));
    if (passing && i < pacing.tries) {
      vars.first = String(Math.max(pacing.minPage, Math.floor(Number(vars.first) / 2)));
      await sleepMs(pacing.failedMs * i);
      continue;
    }
    if (!limited || i >= pacing.tries) {
      await sleepMs(pacing.pageMs);
      if (!d.data) throw new Error((d.errors ?? []).map((e) => e.message).join("; ") || "no answer from GitHub");
      const rate = d.data.rateLimit as { remaining?: number; resetAt?: string } | undefined;
      if (typeof rate?.remaining === "number" && rate.remaining < pacing.reserve)
        throw new BudgetLow(`paused with ${rate.remaining} GraphQL points left, under the ${pacing.reserve} kept for the fleet; goes on after ${rate.resetAt ?? "the reset"}`);
      return d;
    }
    await sleepMs(pacing.limitedMs * i);
  }
}

// Every PR in one repo updated in a window, a page of 100 at a time; a window GitHub would cut at
// 1000 results is read as two halves.
async function fetchWindow(gql: Graphql, remote: string, from: Date, to: Date, bots: Set<string>, out: Pr[]): Promise<void> {
  const q = `repo:${remote} is:pr updated:${from.toISOString().slice(0, 19)}Z..${to.toISOString().slice(0, 19)}Z`;
  let after: string | undefined;
  for (let page = 0; ; page++) {
    const d = (await ask(gql, after ? { q, after } : { q })).data?.search as { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawPr[] } | undefined;
    if (!d) throw new Error(`GitHub did not answer the search for ${remote}`);
    if (page === 0 && d.issueCount > SEARCH_CAP && to.getTime() - from.getTime() > 3600_000) {
      const mid = new Date((from.getTime() + to.getTime()) / 2);
      await fetchWindow(gql, remote, from, mid, bots, out);
      await fetchWindow(gql, remote, mid, to, bots, out);
      return;
    }
    for (const n of d.nodes) if (n && typeof n.number === "number") out.push(toPr(remote, n, bots));
    if (!d.pageInfo.hasNextPage) return;
    after = d.pageInfo.endCursor;
  }
}

// Open PRs nobody has touched in the window still count as open at each day's end.
async function fetchOpen(gql: Graphql, remote: string, before: Date, bots: Set<string>, out: Pr[]): Promise<void> {
  const q = `repo:${remote} is:pr is:open updated:<${before.toISOString().slice(0, 19)}Z`;
  let after: string | undefined;
  for (;;) {
    const d = (await ask(gql, after ? { q, after } : { q })).data?.search as { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawPr[] } | undefined;
    if (!d) throw new Error(`GitHub did not answer the open PRs of ${remote}`);
    for (const n of d.nodes) if (n && typeof n.number === "number") out.push(toPr(remote, n, bots));
    if (!d.pageInfo.hasNextPage) return;
    after = d.pageInfo.endCursor;
  }
}

export const cacheFile = (ws: Workspace) => join(ws.logsDir, "github-analytics.json");

export function readCache(ws: Workspace): Cache {
  try {
    const c = JSON.parse(readFileSync(cacheFile(ws), "utf8")) as Cache;
    return c && typeof c.repos === "object" ? c : { version: CACHE_VERSION, repos: {} };
  } catch {
    return { version: CACHE_VERSION, repos: {} };
  }
}

// An older cache keeps its PRs, so the page shows them while the new read runs, and is read again
// from the start of the kept window, step by step as a first read is.
function upgrade(c: Cache, keepFrom: Date): void {
  if ((c.version ?? 1) >= CACHE_VERSION) return;
  for (const entry of Object.values(c.repos)) {
    entry.fetched = keepFrom.toISOString();
    entry.complete = false;
  }
  c.version = CACHE_VERSION;
}

function writeCache(ws: Workspace, c: Cache): void {
  mkdirSync(ws.logsDir, { recursive: true });
  const tmp = `${cacheFile(ws)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, cacheFile(ws));
}

// Brings each watched repo up to now: the first time KEEP_DAYS back plus every open PR, after that
// only what changed since the last fetch began, with a few minutes' overlap. A repo that fails keeps
// what it had and is tried again next time.
export async function refreshCache(ws: Workspace, remotes: string[], gql: Graphql = ghGraphql, now = new Date()): Promise<{ cache: Cache; failed: string[] }> {
  const cache = readCache(ws);
  const bots = new Set([...BOTS, ...ws.config.github.bots.map((b) => b.toLowerCase())]);
  const failed: string[] = [];
  const keepFrom = new Date(now.getTime() - KEEP_DAYS * 86_400_000);
  upgrade(cache, keepFrom);
  let stop: string | null = null;
  for (const remote of remotes) {
    if (stop) {
      failed.push(`${remote} (${stop})`);
      continue;
    }
    const entry = (cache.repos[remote] ??= { fetched: keepFrom.toISOString(), complete: false, prs: {} });
    const save = (got: Pr[], upTo: Date) => {
      for (const p of got) entry.prs[p.number] = p;
      // what closed before the kept window no longer counts anywhere
      for (const [k, p] of Object.entries(entry.prs)) if (p.closed && Date.parse(p.closed) < keepFrom.getTime()) delete entry.prs[k];
      entry.fetched = upTo.toISOString();
      writeCache(ws, cache);
    };
    try {
      // a little overlap with the last read, which may have ended mid-update
      let from = new Date(Math.max(keepFrom.getTime(), Date.parse(entry.fetched) - 5 * 60_000));
      while (from < now) {
        const to = new Date(Math.min(now.getTime(), from.getTime() + STEP_DAYS * 86_400_000));
        const got: Pr[] = [];
        await fetchWindow(gql, remote, from, to, bots, got);
        save(got, to);
        from = to;
      }
      if (!entry.complete) {
        const got: Pr[] = [];
        await fetchOpen(gql, remote, keepFrom, bots, got);
        entry.complete = true;
        save(got, new Date(entry.fetched));
      }
    } catch (e) {
      failed.push(`${remote} (${(e as Error).message})`);
      if (e instanceof BudgetLow) stop = (e as Error).message;
    }
  }
  writeCache(ws, cache);
  return { cache, failed };
}

// The board's handle on the cache: an answer at once, and a refresh in the background when the last
// one is over 15 minutes old.
export class GithubTraffic {
  private busy = false;
  private last = 0;
  failed: string[] = [];
  error: string | null = null;

  constructor(private ws: Workspace, private gql: Graphql = ghGraphql) {}

  remotes(): string[] {
    return this.ws.config.analytics.repos.map((k) => this.ws.config.repos[k]?.remote).filter((r): r is string => !!r);
  }

  fetching(): boolean {
    return this.busy;
  }

  refresh(force = false): Promise<void> | null {
    if (this.busy || (!force && Date.now() - this.last < REFRESH_MS)) return null;
    this.busy = true;
    this.last = Date.now();
    return refreshCache(this.ws, this.remotes(), this.gql)
      .then((r) => { this.failed = r.failed; this.error = null; })
      .catch((e: Error) => { this.error = e.message; })
      .finally(() => { this.busy = false; });
  }
}

// ---------------------------------------------------------------- counting

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
// The Helsinki date of an instant, as YYYY-MM-DD.
export const dayOf = (iso: string | Date): string => dayFmt.format(typeof iso === "string" ? new Date(iso) : iso);

// The last `n` Helsinki days, oldest first, ending with the day `now` falls on.
export function daysEnding(now: Date, n: number): string[] {
  const end = dayOf(now);
  const out: string[] = [];
  // Noon UTC of the end day, stepped back a day at a time, lands on each calendar day exactly once.
  const t = Date.parse(`${end}T12:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export interface Options {
  days: number;
  repos: string[];
  bots: boolean;
  now?: Date;
}

export interface PersonCount extends Person {
  reviews: number;
  approvals: number;
  changes: number;
  comments: number;
  // the size of each PR they reviewed, once per review: additions plus deletions
  lines: number;
}

// A PR author's own PRs in the range: opened, merged, closed unmerged, and the lines of those merged.
export interface AuthorCount extends Person {
  opened: number;
  merged: number;
  closed: number;
  lines: number;
  added: number;
  deleted: number;
}

export type TrafficMetric = "opened" | "merged" | "closed" | "open" | "lines" | "added" | "deleted";

// Who opened a PR. A deleted account has no author, as GitHub's own "ghost".
const GHOST: Person = { login: "ghost", name: "ghost", avatar: "", bot: false };
export const authorOf = (p: Pr): Person => p.author ?? GHOST;

export interface Report {
  days: string[];
  repos: string[];
  // per metric, per repo, a count per day
  // lines: additions plus deletions of the PRs merged that day; added and deleted, the two halves
  traffic: Record<TrafficMetric, Record<string, number[]>>;
  // the same, per PR author login. Mikael, 2026-11-25: "it colors the columns based on repos, but I
  // want to also view by PR author."
  byAuthor: Record<TrafficMetric, Record<string, number[]>>;
  // every author with a PR counted in the range, most PRs opened first
  authors: AuthorCount[];
  // per metric, per reviewer login, a count per day; lines: the size of each PR reviewed that day
  reviews: Record<"reviews" | "approvals" | "changes" | "lines", Record<string, number[]>>;
  people: PersonCount[];
  medians: { firstReviewHours: number | null; firstReviewN: number; mergeHours: number | null; mergeN: number };
  prs: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

// A review that counts: submitted, not the PR's own author answering in its threads, and, unless bots
// are shown, by a person rather than a bot or the factory.
export function counts(r: Review, pr: Pr, bots: boolean): boolean {
  if (!r.author || r.state === "PENDING") return false;
  if (pr.author && r.author.login === pr.author.login) return false;
  return bots || (!r.author.bot && !r.factory);
}

const human = (r: Review, pr: Pr) => counts(r, pr, false);

export function report(prs: Pr[], o: Options): Report {
  const now = o.now ?? new Date();
  const days = daysEnding(now, o.days);
  const at = new Map(days.map((d, i) => [d, i]));
  const first = days[0] as string;
  const last = days[days.length - 1] as string;
  const zeros = () => days.map(() => 0);
  const wanted = new Set(o.repos);
  const mine = prs.filter((p) => wanted.has(p.repo));

  const traffic: Report["traffic"] = { opened: {}, merged: {}, closed: {}, open: {}, lines: {}, added: {}, deleted: {} };
  for (const r of o.repos) for (const m of Object.keys(traffic) as TrafficMetric[]) traffic[m][r] = zeros();
  const byAuthor: Report["byAuthor"] = { opened: {}, merged: {}, closed: {}, open: {}, lines: {}, added: {}, deleted: {} };
  const authors = new Map<string, AuthorCount>();
  const reviews: Report["reviews"] = { reviews: {}, approvals: {}, changes: {}, lines: {} };
  const people = new Map<string, PersonCount>();
  const firstReview: number[] = [];
  const toMerge: number[] = [];

  const bump = (series: Record<string, number[]>, key: string, day: string, by = 1) => {
    const i = at.get(day);
    if (i === undefined) return;
    (series[key] ??= zeros())[i] = (series[key]![i] ?? 0) + by;
  };
  const size = (p: Pr) => (p.additions ?? 0) + (p.deletions ?? 0);

  const reviewsOf = (p: Pr) => {
    // One review per reviewer, PR and Helsinki day: GitHub files every reply in a thread as a review of
    // its own, so a reviewer answering five times is still one review that day. It is an approval if
    // they approved that day, a change request if they asked for changes, and a comment otherwise.
    const sittings = new Map<string, { who: Person; day: string; states: Set<string> }>();
    for (const r of p.reviews) {
      if (!counts(r, p, o.bots)) continue;
      const day = dayOf(r.at);
      if (day < first || day > last) continue;
      const who = r.author as Person;
      const key = `${who.login}\0${day}`;
      const s = sittings.get(key) ?? { who, day, states: new Set<string>() };
      s.states.add(r.state);
      sittings.set(key, s);
    }
    for (const { who, day, states } of sittings.values()) {
      const c = people.get(who.login) ?? { ...who, reviews: 0, approvals: 0, changes: 0, comments: 0, lines: 0 };
      c.reviews++;
      c.lines += size(p);
      bump(reviews.reviews, who.login, day);
      bump(reviews.lines, who.login, day, size(p));
      if (states.has("APPROVED")) { c.approvals++; bump(reviews.approvals, who.login, day); }
      if (states.has("CHANGES_REQUESTED")) { c.changes++; bump(reviews.changes, who.login, day); }
      if (!states.has("APPROVED") && !states.has("CHANGES_REQUESTED")) c.comments++;
      people.set(who.login, c);
    }
  };

  for (const p of mine) {
    // A PR a bot opened (dependabot, the dependency and autofix apps) is PR traffic only with bots
    // shown; a person's review of it is a review either way.
    const counted = o.bots || !p.author?.bot;
    reviewsOf(p);
    if (!counted) continue;
    // Each count goes to the PR's repo and to its author alike, so the two groupings add up the same.
    const a = authorOf(p);
    const both = (m: TrafficMetric, day: string, by = 1) => {
      bump(traffic[m], p.repo, day, by);
      bump(byAuthor[m], a.login, day, by);
    };
    const tally = (f: (c: AuthorCount) => void) => {
      const c = authors.get(a.login) ?? { ...a, opened: 0, merged: 0, closed: 0, lines: 0, added: 0, deleted: 0 };
      f(c);
      authors.set(a.login, c);
    };
    const inRange = (day: string) => at.has(day);
    tally(() => {}); // known by name and face even with only an older PR open in the range
    both("opened", dayOf(p.created));
    if (inRange(dayOf(p.created))) tally((c) => c.opened++);
    if (p.merged) {
      const day = dayOf(p.merged);
      both("merged", day);
      both("lines", day, size(p));
      both("added", day, p.additions ?? 0);
      both("deleted", day, p.deletions ?? 0);
      if (inRange(day)) tally((c) => { c.merged++; c.lines += size(p); c.added += p.additions ?? 0; c.deleted += p.deletions ?? 0; });
    }
    else if (p.closed) {
      both("closed", dayOf(p.closed));
      if (inRange(dayOf(p.closed))) tally((c) => c.closed++);
    }
    // open at a day's end: opened on or before it, and not closed by its end
    const from = dayOf(p.created);
    const until = p.closed ? dayOf(p.closed) : null;
    days.forEach((d, i) => {
      if (from <= d && (until === null || until > d)) {
        traffic.open[p.repo]![i]! += 1;
        (byAuthor.open[a.login] ??= zeros())[i]! += 1;
      }
    });

    // From opening, or from the first undrafting of a PR opened as a draft. A PR still a draft has
    // not started.
    const start = p.ready ?? (p.draft ? null : p.created);
    if (start) {
      const t0 = Date.parse(start);
      const fr = p.reviews.filter((r) => human(r, p) && Date.parse(r.at) >= t0).map((r) => Date.parse(r.at)).sort((a, b) => a - b)[0];
      if (fr !== undefined && dayOf(new Date(fr)) >= first && dayOf(new Date(fr)) <= last) firstReview.push((fr - t0) / 3600_000);
      if (p.merged && dayOf(p.merged) >= first && dayOf(p.merged) <= last && Date.parse(p.merged) >= t0) toMerge.push((Date.parse(p.merged) - t0) / 3600_000);
    }
  }

  return {
    days,
    repos: o.repos,
    traffic,
    byAuthor,
    authors: [...authors.values()].sort((x, y) => y.opened - x.opened || y.merged - x.merged || x.login.localeCompare(y.login)),
    reviews,
    people: [...people.values()].sort((a, b) => b.reviews - a.reviews || b.approvals - a.approvals || a.login.localeCompare(b.login)),
    medians: { firstReviewHours: median(firstReview), firstReviewN: firstReview.length, mergeHours: median(toMerge), mergeN: toMerge.length },
    prs: mine.length,
  };
}

// Every PR the cache holds, newest data per repo.
export const allPrs = (c: Cache): Pr[] => Object.values(c.repos).flatMap((r) => Object.values(r.prs));

// Everyone by PRs opened plus the reviews that count, most first, then by login. A bot's PR counts
// only with bots shown, as in the traffic.
export function peopleRank(prs: Pr[], bots: boolean): string[] {
  const tally = new Map<string, number>();
  const add = (login: string) => tally.set(login, (tally.get(login) ?? 0) + 1);
  for (const p of prs) {
    if (bots || !p.author?.bot) add(authorOf(p).login);
    for (const r of p.reviews) if (counts(r, p, bots) && r.author) add(r.author.login);
  }
  return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([login]) => login);
}

export function cacheExists(ws: Workspace): boolean {
  return existsSync(cacheFile(ws));
}

// ---------------------------------------------------------------- the page's answer

export interface View {
  loading: boolean;
  fetching: boolean;
  // the oldest repo's last fetch, ISO; null before the first
  fetched: string | null;
  // repos whose first read is not done yet, and how far it has come, ISO
  reading: { name: string; upTo: string }[];
  failed: string[];
  error: string | null;
  ranges: readonly number[];
  days: number;
  bots: boolean;
  // the watched repos, and the stacks that group them
  repos: { key: string; remote: string; name: string }[];
  groups: { label: string; repos: string[] }[];
  selected: string[];
  // every person by PRs opened plus reviews over the whole cache. Both charts colour people by it, so a
  // person has one colour in PR and review traffic alike, whatever the filter (Mikael, 2026-11-25).
  rank: string[];
  report: Report | null;
}

export function githubView(ws: Workspace, traffic: { fetching(): boolean; failed: string[]; error: string | null }, q: URLSearchParams, now = new Date()): View {
  const watched = ws.config.analytics.repos.filter((k) => ws.config.repos[k]);
  const repos = watched.map((key) => {
    const remote = ws.config.repos[key]!.remote;
    return { key, remote, name: remote.split("/").pop() ?? remote };
  });
  const groups = Object.values(ws.config.stacks)
    .map((s) => ({ label: s.label, repos: s.repos.filter((r) => watched.includes(r)) }))
    .filter((g) => g.repos.length);
  const asked = (q.get("repos") ?? "").split(",").filter((k) => watched.includes(k));
  const selected = asked.length ? asked : watched;
  const daysQ = Number(q.get("days"));
  const days = (RANGES as readonly number[]).includes(daysQ) ? daysQ : 30;
  const bots = q.get("bots") === "1";
  const cache = readCache(ws);
  const keyOf = new Map(repos.map((r) => [r.remote, r.key]));
  const prs = allPrs(cache).filter((p) => keyOf.has(p.repo)).map((p) => ({ ...p, repo: keyOf.get(p.repo) as string }));
  const fetchedAt = repos.map((r) => cache.repos[r.remote]?.fetched).filter((f): f is string => !!f).sort();
  const loading = !repos.some((r) => Object.keys(cache.repos[r.remote]?.prs ?? {}).length);
  const reading = repos.filter((r) => !cache.repos[r.remote]?.complete).map((r) => ({ name: r.name, upTo: cache.repos[r.remote]?.fetched ?? "" }));
  const rank = peopleRank(prs, bots);
  return {
    loading,
    fetching: traffic.fetching(),
    fetched: fetchedAt[0] ?? null,
    reading,
    failed: traffic.failed,
    error: traffic.error,
    ranges: RANGES,
    days,
    bots,
    repos,
    groups,
    selected,
    rank,
    report: loading ? null : report(prs, { days, repos: selected, bots, now }),
  };
}
