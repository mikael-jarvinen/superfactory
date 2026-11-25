// What the gate asks GitHub, through the gh CLI. Every reader returns undefined when it could not
// read, so a caller can never mistake an API error for an empty answer.
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, pyRepr, run, type RunResult } from "../util.js";
import { git, overArgs } from "../worktree.js";

export const ghBin = () => process.env.GH_BIN || "gh";

export const gh = (...args: string[]): RunResult => run(ghBin(), args);

// GitHub refuses a PR's diff past 20000 lines with HTTP 406, however few files it touches:
// lyyti-events#894 was 52. Then the diff comes from the repo's checkout instead, origin/<base>...<head>
// after a fetch of the base, and of the PR's head when the checkout lacks it. Never a shallow fetch:
// .git/shallow is shared by every worktree of the checkout. `local` says where the diff came from.
const TOO_LARGE = /HTTP 406|too_large|exceeded the maximum number of lines/;
export function prDiff(repo: Repo, n: number, base: string, head: string): RunResult & { local?: boolean } {
  const r = gh("pr", "diff", String(n), "--repo", repo.remote);
  if (r.status === 0 || !TOO_LARGE.test(r.stderr) || repo.host) return r;
  const why = (what: string, x: RunResult) => ({ ...r, stderr: `${r.stderr.trim()}; and ${what} in ${repo.path} failed: ${x.stderr.trim()}` });
  const over = overArgs(repo.gitOver);
  const f = git(repo.path, ...over, "fetch", "-q", "origin", base);
  if (f.status !== 0) return why(`git fetch origin ${base}`, f);
  if (git(repo.path, "cat-file", "-e", `${head}^{commit}`).status !== 0) {
    const h = git(repo.path, ...over, "fetch", "-q", "origin", `refs/pull/${n}/head`);
    if (h.status !== 0) return why(`git fetch of #${n}'s head`, h);
  }
  const d = git(repo.path, "diff", "--no-color", "--no-ext-diff", "--find-renames", `origin/${base}...${head}`);
  return d.status === 0 ? { ...d, local: true } : why(`git diff origin/${base}...${head}`, d);
}

// The PR itself could not be read: nothing else the gate says would mean anything.
export class Unreadable extends FactoryError {
  constructor(message: string) {
    super(message, 2);
  }
}

// A repo key from factory.toml, or the owner/repo one of them names. A repo the config does not
// know has no base and no gate checks, so there is nothing to gate it against.
export function resolveRepo(ws: Workspace, keyOrRemote: string): Repo {
  const repos = ws.config.repos;
  const r = repos[keyOrRemote] ?? Object.values(repos).find((x) => x.remote === keyOrRemote);
  if (!r) {
    const known = Object.values(repos).map((x) => `${x.key} (${x.remote})`).join(", ") || "none";
    throw new FactoryError(`unknown repo ${pyRepr(keyOrRemote)}; repos in factory.toml: ${known}`, 2);
  }
  return r;
}

export function prNumber(s: string): number {
  if (!/^[1-9]\d*$/.test(s)) throw new FactoryError(`${pyRepr(s)} is not a PR number`, 2);
  return Number(s);
}

export function json<T = unknown>(r: RunResult): T | undefined {
  if (r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return undefined;
  }
}

export const api = <T = unknown>(path: string): T | undefined => json<T>(gh("api", path));

export interface PrView {
  headRefOid: string;
  headRefName: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  baseRefName: string;
  url: string;
  title: string;
  body: string;
}

const PR_FIELDS = "headRefOid,headRefName,state,isDraft,mergeable,mergeStateStatus,baseRefName,url,title,body";

export function prView(repo: Repo, n: number): PrView | undefined {
  const v = json<PrView>(gh("pr", "view", String(n), "--repo", repo.remote, "--json", PR_FIELDS));
  return v && typeof v.headRefOid === "string" && v.headRefOid ? v : undefined;
}

export function headOf(repo: Repo, n: number): string | undefined {
  const v = json<{ headRefOid?: string }>(gh("pr", "view", String(n), "--repo", repo.remote, "--json", "headRefOid"));
  return v?.headRefOid || undefined;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  details_url: string | null;
  output?: { title?: string | null };
  app?: { slug?: string };
  // the PRs GitHub tied the run to: those whose head it ran on
  pull_requests?: { number: number }[] | null;
}

