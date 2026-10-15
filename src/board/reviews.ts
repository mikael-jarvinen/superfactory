import { execFile } from "node:child_process";
import { ghBin } from "../gate/github.js";

// Where each PR in review stands with its human reviewers, so the human can see from the board whether
// a PR still has no reviews, has been reviewed, or is approved and ready to merge. GitHub is read in
// the background, every PR in one GraphQL call, and the board is served the last answer.

// The review-bot accounts. GraphQL types most of them as Bot already; the names cover an account
// that comes back as a User.
const BOTS = new Set(["coderabbitai", "copilot", "copilot-pull-request-reviewer", "aikido-pr-checks", "github-actions"]);

interface Author {
  login?: string;
  __typename?: string;
}

// One pull request as the query below returns it.
export interface PrNode {
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  author: Author | null;
  reviews: { nodes: { state: string; author: Author | null }[] };
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { author: Author | null }[] } }[] };
}

export type ReviewState = "none" | "commented" | "changes" | "approved" | "merged" | "closed";

export interface ReviewStatus {
  state: ReviewState;
  // human reviewers other than the PR's author, each by their latest review
  reviewers: { login: string; state: string }[];
  ready: boolean;
  conflicts: boolean;
  draft: boolean;
  // unresolved review threads a human reviewer opened
  threads: number;
}

// A reply in a review thread is filed as a COMMENTED review by whoever wrote it, so the PR's author
// answering the bots would count as a reviewer. Only somebody else's review is one.
const reviewer = (a: Author | null, prAuthor: string | undefined): string | null => {
  const login = a?.login;
  if (!login || a?.__typename === "Bot" || login.endsWith("[bot]") || BOTS.has(login.toLowerCase())) return null;
  return login === prAuthor ? null : login;
};

export function reviewStatus(pr: PrNode): ReviewStatus {
  const prAuthor = pr.author?.login;
  // A reviewer's standing is their latest approval, change request or dismissal; a comment after an
  // approval does not take the approval back.
  const latest = new Map<string, string>();
  for (const r of pr.reviews.nodes) {
    const login = reviewer(r.author, prAuthor);
    if (login === null) continue;
    if (r.state === "COMMENTED" || r.state === "PENDING") {
      if (!latest.has(login)) latest.set(login, "COMMENTED");
    } else latest.set(login, r.state);
  }
  const reviewers = [...latest].map(([login, state]) => ({ login, state }));
  const has = (s: string) => reviewers.some((r) => r.state === s);
  const draft = pr.isDraft;
  const conflicts = pr.mergeable === "CONFLICTING";
  const threads = pr.reviewThreads.nodes.filter((t) => !t.isResolved && reviewer(t.comments.nodes[0]?.author ?? null, prAuthor) !== null).length;
  let state: ReviewState;
  if (pr.state === "MERGED") state = "merged";
  else if (pr.state === "CLOSED") state = "closed";
  else if (pr.reviewDecision === "CHANGES_REQUESTED" || has("CHANGES_REQUESTED")) state = "changes";
  // Without branch protection there is no decision, and one approval is the approval.
  else if (pr.reviewDecision === "APPROVED" || (pr.reviewDecision === null && has("APPROVED"))) state = "approved";
  else if (reviewers.length) state = "commented";
  else state = "none";
  const ready = state === "approved" && !draft && pr.mergeable === "MERGEABLE" && (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "HAS_HOOKS");
  return { state, reviewers, ready, conflicts, draft, threads };
}

const PR_FIELDS = `state isDraft mergeable mergeStateStatus reviewDecision author { login __typename }
  reviews(last: 100) { nodes { state author { login __typename } } }
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login __typename } } } } }`;

const OWNER_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

// The PRs by repo, in the order the keys name them. The query and the reading of its answer both use
// it, so a repository's alias means the same repo in each.
function byRepo(keys: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const k of keys) {
    const [repo, n] = k.split("#") as [string, string];
    if (!OWNER_REPO.test(repo) || !/^[1-9]\d*$/.test(n ?? "")) continue;
    out.set(repo, [...(out.get(repo) ?? []), Number(n)]);
  }
  return out;
}

// Every PR in one query: a repository alias per repo, a pullRequest alias per number in it.
export function prQuery(keys: string[]): string {
  const parts = [...byRepo(keys)].map(([repo, ns], i) => {
    const [, owner, name] = repo.match(OWNER_REPO) as [string, string, string];
    return `r${i}: repository(owner: "${owner}", name: "${name}") { ${ns.map((n) => `p${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join(" ")} }`;
  });
  return `query { ${parts.join(" ")} }`;
}

// The answer as repo#number -> node. A PR GitHub would not return is absent, not an error, and the
// answer to every other PR in the same call still counts.
export function parseAnswer(keys: string[], stdout: string): Map<string, PrNode> {
  const out = new Map<string, PrNode>();
  let data: Record<string, Record<string, PrNode | null> | null> | undefined;
  try {
    data = JSON.parse(stdout)?.data;
  } catch {
    return out;
  }
  if (!data) return out;
  [...byRepo(keys)].forEach(([repo, ns], i) => {
    for (const n of ns) {
      const node = data[`r${i}`]?.[`p${n}`];
      if (node && Array.isArray(node.reviews?.nodes)) out.set(`${repo}#${n}`, node);
    }
  });
  return out;
}

export type Fetch = (query: string) => Promise<string>;

const ghGraphql: Fetch = (query) =>
  new Promise((resolve) => {
    // gh exits non-zero when any one PR in the query fails, and still prints the rest of the answer
    execFile(ghBin(), ["api", "graphql", "-f", `query=${query}`], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(stdout || ""));
  });

export interface Cached extends ReviewStatus {
  checked_s: number;
  // the last read failed, and this is the one before it
  stale: boolean;
}

export class ReviewCache {
  private rows = new Map<string, { status: ReviewStatus; at: number; stale: boolean }>();
  private busy = false;
  private last = 0;

  constructor(private fetch: Fetch = ghGraphql) {}

  async refresh(keys: string[]): Promise<void> {
    if (this.busy || !keys.length) return;
    this.busy = true;
    this.last = Date.now();
    try {
      const got = parseAnswer(keys, await this.fetch(prQuery(keys)));
      for (const k of keys) {
        const node = got.get(k);
        const was = this.rows.get(k);
        if (node) this.rows.set(k, { status: reviewStatus(node), at: Date.now(), stale: false });
        else if (was) was.stale = true;
      }
    } finally {
      this.busy = false;
    }
  }

  // A PR that has just reached review is read now rather than at the next turn of the timer, at most
  // once a minute, so a new card does not wait five minutes for its badge.
  wantsEarly(keys: string[]): boolean {
    return !this.busy && Date.now() - this.last > 60_000 && keys.some((k) => !this.rows.has(k));
  }

  get(key: string): Cached | null {
    const r = this.rows.get(key);
    return r ? { ...r.status, checked_s: Math.floor((Date.now() - r.at) / 1000), stale: r.stale } : null;
  }
}
