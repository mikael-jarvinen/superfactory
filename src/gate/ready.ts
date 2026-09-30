// `factory pr-ready <repo> <n>`: may this PR be sent to the human?
//
// Every question is asked about the PR's CURRENT HEAD SHA, and an absence is a failure, never a
// pass. A field that says nothing looks exactly like a field that says all is well, and this refuses
// to read it that way. The gate check is "at least one of the repo's gate_checks ran, and every
// check-run present is green", because workflows are commonly path-filtered.
//
// Each failure carries a kind, which is what `pr-wait` decides on: `waits` clears with time (a
// check running, a status pending, mergeability not computed), `unreadable` is a read that failed
// and may succeed on a retry, and `fatal` will not change by waiting.
import { existsSync } from "node:fs";
import type { Repo } from "../config.js";
import { allRecs, recPrs } from "../state.js";
import type { Workspace } from "../workspace.js";
import { splitlines } from "../util.js";
import { api, type CheckRun, checkRuns, gh, json, prView, statuses, Unreadable } from "./github.js";
import { MEDIA_BEGIN } from "./media.js";

export type FailureKind = "fatal" | "waits" | "unreadable";

export interface Failure {
  text: string;
  kind: FailureKind;
}

export interface Verdict {
  remote: string;
  n: number;
  head: string;
  base: string;
  failures: Failure[];
  remarks: string[];
  // The remark on comment volume, when there is one. Not blocking here; `pr-wait` stops on it.
  prose?: string;
  sendable: boolean;
}

// A ticket in one of these with this PR on its record has not finished with it.
const WORKING = new Set(["building", "fixing", "agent-review", "pr-open"]);

export const DEFAULT_PROSE_REMARK = 30;

