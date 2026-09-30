// What the gate asks GitHub, through the gh CLI. Every reader returns undefined when it could not
// read, so a caller can never mistake an API error for an empty answer.
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, pyRepr, run, type RunResult } from "../util.js";

export const ghBin = () => process.env.GH_BIN || "gh";

export const gh = (...args: string[]): RunResult => run(ghBin(), args);

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
}

// Check-runs at one commit, every page. This is the source the gate trusts: `gh pr checks` and
// GraphQL's statusCheckRollup both leave out some checks, the Copilot reviewer among them.
export function checkRuns(repo: Repo, sha: string): CheckRun[] | undefined {
  const all: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const d = api<{ total_count?: number; check_runs?: CheckRun[] }>(`repos/${repo.remote}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    if (!d || !Array.isArray(d.check_runs)) return undefined;
    all.push(...d.check_runs);
    if (d.check_runs.length === 0 || all.length >= (d.total_count ?? 0)) return all;
  }
}

export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
}

export function statuses(repo: Repo, sha: string): CommitStatus[] | undefined {
  const d = api<{ statuses?: CommitStatus[] }>(`repos/${repo.remote}/commits/${sha}/status`);
  return d && Array.isArray(d.statuses) ? d.statuses : undefined;
}
