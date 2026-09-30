// `factory delta-range <repo> <n> <claimed-base-sha>`: may this delta go to a reviewer?
//
// A reviewer handed an empty range and one handed a real range that finds nothing return the same
// answer, so the refusal has to happen here. A base is accepted only if it is a state the PR head
// has actually been: in GitHub's force-push timeline, in the local reflog of the branch's
// remote-tracking ref, or an ancestor of the head. Fails closed: anything that stops it before a
// verdict is a refusal.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "../config.js";
import { FactoryError, run, splitlines } from "../util.js";
import { api, prView } from "./github.js";

const HTTPS = ["-c", "url.https://github.com/.insteadOf=git@github.com:"];

function forcePushes(repo: Repo, n: number): string[] {
  const shas: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const d = api<{ event?: string; commit_id?: string }[]>(`repos/${repo.remote}/issues/${n}/timeline?per_page=100&page=${page}`);
    if (!Array.isArray(d)) break;
    for (const e of d) if (e.event === "head_ref_force_pushed" && e.commit_id) shas.push(e.commit_id);
    if (d.length < 100) break;
  }
  return shas;
}

export function deltaRange(repo: Repo, n: number, claimed: string, out: (line: string) => void = console.log): number {
  try {
    return decide(repo, n, claimed, out);
  } catch (e) {
    if (e instanceof FactoryError) throw e;
    out(`DO NOT DISPATCH -- delta-range stopped before reaching a verdict: ${(e as Error).message}`);
    return 1;
  }
}

function decide(repo: Repo, n: number, claimed: string, out: (line: string) => void): number {
  const pr = prView(repo, n);
  if (!pr) throw new FactoryError(`delta-range: cannot read PR #${n} from ${repo.remote}, or it returned no head sha`, 2);
  const { headRefName: branch, headRefOid: head, isDraft } = pr;
  const dir = repo.path;
  if (!existsSync(join(dir, ".git"))) throw new FactoryError(`delta-range: no clone of ${repo.key} at ${dir}`, 2);
  const g = (...args: string[]) => run("git", ["-C", dir, ...HTTPS, ...args]);
  const val = (...args: string[]) => {
    const r = g(...args);
    return r.status === 0 ? r.stdout.trim() : "";
  };

  const fetched = g("fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`).status === 0 ||
    g("fetch", "-q", "origin").status === 0;
  const baseType = val("cat-file", "-t", claimed);
  const baseFull = val("rev-parse", "--verify", "-q", `${claimed}^{commit}`);
  const baseTree = val("log", "-1", "--format=%T", claimed);
  const headTree = val("log", "-1", "--format=%T", head);
  const reflog = splitlines(val("reflog", "show", `refs/remotes/origin/${branch}`, "--format=%H"));
  const inReflog = !!baseFull && reflog.includes(baseFull);
  const stat = g("diff", "--stat", claimed, head).stdout.trimEnd();
  const sameTree = g("diff", "--quiet", claimed, head).status === 0;
  const timeline = [...forcePushes(repo, n), head];
  const inTimeline = !!baseFull && timeline.includes(baseFull);
  // A normal fix-round push (not a force-push) leaves no timeline event, but the base is simply
  // reachable from the head.
  const ancestor = !!baseFull && baseFull !== head && g("merge-base", "--is-ancestor", baseFull, head).status === 0;

  const fails: string[] = [];
  if (!fetched) fails.push(`git fetch failed in ${dir}; the local refs may be stale, so no verdict on them is trustworthy`);
  if (baseType !== "commit") fails.push(`base ${claimed} is not a commit in ${dir} (got '${baseType || "nothing"}'). Run git fetch there.`);
  if (sameTree)
    fails.push(`EMPTY RANGE: ${claimed} and ${head} have the same tree (${baseTree}). Nothing to review. ` +
      `If the amend was message-only, the delta starts EARLIER than ${claimed}.`);
  if (!inTimeline && !inReflog && !ancestor)
    fails.push(`base ${claimed} is not a state this PR's head has ever been: not in GitHub's force-push timeline, ` +
      `not in the local reflog for origin/${branch}, not an ancestor of the head. Read a base off the timeline: ` +
      `gh api repos/${repo.remote}/issues/${n}/timeline --jq '.[] | select(.event=="head_ref_force_pushed") | [.commit_id,.created_at] | @tsv'`);
  if (!val("cat-file", "-t", head)) fails.push(`PR head ${head} is not in ${dir} -- fetch is stale or the PR points somewhere else`);

  if (fails.length) {
    out(`DO NOT DISPATCH  ${repo.remote}#${n}  ${branch}  ${claimed}..${head}`);
    fails.forEach((f, i) => out(`  ${i + 1}. ${f}`));
    return 1;
  }
  // The range shape goes on the verdict line, not only in the evidence below: a force-push leaves
  // base and head as siblings, so a tree diff is the ordinary case on a fix round, and a reader who
  // skipped the evidence line has told a reviewer the base was an ancestor when it was not.
  const shape = ancestor ? "commit range, base is an ancestor of head" : "TREE DIFF ONLY, base is NOT an ancestor of head; git log base..head shows nothing";
  const src = [inTimeline && "GitHub force-push timeline", ancestor && `ancestor of head on ${branch}`, inReflog && "local reflog"].filter(Boolean);
  out(`DISPATCHABLE  ${repo.remote}#${n}  ${branch}  ${claimed}..${head}`);
  out(`  range: ${shape}`);
  out(`  base ${baseFull} (tree ${baseTree}) -> head ${head} (tree ${headTree})`);
  out(`  base evidenced by: ${src.join(", ")}`);
  if (isDraft) out("  draft: yes");
  out("  the reviewer will see:");
  for (const l of splitlines(stat)) out(`    ${l}`);
  return 0;
}