export function ready(ws: Workspace, repo: Repo, n: number, opts: { allowDraft?: boolean } = {}): Verdict {
  const pr = prView(repo, n);
  if (!pr) throw new Unreadable(`pr-ready: cannot read PR #${n} from ${repo.remote}, or it returned no head sha`);
  const sha = pr.headRefOid;
  const base = pr.baseRefName;
  const failures: Failure[] = [];
  const remarks: string[] = [];
  const fail = (text: string, kind: FailureKind = "fatal") => failures.push({ text, kind });

  if (pr.state !== "OPEN") fail(`state is ${pr.state}, not OPEN`);
  if (pr.isDraft && !opts.allowDraft) fail("still a DRAFT -- a draft means the author knows it is incomplete");
  if (base !== repo.base) fail(`base branch is ${base}, expected ${repo.base}`);

  let unstable = false;
  const ms = `${pr.mergeable}/${pr.mergeStateStatus}`;
  if (ms === "MERGEABLE/CLEAN") {
    // nothing to say
  } else if (ms === "MERGEABLE/UNSTABLE") {
    // Deferred: GitHub says UNSTABLE for any failing check, including one the workflow allows to
    // fail. Whether that blocks depends on what the check-runs turn out to be, read below.
    unstable = true;
  } else if (ms === "MERGEABLE/BLOCKED") {
    remarks.push("mergeStateStatus BLOCKED -- branch protection wants a human approval; that is the human's and the colleagues' step, not a gate failure");
  } else if (ms === "MERGEABLE/UNKNOWN" || pr.mergeable === "UNKNOWN") {
    fail(`mergeability not computed yet (${ms}) -- ask again`, "waits");
  } else if (pr.mergeable === "CONFLICTING") {
    fail(`CONFLICTING with ${base} -- rebase`);
  } else {
    fail(`mergeable=${pr.mergeable} mergeStateStatus=${pr.mergeStateStatus}`);
  }

  const cmp = api<{ behind_by?: number }>(`repos/${repo.remote}/compare/${base}...${sha}`);
  if (typeof cmp?.behind_by !== "number") fail(`COULD NOT READ how far ${sha} is behind ${base} -- not the same thing as up to date`, "unreadable");
  else if (cmp.behind_by !== 0) fail(`${cmp.behind_by} commits behind ${base} -- rebase before sending`);

  // CHECK-RUNS AT THIS SHA. Absence is the failure this whole gate exists for.
  const runs = checkRuns(repo, sha);
  let realCheckProblem = false;
  if (runs === undefined) {
    fail(`COULD NOT READ check-runs at ${sha} -- not the same thing as there being none`, "unreadable");
    realCheckProblem = true;
  } else if (runs.length === 0) {
    fail(`NO check-runs at all at ${sha} -- this is the failure that looks like a pass`);
    realCheckProblem = true;
  } else {
    for (const c of runs) {
      if (c.status !== "completed") {
        fail(`check '${c.name}' is ${c.status}, not completed`, "waits");
        realCheckProblem = true;
        continue;
      }
      const concl = c.conclusion ?? "-";
      if (concl === "success") continue;
      if (concl === "skipped") {
        remarks.push(`check '${c.name}' was skipped (path filter or condition) -- not a pass, not a fail`);
      } else if (superseded(c, runs)) {
        remarks.push(`check '${c.name}' concluded ${concl} at ${c.started_at} -- superseded by a later success at the same sha`);
      } else if (allowedFailure(repo, c)) {
        remarks.push(`check '${c.name}' concluded ${concl} but its workflow run concluded success -- the job is continue-on-error, ` +
          "so the repo does not gate on it. Read the failure, do not ignore it; it just is not a blocker.");
      } else {
        fail(`check '${c.name}' concluded ${concl}`);
        realCheckProblem = true;
      }
    }
    // At least one of the repo's own gate jobs must have RUN. A security scanner alone tests
    // nothing of ours.
    const want = repo.gateChecks;
    if (want.length && !runs.some((c) => want.includes(c.name)))
      fail(`none of the repo's gate jobs ran at ${sha} (${want.join(",")}) -- the gate is missing, not green`);
  }
  // The deferred UNSTABLE verdict. If every failing check was superseded or allowed to fail,
  // UNSTABLE is GitHub restating that; refusing on it would refuse a PR the repo does not gate.
  if (unstable) {
    if (realCheckProblem) fail("mergeStateStatus UNSTABLE -- a check is still running or failing", "waits");
    else remarks.push("mergeStateStatus UNSTABLE -- from a check the repo does not gate on; see the check remarks above");
  }

  // COMMIT STATUSES: a separate API. Reported, not interpreted, except a green that read nothing.
  const sts = statuses(repo, sha);
  if (sts === undefined) {
    fail("COULD NOT READ commit statuses -- not the same thing as there being none", "unreadable");
  } else {
    for (const s of sts) {
      const desc = s.description ?? "-";
      if (s.state === "success") {
        if (/rate limit|skipped|no review|not run/i.test(desc)) remarks.push(`status '${s.context}' is GREEN but says: ${desc} -- a pass that read nothing`);
      } else {
        fail(`status '${s.context}' is ${s.state} -- ${desc}`, s.state === "pending" ? "waits" : "fatal");
      }
    }
  }

  // Unresolved review threads. Fails closed: an API error is not "none".
  const threads = reviewThreads(repo, n);
  if (threads === undefined) {
    fail("COULD NOT READ review threads -- not the same thing as there being none", "unreadable");
  } else {
    if (threads.more) fail("more than 100 review threads; this gate only read the first page");
    if (threads.unresolved.length) fail(`unresolved review threads: ${threads.unresolved.join(", ")}`);
  }

  // THE STATE STORE. If a ticket still has this PR in a working state, the lead has not finished.
  if (!existsSync(ws.stateDir)) {
    fail(`COULD NOT READ the state store at ${ws.stateDir} -- cannot say nothing is outstanding`);
  } else {
    try {
      for (const r of allRecs(ws))
        if (r.state && WORKING.has(r.state) && recPrs(r).some((p) => p.repo === repo.remote && p.number === n))
          fail(`state store says work is still open against #${n} -- ${r.ticket} is ${r.state} (agent ${r.agent ?? "none"})`);
    } catch {
      fail("COULD NOT PARSE the state store -- cannot say nothing is outstanding");
    }
  }

  // PROSE VOLUME. Measured, not blocking.
  let prose: string | undefined;
  const diff = gh("pr", "diff", String(n), "--repo", repo.remote);
  if (diff.status !== 0) {
    prose = "could not read the diff to measure prose -- check comment volume by hand";
  } else {
    const { prose: p, code: c } = proseLines(diff.stdout);
    const volume = ws.config.gate.proseRemark ?? DEFAULT_PROSE_REMARK;
    // Two triggers. The crossover alone cannot see a PR that is comment-heavy and large, where
    // prose never exceeds code; the volume trigger catches that one. The crossover floor is two
    // thirds of the volume trigger, which is 20 at the default of 30.
    if (p >= Math.ceil((volume * 2) / 3) && p > c) prose = `${p} added prose/comment lines against ${c} of code -- check the comment volume`;
    else if (p >= volume) prose = `${p} added prose/comment lines (against ${c} of code), at or over [gate] prose_remark = ${volume}`;
  }
  if (prose) remarks.push(prose);

  // MEDIA. A PR that changes what the app shows carries screenshots; one that does not says so.
  if (!(pr.body ?? "").includes(MEDIA_BEGIN))
    remarks.push("no demo section in the PR body: `factory pr-media` adds screenshots, or --no-visual-change writes the sentence");

  return { remote: repo.remote, n, head: sha, base, failures, remarks, prose, sendable: failures.length === 0 };
}