// Check-runs at one commit, every page. This is the source the gate trusts: `gh pr checks` and
// GraphQL's statusCheckRollup both leave out some checks, the Copilot reviewer among them. A
// watcher passes its own reader, whose gh calls have a bound.
export function checkRuns(repo: Repo, sha: string, read: typeof api = api): CheckRun[] | undefined {
  const all: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const d = read<{ total_count?: number; check_runs?: CheckRun[] }>(`repos/${repo.remote}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    if (!d || !Array.isArray(d.check_runs)) return undefined;
    all.push(...d.check_runs);
    if (d.check_runs.length === 0 || all.length >= (d.total_count ?? 0)) return all;
  }
}

export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
  created_at?: string;
}

export function statuses(repo: Repo, sha: string): CommitStatus[] | undefined {
  const d = api<{ statuses?: CommitStatus[] }>(`repos/${repo.remote}/commits/${sha}/status`);
  return d && Array.isArray(d.statuses) ? d.statuses : undefined;
}

export interface Review {
  user: { login: string } | null;
  commit_id: string | null;
  state: string;
  body: string | null;
}

// Every page of a list endpoint, or undefined when any page cannot be read.
function allPages<T>(path: string): T[] | undefined {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const d = api<T[]>(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(d)) return undefined;
    all.push(...d);
    if (d.length < 100) return all;
  }
}

export interface ReviewComment {
  user: { login: string } | null;
  original_commit_id: string | null;
  in_reply_to_id?: number | null;
}

// Every inline review comment on a PR.
export const reviewComments = (repo: Repo, n: number) => allPages<ReviewComment>(`repos/${repo.remote}/pulls/${n}/comments`);

// The PR's commits, oldest first. A force-push drops the commits it replaced.
export const prCommits = (repo: Repo, n: number) => allPages<{ sha: string }>(`repos/${repo.remote}/pulls/${n}/commits`);

// The PRs GitHub ties a commit to: the open PRs that contain it, or the merged PR that brought it
// to the default branch.
export const commitPulls = (repo: Repo, sha: string) => allPages<{ number: number }>(`repos/${repo.remote}/commits/${sha}/pulls`);

// Every review on a PR, every page.
export function reviews(repo: Repo, n: number): Review[] | undefined {
  const all: Review[] = [];
  for (let page = 1; ; page++) {
    const d = api<Review[]>(`repos/${repo.remote}/pulls/${n}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(d)) return undefined;
    all.push(...d);
    if (d.length < 100) return all;
  }
}

// What was said to and by a review bot on PR #n since its head commit: when each trigger was last
// asked, and when the bot last answered that it is rate limited. Its rate-limit reply is a comment
// ("Action not completed ... Review rate limited"),
// sometimes with no check-run at the head to say so. Undefined when the comments cannot be read.
export interface Conversation {
  // trigger body -> ms since the epoch of its latest ask after the head commit
  asked: Map<string, number>;
  limitedAt?: number;
}

export function conversation(repo: Repo, n: number, head: string, botLogin: string): Conversation | undefined {
  const at = api<{ commit?: { committer?: { date?: string } } }>(`repos/${repo.remote}/commits/${head}`)?.commit?.committer?.date;
  const comments = at ? api<{ body?: string; created_at?: string; user?: { login?: string } | null }[]>(`repos/${repo.remote}/issues/${n}/comments?since=${at}&per_page=100`) : undefined;
  if (!at || !Array.isArray(comments)) return undefined;
  const talk: Conversation = { asked: new Map() };
  for (const c of comments) {
    const t = Date.parse(c.created_at ?? "");
    if (!Number.isFinite(t) || (c.created_at ?? "") <= at) continue;
    const body = c.body?.trim() ?? "";
    if ((c.user?.login ?? "").replace(/\[bot\]$/, "") === botLogin) {
      if (/rate limited/i.test(body) && t > (talk.limitedAt ?? 0)) talk.limitedAt = t;
    } else if (t > (talk.asked.get(body) ?? 0)) {
      talk.asked.set(body, t);
    }
  }
  return talk;
}