function superseded(c: CheckRun, runs: CheckRun[]): boolean {
  return runs.some((o) => o.name === c.name && o.conclusion === "success" && (o.started_at ?? "") > (c.started_at ?? ""));
}

// A job the workflow marks continue-on-error fails while its run still concludes success. That is
// the repo saying out loud that the job does not gate. The signal is the disagreement: check-run
// failed, parent workflow run succeeded.
function allowedFailure(repo: Repo, c: CheckRun): boolean {
  const m = /\/actions\/runs\/(\d+)/.exec(c.details_url ?? "");
  if (!m) return false;
  return api<{ conclusion?: string }>(`repos/${repo.remote}/actions/runs/${m[1]}`)?.conclusion === "success";
}

interface Threads {
  more: boolean;
  unresolved: string[];
}

function reviewThreads(repo: Repo, n: number): Threads | undefined {
  const [owner, name] = repo.remote.split("/");
  const query = `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${n}){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved path line}}}}}`;
  type Node = { isResolved: boolean; path: string; line: number | null };
  const d = json<{ data?: { repository?: { pullRequest?: { reviewThreads?: { pageInfo: { hasNextPage: boolean }; nodes: Node[] } } } } }>(
    gh("api", "graphql", "-f", `query=${query}`),
  );
  const t = d?.data?.repository?.pullRequest?.reviewThreads;
  if (!t || !Array.isArray(t.nodes)) return undefined;
  return { more: !!t.pageInfo?.hasNextPage, unresolved: t.nodes.filter((x) => !x.isResolved).map((x) => `${x.path}:${x.line ?? "?"}`) };
}

// Added lines of a unified diff, split into prose (comments, and anything in a .md file) and code.
// A block comment's continuation lines carry no marker, so the block is tracked: counting only its
// opening line undercounts exactly the shape that gets a PR rejected, the essay. `{/*` is JSX.
export function proseLines(diff: string): { prose: number; code: number } {
  let prose = 0;
  let code = 0;
  let md = false;
  let inBlock = false;
  for (const raw of splitlines(diff)) {
    if (raw.startsWith("+++ ")) {
      md = raw.endsWith(".md");
      inBlock = false;
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const line = raw.slice(1);
    if (/^\s*$/.test(line)) continue;
    let isProse = false;
    if (md) isProse = true;
    else if (inBlock) {
      isProse = true;
      if (line.includes("*/")) inBlock = false;
    } else if (/^\s*(\/\*|\/\/|#|\*|\{\/\*)/.test(line)) {
      isProse = true;
      if (/^\s*(\/\*|\{\/\*)/.test(line) && !line.includes("*/")) inBlock = true;
    }
    if (isProse) prose++;
    else code++;
  }
  return { prose, code };
}

export function report(v: Verdict): string[] {
  const lines = [`PR ${v.remote}#${v.n}  head ${v.head}  base ${v.base}`];
  if (v.remarks.length) {
    lines.push("REMARKS (not blocking):");
    for (const r of v.remarks) lines.push(`  - ${r}`);
  }
  if (v.sendable) {
    lines.push("SENDABLE -- every check green at this head, no unresolved threads, nothing outstanding.");
  } else {
    lines.push("NOT SENDABLE:");
    v.failures.forEach((f, i) => lines.push(`  ${i + 1}. ${f.text}`));
  }
  return lines;
}
