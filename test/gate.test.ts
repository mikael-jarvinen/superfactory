import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { beforeSha, demoEnv } from "../src/gate/demo.js";
import { BEFORE_BEGIN, BEFORE_END, MEDIA_BEGIN, MEDIA_END, STAMP } from "../src/gate/media.js";
import { proseLines } from "../src/gate/ready.js";
import { loadRec, saveRec } from "../src/state.js";
import { openWorkspace } from "../src/workspace.js";
import { git } from "../src/worktree.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

const FAKE = fileURLToPath(new URL("./fake-gh.js", import.meta.url));
const REMOTE = "acme/web";
const N = 7;
const HEAD = "a".repeat(40);
const PR_FIELDS = "headRefOid,headRefName,state,isDraft,mergeable,mergeStateStatus,baseRefName,url,title,body";
// What CodeRabbit's own review says; each of its replies in a review thread is a review with no body.
const REVIEW_BODY = "**Actionable comments posted: 1**";
const BODY = "Why it changed.\n\n<!-- pr-media:begin -->\n## Demo\nNo visual change.\n<!-- pr-media:end -->\n";

const check = (name: string, o: Record<string, unknown> = {}) => ({
  name, status: "completed", conclusion: "success", started_at: "2026-01-01T10:00:00Z", details_url: "https://github.com/acme/web/actions/runs/100/job/1", ...o,
});
const checkRuns = (...runs: unknown[]) => ({ stdout: { total_count: runs.length, check_runs: runs } });
const diffOf = (prose: number, code: number) =>
  ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@",
    ...Array.from({ length: prose }, (_, i) => `+// note ${i}`), ...Array.from({ length: code }, (_, i) => `+const x${i} = ${i};`)].join("\n") + "\n";

type Routes = Record<string, unknown>;

function green(over: Routes = {}, head = HEAD, draft = true): Routes {
  const pr = {
    headRefOid: head, headRefName: "feature", state: "OPEN", isDraft: draft, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    baseRefName: "main", url: `https://github.com/${REMOTE}/pull/${N}`, title: "Fix the thing", body: BODY,
  };
  return {
    [`pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`]: { stdout: pr },
    [`pr view ${N} --repo ${REMOTE} --json headRefOid`]: { stdout: { headRefOid: head } },
    [`api repos/${REMOTE}/compare/main...${head}`]: { stdout: { behind_by: 0 } },
    [`api repos/${REMOTE}/commits/${head}/check-runs?per_page=100&page=1`]: checkRuns(check("test"), check("scanner")),
    [`api repos/${REMOTE}/commits/${head}/status`]: { stdout: { statuses: [{ context: "review-bot", state: "success", description: "Review completed" }] } },
    "api graphql": { stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true, path: "src/a.ts", line: 3 }] } } } } } },
    [`api repos/${REMOTE}/pulls/${N}/comments?per_page=100&page=1`]: { stdout: [] },
    [`api repos/${REMOTE}/pulls/${N}/commits?per_page=100&page=1`]: { stdout: [{ sha: head }] },
    [`pr diff ${N} --repo ${REMOTE}`]: { stdout: diffOf(2, 20) },
    [`pr ready ${N} --repo ${REMOTE}`]: { stdout: "" },
    ...over,
  };
}

// A workspace whose gh is the fake, with a record for the PR that is past its working states.
function gateWorkspace(gate = "", toml = TOML, bots = ["coderabbitai", "Copilot"]) {
  const ws = tempWorkspace(`${toml}\n[github]\nbots = ${JSON.stringify(bots)}\n\n[gate]\nprose_remark = 30\n${gate}`);
  after(() => rmSync(ws, { recursive: true, force: true }));
  const gh = join(ws, "bin", "gh");
  writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(gh, 0o755);
  const routes = join(ws, "routes.json");
  const log = join(ws, "gh.log");
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: `${join(ws, "bin")}:${process.env.PATH}`, GH_BIN: "", FAKE_GH_ROUTES: routes, FAKE_GH_LOG: log,
    FACTORY_SEND_DELAY: "0", FACTORY_SEND_POLL: "0", FACTORY_WAIT_POLL: "0", ...extra,
  });
  for (const [to, ...rest] of [["building"], ["pr-open", "--pr", `${REMOTE}#${N}`, "--head", HEAD], ["agent-review"], ["gate"]] as string[][])
    assert.equal(factory(ws, ["state", "WEB-1", to as string, ...rest]).status, 0);
  const run = (r: Routes, args: string[], extra: NodeJS.ProcessEnv = {}) => {
    writeFileSync(routes, JSON.stringify(r));
    rmSync(`${routes}.counts`, { force: true });
    writeFileSync(log, "");
    const res = factory(ws, args, { env: env(extra) });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as string[]).join(" "));
    return { ...res, calls };
  };
  return { ws, run };
}

test("pr-ready asks about the head sha, and a missing answer is a failure", () => {
  const { run } = gateWorkspace();
  const ready = (r: Routes) => run(r, ["pr-ready", "web", String(N)]);

  let r = run(green(), ["pr-ready", REMOTE, String(N)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SENDABLE/m);
  assert.ok(r.calls.includes(`api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`), "check-runs are read at the head sha");

  // A draft is no failure: every PR is one until its item reaches undrafting(ws).
  r = ready(green());
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /DRAFT/);

  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const cases: [Routes, RegExp][] = [
    [{ [cr]: { status: 1, stderr: "HTTP 502" } }, /COULD NOT READ check-runs/],
    [{ [cr]: checkRuns() }, /NO check-runs at all/],
    [{ [cr]: checkRuns(check("scanner")) }, /none of the repo's gate jobs ran/],
    [{ [`api repos/${REMOTE}/commits/${HEAD}/status`]: { status: 1 } }, /COULD NOT READ commit statuses/],
    [{ "api graphql": { status: 1 } }, /COULD NOT READ review threads/],
  ];
  for (const [over, why] of cases) {
    r = run(green(over), ["pr-ready", "web", String(N)]);
    assert.equal(r.status, 1, `${why}: ${r.stdout}`);
    assert.match(r.stdout, why);
  }

  // A failed job whose workflow run concluded success is continue-on-error: a remark, not a blocker.
  r = run(green({
    [cr]: checkRuns(check("test"), check("experimental", { conclusion: "failure" })),
    [`api repos/${REMOTE}/actions/runs/100`]: { stdout: { conclusion: "success" } },
  }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /check 'experimental' concluded failure but its workflow run concluded success/);

  // Behind the base is a remark: the human rebases before merging.
  r = run(green({ [`api repos/${REMOTE}/compare/main...${HEAD}`]: { stdout: { behind_by: 3 } } }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /3 commits behind main -- rebase before merging/);

  // So is a base whose branch protection wants it up to date, which GitHub reports as BEHIND.
  const behind = green({ [`api repos/${REMOTE}/compare/main...${HEAD}`]: { stdout: { behind_by: 2 } } });
  const behindKey = `pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`;
  behind[behindKey] = { stdout: { ...(behind[behindKey] as { stdout: object }).stdout, mergeStateStatus: "BEHIND" } };
  r = run(behind, ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /2 commits behind main -- rebase before merging/);
});

test("prose counts every line of a block comment, and every added line of markdown", () => {
  const diff = [
    "+++ b/src/a.ts",
    "+/*",
    "+ the essay goes on",
    "+ and on",
    "+ */",
    "+const a = 1;",
    "+",
    "+{/* a jsx note */}",
    "+++ b/README.md",
    "+Plain words.",
  ].join("\n");
  assert.deepEqual(proseLines(diff), { prose: 6, code: 1 });
});

test("pr-wait waits on a running check, then stops before sending on prose volume", () => {
  const { run } = gateWorkspace();
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const prKey = `pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`;
  const over = {
    [cr]: [checkRuns(check("test", { status: "in_progress", conclusion: null })), checkRuns(check("test"))],
    [`pr diff ${N} --repo ${REMOTE}`]: { stdout: diffOf(35, 60) },
  };
  let r = run(green(over), ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /waiting \(\d+s\) on: check 'test' is in_progress, not completed/);
  assert.match(r.stderr, /gate is green but not sending:\n {2}- 35 added prose\/comment lines/);
  assert.equal(r.calls.filter((c) => c === cr).length, 2, "read again after waiting");

  // The draft is sent as a draft: nothing undrafts it on the way.
  r = run(green(over), ["pr-wait", "web", String(N), HEAD], { FACTORY_ACCEPT_PROSE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^push text: PR ready: WEB-1 web#7$/m);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [], "left a draft");

  // No check-runs yet may be GitHub not having created them: waited on, and named at the limit.
  r = run(green({ [cr]: checkRuns() }), ["pr-wait", "web", String(N), HEAD], { FACTORY_WAIT_LIMIT: "0" });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /still waiting after \d+s on:\n {2}- NO check-runs at all/);

  // A conflict with the base is not something time clears.
  const conflicting = green();
  conflicting[prKey] = { stdout: { ...(conflicting[prKey] as { stdout: object }).stdout, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } };
  r = run(conflicting, ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /waiting will not clear it:\n {2}- CONFLICTING with main/);
  assert.equal(r.calls.filter((c) => c === cr).length, 1);
});

// A PR is a draft until its item reaches undrafting(ws). pr-send gates it as it is, checks the
// head is the reviewed sha before and after, and opens nothing.
test("pr-send gates the PR as it is and refuses a head that is not the reviewed sha", () => {
  const { run } = gateWorkspace();
  let r = run(green(), ["pr-send", "web", String(N), "b".repeat(40)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not the reviewed sha/);

  r = run(green(), ["pr-send", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SENDABLE {2}acme\/web#7/m);

  r = run(green({ [`pr view ${N} --repo ${REMOTE} --json headRefOid`]: [{ stdout: { headRefOid: HEAD } }, { stdout: { headRefOid: "c".repeat(40) } }] }),
    ["pr-send", "web", String(N), HEAD.slice(0, 12)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /head moved from a+ to c+ after the gate passed/);

  // already open, as in a fix round after colleague review: gated the same way, left open
  r = run(green({}, HEAD, false), ["pr-send", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.startsWith("pr ready")), "pr-send never opens or drafts a PR");
});

// pr-wait can see a PR green and pr-send's own read, a moment later, meet mergeability being
// recomputed after a merge into the base.
test("pr-send's gate read waits out what time clears, and stops at once on what it does not", () => {
  const { run } = gateWorkspace();
  const prKey = `pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`;
  const draft = green();
  const pr = (draft[prKey] as { stdout: object }).stdout;
  const as = (over: object) => ({ stdout: { ...pr, ...over } });
  const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };

  let r = run({ ...draft, [prKey]: [as(unknown), as({})] }, ["pr-send", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SENDABLE {2}acme\/web#7/m);
  assert.equal(r.calls.filter((c) => c === prKey).length, 3, "read again, then once for the link");

  r = run({ ...draft, [prKey]: [as({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })] }, ["pr-send", "web", String(N), HEAD]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pr-ready did not pass/);
  assert.equal(r.calls.filter((c) => c === prKey).length, 1, "a conflict is not waited on");

  r = run({ ...draft, [prKey]: [as(unknown)] }, ["pr-send", "web", String(N), HEAD], { FACTORY_SEND_LIMIT: "0" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /mergeability not computed yet/);
});

// Every PR is a draft until its item reaches undrafting(ws), and CodeRabbit skips drafts with a green status. With
// no review bot required, that is only named, and the remark says to ask it by hand, as pr-wait asks only a
// review_bot whose trigger it knows.
test("a review bot that skipped the draft is named as having reviewed nothing", () => {
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  // with a review_bot set, it has reviewed the head, so the PR is sendable and only remarked on
  const skipped = (context: string, bot?: string) => green({
    [st]: { stdout: { statuses: [{ context, state: "success", description: "Review skipped: draft pull request" }] } },
    ...(bot ? { [rv]: { stdout: [{ user: { login: `${bot}[bot]` }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY }] } } : {}),
  });
  let r = gateWorkspace().run(skipped("CodeRabbit"), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /status 'CodeRabbit' is green only because it skipped a draft and reviewed nothing -- ask it for a review by hand; no \[gate\] review_bot is set, so `factory pr-wait` asks no bot/);
  // a review_bot set, and this is another bot: pr-wait would ask the review_bot, not this one
  r = gateWorkspace('review_bot = "coderabbitai"\n').run(skipped("OtherBot", "coderabbitai"), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /status 'OtherBot' is green only because it skipped a draft and reviewed nothing -- ask it for a review by hand; `factory pr-wait` asks only the review_bot, coderabbitai/);
  // a review_bot pr-wait knows no trigger for: pr-wait asks nobody
  r = gateWorkspace('review_bot = "sourcery"\n').run(skipped("OtherBot", "sourcery"), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /status 'OtherBot' is green only because it skipped a draft and reviewed nothing -- ask it for a review by hand; `factory pr-wait` asks no bot, as it knows no trigger for the review_bot, sourcery/);
});

// The head commit, the PR's comments since it (one reply per read), and posting the trigger.
const POST = `pr comment ${N} --repo ${REMOTE} --body @coderabbitai review`;
const TRIGGER = { body: "@coderabbitai review", created_at: "2026-01-01T10:01:00Z" };
const asking = (...reads: unknown[][]): Routes => ({
  [`api repos/${REMOTE}/commits/${HEAD}`]: { stdout: { commit: { committer: { date: "2026-01-01T09:59:00Z" } } } },
  [`api repos/${REMOTE}/issues/${N}/comments`]: reads.map((stdout) => ({ stdout })),
  [POST]: { stdout: `https://github.com/${REMOTE}/pull/${N}#issuecomment-1\n` },
});

// CodeRabbit reviews a PR before it reaches the human, unless it is rate limited or reviewed an
// earlier head (below). The statuses are CodeRabbit's own, as it posts them on real PRs.
test("a required review bot must have reviewed the head: pr-ready refuses, pr-wait waits while it reviews", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const rabbit = (state: string, description: string) => ({ stdout: { statuses: [{ context: "CodeRabbit", state, description, created_at: "2026-01-01T10:00:10Z" }] } });
  const review = (commit: string) => ({ user: { login: "coderabbitai[bot]" }, commit_id: commit, state: "COMMENTED", body: REVIEW_BODY });
  const ready = (over: Routes, env: NodeJS.ProcessEnv = {}) => run(green(over), ["pr-ready", "web", String(N)], env);
  const ASK = /-- run `factory pr-wait`, which asks it once; never post the trigger by hand/;

  let r = ready({ [st]: rabbit("success", "Review completed") });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.calls.includes(rv), "a completed review at this head needs nothing more");

  for (const desc of ["Review skipped: draft pull request"]) {
    r = ready({ [st]: rabbit("success", desc), [rv]: { stdout: [] } });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`CodeRabbit has not reviewed aaaaaaa: its status here says "${desc}"`));
    assert.match(r.stdout, ASK);
    assert.doesNotMatch(r.stdout, /green only because/, "the failure replaces the remark");
  }

  // a review it left at this head counts, whatever its status went on to say
  r = ready({ [st]: rabbit("success", "Review skipped: draft pull request"), [rv]: { stdout: [review(HEAD)] } });
  assert.equal(r.status, 0, r.stdout);
  r = ready({ [st]: rabbit("success", "Review skipped: draft pull request"), [rv]: { status: 1 } });
  assert.match(r.stdout, /COULD NOT READ the reviews of #7/);

  // nothing from it at all: waited out right after the push, refused once its checks are old
  r = ready({ [st]: { stdout: { statuses: [] } }, [rv]: { stdout: [] } });
  assert.match(r.stdout, /CodeRabbit has not reviewed aaaaaaa: it has posted nothing at this head/);
  const fresh = new Date().toISOString();
  r = ready({ [st]: { stdout: { statuses: [] } }, [rv]: { stdout: [] }, [cr]: checkRuns(check("test", { started_at: fresh })) });
  assert.match(r.stdout, /CodeRabbit has posted nothing at aaaaaaa yet, \d+s after its first check -- waiting up to 600s/);

  // pr-wait waits while it reviews, then sends
  r = run(green({ [st]: [rabbit("pending", "Review in progress"), rabbit("success", "Review completed")] }), ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /waiting \(\d+s\) on: CodeRabbit is reviewing aaaaaaa \(Review in progress\)/);
  assert.equal(r.calls.filter((c) => c === st).length, 3, "read while waiting, then by pr-send's own gate");

  // and on a head it skipped asks for the review itself, then waits for it
  r = run(green({ [st]: rabbit("success", "Review skipped: draft pull request"), [rv]: { stdout: [] }, ...asking([]) }), ["pr-wait", "web", String(N), HEAD], { FACTORY_WAIT_LIMIT: "0" });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 1);
  assert.match(r.stderr, /still waiting after \d+s on:\n {2}- CodeRabbit has not reviewed aaaaaaa/);
});

// CodeRabbit's account limit is one review an hour, kept for the first version of each PR; later
// versions go without it.
test("a review bot that reviewed an earlier head of the PR lets later heads pass, said as a remark", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const OLD = "b".repeat(40);
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cm = `api repos/${REMOTE}/pulls/${N}/comments?per_page=100&page=1`;
  const commits = `api repos/${REMOTE}/pulls/${N}/commits?per_page=100&page=1`;
  const skippedHere = { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review skipped: draft pull request" }] } };
  const ready = (over: Routes) => run(green({ [st]: skippedHere, [rv]: { stdout: [] }, ...over }), ["pr-ready", "web", String(N)]);
  const EARLIER = /CodeRabbit reviewed an earlier head, bbbbbbb, not aaaaaaa; later versions go without its review/;

  // never reviewed: refused, with the ask to review
  const oldStatus = `api repos/${REMOTE}/commits/${OLD}/status`;
  const oldRuns = `api repos/${REMOTE}/commits/${OLD}/check-runs?per_page=100&page=1`;
  const oldPulls = `api repos/${REMOTE}/commits/${OLD}/pulls?per_page=100&page=1`;
  const onlyThisPr = { [oldPulls]: { stdout: [{ number: N }] } };
  let r = ready({ [commits]: { stdout: [{ sha: OLD }, { sha: HEAD }] }, [oldStatus]: { stdout: { statuses: [] } }, [oldRuns]: checkRuns() });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /CodeRabbit has not reviewed aaaaaaa: its status here says "Review skipped: draft pull request" -- run `factory pr-wait`, which asks it once; never post the trigger by hand/);

  // reviewed an earlier head, by a review, by an inline comment of its own, or by its finished
  // check-run there, which GitHub ties to this PR: a rebase it had already reviewed
  const ours = { pull_requests: [{ number: N }] };
  const evidence: Routes[] = [
    { [rv]: { stdout: [{ user: { login: "coderabbitai[bot]" }, commit_id: OLD, state: "COMMENTED", body: REVIEW_BODY }] } },
    { [cm]: { stdout: [{ user: { login: "coderabbitai[bot]" }, original_commit_id: OLD, in_reply_to_id: null }] } },
    { [commits]: { stdout: [{ sha: OLD }, { sha: HEAD }] }, ...onlyThisPr, [oldStatus]: { stdout: { statuses: [] } },
      [oldRuns]: checkRuns(check("test"), rabbitRun("Review completed", { conclusion: "success", ...ours })) },
    // a clean incremental pass leaves no review, no comment and no status, only its check-run
    // titled Finished, where GitHub ties the run to the open PR. It posts no commit status for such
    // a pass, on any commit of a PR, so a status is not read for it
    { [commits]: { stdout: [{ sha: OLD }, { sha: HEAD }] }, ...onlyThisPr, [oldStatus]: { stdout: { statuses: [] } },
      [oldRuns]: checkRuns(check("test"), rabbitRun("Finished", { conclusion: "success", ...ours })) },
  ];
  for (const over of evidence) {
    r = ready(over);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, EARLIER);
    assert.match(r.stdout, /^SENDABLE/m);
  }

  // a check-run on a commit another PR also has is that PR's review: a stacked PR carries its lower
  // PR's commits
  r = ready({ ...evidence[2], [oldPulls]: { stdout: [{ number: N - 1 }, { number: N }] } });
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /earlier head/);
  // A closed, unmerged PR's review stays on its commits, and GitHub lists only open and merged PRs
  // for a commit, so a commit of this PR's that only this PR is listed for may carry that one's
  // review. Its status names no PR, and its check-run names the closed PR, or none: neither is this
  // PR's review.
  const closed = { pull_requests: [{ number: N - 5 }] };
  const retained: [string, Routes][] = [
    ["a status", { ...evidence[2], [oldRuns]: checkRuns(check("test")),
      [oldStatus]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review completed" }] } } }],
    ["a check-run tied to the closed PR", { ...evidence[2], [oldRuns]: checkRuns(rabbitRun("Review completed", { conclusion: "success", ...closed })) }],
    ["a check-run tied to no PR", { ...evidence[2], [oldRuns]: checkRuns(rabbitRun("Review completed", { conclusion: "success", pull_requests: [] })) }],
    ["a check-run with no PRs read", { ...evidence[2], [oldRuns]: checkRuns(rabbitRun("Review completed", { conclusion: "success" })) }],
  ];
  for (const [name, over] of retained) {
    r = ready(over);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /earlier head/, name);
    assert.match(r.stdout, /CodeRabbit has not reviewed aaaaaaa/, name);
  }
  // a skipped or unfinished check-run there is no review
  for (const run of [rabbitRun("Review skipped", { conclusion: "skipped", ...ours }), rabbitRun("Review completed", { status: "in_progress", conclusion: null, ...ours }), rabbitRun("Review completed", ours)]) {
    r = ready({ ...evidence[2], [oldRuns]: checkRuns(run) });
    assert.equal(r.status, 1, r.stdout);
  }
  // the PRs of the commit unreadable: not a pass
  r = ready({ ...evidence[2], [oldPulls]: { status: 1 } });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /COULD NOT READ the PRs of commit bbbbbbb/);

  // its reply in a thread on an older head is not a review of it
  r = ready({ [cm]: { stdout: [{ user: { login: "coderabbitai[bot]" }, original_commit_id: OLD, in_reply_to_id: 11 }] } });
  assert.equal(r.status, 1, r.stdout);

  // its unresolved threads still block
  r = ready({ ...evidence[0], "api graphql": { stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false, path: "src/a.ts", line: 3 }] } } } } } } });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /unresolved review threads: src\/a.ts:3/);

  // a review of this head passes with no remark about an earlier one
  r = ready({ [rv]: { stdout: [{ user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY }] } });
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /earlier head/);

  // a review in progress at this head is still waited out
  r = run(green({ [st]: [{ stdout: { statuses: [{ context: "CodeRabbit", state: "pending", description: "Review in progress" }] } },
    { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review completed" }] } }], ...evidence[0] }), ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /waiting \(\d+s\) on: CodeRabbit is reviewing aaaaaaa \(Review in progress\)/);
});

// CodeRabbit skips drafts, so the gate asks for the review itself. Its check-runs are its own, as
// it posts them on real PRs.
test("pr-wait asks a review bot that skipped the head, once, and waits for it", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const skipped = (title: string) => checkRuns(check("test"), rabbitRun(title, { conclusion: "skipped" }));
  const review = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY };
  const wait = (over: Routes) => run(green({ [st]: { stdout: { statuses: [] } }, ...over }), ["pr-wait", "web", String(N), HEAD]);

  // it skipped: asked once, then its review lands and the PR is sent
  let r = wait({ [cr]: skipped("Review skipped"), [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [review] }], ...asking([], [TRIGGER]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 1, "asked once, not on every poll");
  assert.match(r.stderr, /posted "@coderabbitai review" to ask for a review of aaaaaaa/);
  assert.match(r.stdout, /^SENDABLE/m);

  // asked, and then rate limited: sent with the remark, asked only the once
  const limited = checkRuns(check("test"), rabbitRun("Review skipped", { conclusion: "skipped" }), rabbitRun("Review rate limited", { started_at: "2026-01-01T10:05:00Z" }));
  r = wait({ [cr]: [skipped("Review skipped"), limited], [rv]: { stdout: [] }, ...asking([], [TRIGGER]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 1);
  assert.ok(r.stdout.includes("CodeRabbit is rate limited and has not reviewed aaaaaaa; sent without its review"), r.stdout);

  // a second run at the same head finds the ask already made and does not post it again
  r = wait({ [cr]: skipped("Review paused"), [rv]: [{ stdout: [] }, { stdout: [review] }], ...asking([TRIGGER]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 0);
  // an ask from before the head was pushed was for another head
  r = wait({ [cr]: skipped("Review paused"), [rv]: [{ stdout: [] }, { stdout: [review] }], ...asking([{ ...TRIGGER, created_at: "2026-01-01T09:00:00Z" }]) });
  assert.equal(r.calls.filter((c) => c === POST).length, 1);
});

// After the ask CodeRabbit's skipped check-run is gone and the grace since the head's first check
// can be long past; pr-wait must not refuse minutes before the review comes.
test("pr-wait waits on a review bot it asked, timed from the ask, not the head", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const review = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY };
  const over = (...comments: unknown[][]) => green({
    [st]: { stdout: { statuses: [] } },
    [cr]: [checkRuns(check("test"), rabbitRun("Review skipped", { conclusion: "skipped" })), checkRuns(check("test"))],
    [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [review] }],
    ...asking(...comments),
  });

  // skipped, asked; then nothing from it at all, long after the first check; then its review lands
  let r = run(over([], [{ ...TRIGGER, created_at: new Date().toISOString() }]), ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 1);
  assert.match(r.stderr, /waiting \(\d+s\) on: CodeRabbit has not reviewed aaaaaaa: it has posted nothing at this head/);
  assert.match(r.stdout, /^SENDABLE/m);

  // asked longer ago than the grace: refused
  r = run(over([TRIGGER]), ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 0);
  assert.match(r.stderr, /waiting will not clear it:\n {2}- CodeRabbit has not reviewed aaaaaaa: it has posted nothing at this head/);
});

// CodeRabbit's check-run can go in_progress within a minute of the ask and still be running when
// the grace from the ask runs out. A bot whose check is running is reviewing, whatever the clock
// says.
test("pr-wait waits on a review bot whose check is still running, past the grace from the ask", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const review = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY };
  const reviewing = checkRuns(check("test"), rabbitRun("Review in progress", { status: "in_progress", conclusion: null, started_at: "2026-01-01T10:01:41Z" }));
  const r = run(green({
    [st]: { stdout: { statuses: [] } },
    [cr]: [checkRuns(check("test"), rabbitRun("Review skipped: draft pull request", { conclusion: "skipped" })), reviewing, reviewing,
      checkRuns(check("test"), rabbitRun("Review completed", { conclusion: "success", started_at: "2026-01-01T10:01:41Z" }))],
    [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [] }, { stdout: [review] }],
    // the ask, long older than the grace by the time the bot is still reviewing
    ...asking([], [TRIGGER]),
  }), ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 1);
  assert.match(r.stderr, /waiting \(\d+s\) on: check 'CodeRabbit' is in_progress, not completed; CodeRabbit is reviewing aaaaaaa \(its check here is in_progress: Review in progress\)/);
  assert.doesNotMatch(r.stderr, /posted nothing|will not clear/);
  assert.match(r.stdout, /^SENDABLE/m);
});

// The check-run is CodeRabbit's own, as it posts it on a real PR: neutral, titled "Review rate
// limited".
const rabbitRun = (title: string, o: Record<string, unknown> = {}) =>
  check("CodeRabbit", { conclusion: "neutral", output: { title }, app: { slug: "coderabbitai" }, details_url: null, ...o });

// A rate limit is a remark, not a wait: tasks do not queue on the gate behind CodeRabbit's limit.
test("a rate-limited review bot lets the PR go without its review, said as a remark", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const REMARK = "CodeRabbit is rate limited and has not reviewed aaaaaaa; sent without its review";
  const limited = { [st]: { stdout: { statuses: [] } }, [rv]: { stdout: [] }, [cr]: checkRuns(check("test"), rabbitRun("Review rate limited")) };

  let r = run(green(limited), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, new RegExp(`REMARKS \\(not blocking\\):[\\s\\S]*- ${REMARK}`));
  assert.doesNotMatch(r.stdout, /check 'CodeRabbit' concluded neutral/);

  r = run(green({ [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review rate limited" }] } }, [rv]: { stdout: [] } }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes(REMARK), "its status alone says it too");

  // the waiver needs no history: a failed read of the PR's comments or commits does not hold it back
  for (const broken of [`api repos/${REMOTE}/pulls/${N}/comments?per_page=100&page=1`, `api repos/${REMOTE}/pulls/${N}/commits?per_page=100&page=1`]) {
    r = run(green({ ...limited, [broken]: { status: 1 } }), ["pr-ready", "web", String(N)]);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.stdout.includes(REMARK), r.stdout);
  }

  r = run(green(limited), ["pr-send", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(REMARK), `pr-send shows the remark:\n${r.stdout}`);

  // pr-wait does not wait on it, and does not ask it
  r = run(green({ ...limited, ...asking([]) }), ["pr-wait", "web", String(N), HEAD], { FACTORY_WAIT_LIMIT: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 0);
  assert.match(r.stdout, /^SENDABLE/m);
  assert.ok(r.stdout.includes(REMARK), r.stdout);

  // an older rate limit under a later run still in progress is waited out, not sent
  r = run(green({ ...limited, [cr]: checkRuns(check("test"), rabbitRun("Review rate limited"), rabbitRun("Review in progress", { status: "in_progress", conclusion: null, started_at: "2026-01-01T10:05:00Z" })) }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /check 'CodeRabbit' is in_progress, not completed/);
});

// Its replies in review threads are review objects at the head's sha, and the gate does not read
// them as its review of the head.
test("a review bot's replies in review threads are not its review of the head", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const reply = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: "" };
  const over = (reviews: unknown[], title: string, o: Record<string, unknown> = {}) => green({
    [`api repos/${REMOTE}/commits/${HEAD}/status`]: { stdout: { statuses: [] } },
    [`api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`]: { stdout: reviews },
    [`api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`]: checkRuns(check("test"), rabbitRun(title, o)),
  });
  let r = run(over([reply, reply], "Review skipped", { conclusion: "skipped" }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /CodeRabbit has not reviewed aaaaaaa: its check here says "Review skipped"/);

  r = run(over([reply, { ...reply, body: REVIEW_BODY }], "Review skipped", { conclusion: "skipped" }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);

  // rate limited with only replies: still said to have reviewed nothing
  r = run(over([reply, reply], "Review rate limited"), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes("CodeRabbit is rate limited and has not reviewed aaaaaaa; sent without its review"), r.stdout);
});

// After a rebase CodeRabbit says "Already reviewed the last commit", finishes its check-run green,
// and sets no status and no review object.
test("a review bot's own finished check-run at the head counts as its review", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  for (const title of ["Finished", "Review completed"]) {
    const r = run(green({ [st]: { stdout: { statuses: [] } }, [rv]: { stdout: [] }, [cr]: checkRuns(check("test"), rabbitRun(title, { conclusion: "success" })) }), ["pr-ready", "web", String(N)]);
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /CodeRabbit/, `${title}: nothing to say about it`);
    assert.ok(!r.calls.includes(rv), "its finished run needs no review object");
  }
  // its own status still speaks first: a skipped draft refuses whatever the run says
  const r = run(green({
    [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review skipped: draft pull request" }] } },
    [rv]: { stdout: [] }, [cr]: checkRuns(check("test"), rabbitRun("Finished", { conclusion: "success" })),
  }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /CodeRabbit has not reviewed aaaaaaa: its status here says "Review skipped: draft pull request"/);
});

test("a review bot that skipped the draft still refuses the PR, its neutral check-run included", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const r = run(green({
    [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review skipped: draft pull request" }] } },
    [`api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`]: { stdout: [] },
    [`api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`]: checkRuns(check("test"), rabbitRun("Review skipped")),
  }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /check 'CodeRabbit' concluded neutral/);
  assert.match(r.stdout, /CodeRabbit has not reviewed aaaaaaa: its status here says "Review skipped: draft pull request" -- run `factory pr-wait`, which asks it once; never post the trigger by hand/);
  assert.doesNotMatch(r.stdout, /rate limited/);
});

// pr-wait does not refuse a PR whose gate jobs have simply not started yet.
test("gate jobs that have not started yet are waited on for a while after the push", () => {
  const { run } = gateWorkspace();
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const fresh = new Date().toISOString();
  const r = run(green({ [cr]: [checkRuns(check("scanner", { started_at: fresh })), checkRuns(check("scanner", { started_at: fresh }), check("test"))] }),
    ["pr-wait", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /waiting \(\d+s\) on: none of the repo's gate jobs has started at a+ yet \(test\), \d+s after its first check -- waiting up to 600s/);
  const late = run(green({ [cr]: checkRuns(check("scanner", { started_at: fresh })) }), ["pr-ready", "web", String(N)], { FACTORY_GATE_GRACE: "0" });
  assert.match(late.stdout, /none of the repo's gate jobs ran at a+ \(test\) -- the gate is missing, not green/);
});

// With colleague review on, pr-open-for-review is where a PR leaves draft.
test("pr-open-for-review opens the item's PRs at the reviewed sha, then records colleague review", () => {
  const { ws, run } = gateWorkspace();
  const stateOf = () => /"state": "([a-z-]+)"/.exec(factory(ws, ["state", "WEB-1"]).stdout)?.[1];
  const opens = (calls: string[]) => calls.filter((c) => c.startsWith("pr ready"));

  let r = run(green(), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /WEB-1 is gate; a PR goes to colleagues from your-review/);
  assert.equal(factory(ws, ["state", "WEB-1", "your-review", "--reviewed", HEAD]).status, 0);

  r = run(green({}, "c".repeat(40)), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing opened:\n {2}acme\/web#7: head ccccccc is not the reviewed sha aaaaaaa/);
  assert.deepEqual(opens(r.calls), []);
  assert.equal(stateOf(), "your-review");

  r = run(green(), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(opens(r.calls), [`pr ready ${N} --repo ${REMOTE}`]);
  assert.equal(stateOf(), "colleague-review");

  r = run(green({}, HEAD, false), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /acme\/web#7 is already open/);
  assert.deepEqual(opens(r.calls), []);
});

// Nothing reaches the human's review or colleague review without translations. Both doors ask:
// pr-ready, and pr-open-for-review for a PR that skipped pr-send.
test("a new text missing a language is refused by pr-ready and by pr-open-for-review", () => {
  // The same workspace with its repo keyed portal, which has the modules' text conventions.
  assert.ok(TOML.includes("[repos.web]"), "the test config still names its repo web");
  const toml = TOML.replace("[repos.web]", "[repos.portal]").replaceAll('"web"', '"portal"');
  const { ws, run } = gateWorkspace("", toml);
  const BASE = "b".repeat(40);
  const diff = ["diff --git a/src/a.tsx b/src/a.tsx", "--- a/src/a.tsx", "+++ b/src/a.tsx", "@@ -1 +1,2 @@", "+<p>{t('show_more')}</p>"].join("\n") + "\n";
  const file = (path: string) => `api repos/${REMOTE}/contents/${path}?ref=${HEAD}`;
  const routes = (fi: string) => green({
    [`pr diff ${N} --repo ${REMOTE}`]: { stdout: diff },
    [`api repos/${REMOTE}/compare/main...${HEAD}`]: { stdout: { behind_by: 0, merge_base_commit: { sha: BASE } } },
    [`api repos/${REMOTE}/contents/src/a.tsx?ref=${BASE}`]: { status: 1, stderr: "gh: Not Found (HTTP 404)" },
    [file("locales")]: { stdout: [{ name: "en-GB" }, { name: "fi" }] },
    [file("locales/en-GB/portal.json")]: { stdout: JSON.stringify({ show_more: "Show more" }) },
    [file("locales/fi/portal.json")]: { stdout: JSON.stringify(fi ? { show_more: fi } : {}) },
  });

  let r = run(routes(""), ["pr-ready", "portal", String(N)]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /translations: show_more has no text in fi \(portal\)/);

  r = run(routes("Näytä lisää"), ["pr-ready", "portal", String(N)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /translations: 1 new key\(s\), each with a text in every language/);

  assert.equal(factory(ws, ["state", "WEB-1", "your-review", "--reviewed", HEAD]).status, 0);
  r = run(routes(""), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /acme\/web#7: translations: show_more has no text in fi \(portal\)/);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [], "nothing opened");

  r = run(routes("Näytä lisää"), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [`pr ready ${N} --repo ${REMOTE}`]);
});

// A PR stacked on another PR's branch waits for that one.
test("pr-open-for-review leaves a PR stacked on another branch as it is", () => {
  const { ws, run } = gateWorkspace();
  assert.equal(factory(ws, ["state", "WEB-1", "your-review", "--reviewed", HEAD]).status, 0);
  const w = openWorkspace(ws);
  const rec = loadRec(w, "WEB-1")!;
  const stackedHead = "d".repeat(40);
  saveRec(w, { ...rec, prs: [...(rec.prs ?? []), { repo: REMOTE, number: 8, head: stackedHead }] });
  const fields = `pr view 8 --repo ${REMOTE} --json ${PR_FIELDS}`;
  const base = (green()[`pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`] as { stdout: object }).stdout;
  const r = run(green({ [fields]: { stdout: { ...base, headRefOid: stackedHead, baseRefName: "feature" } } }), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /acme\/web#8 is stacked on feature, not main; left as it is/);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [`pr ready ${N} --repo ${REMOTE}`], "only the PR against main opens");
});

test("delta-range refuses an empty range and a base the head has never been", () => {
  const { ws, run } = gateWorkspace();
  const clone = join(ws, "repos", "web");
  const origin = join(ws, "origin.git");
  const must = (dir: string, ...args: string[]) => {
    const r = git(dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args);
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  mkdirSync(join(ws, "repos"));
  must(ws, "init", "-q", "--bare", "-b", "main", origin);
  must(ws, "clone", "-q", origin, clone);
  const commit = (file: string, text: string) => {
    writeFileSync(join(clone, file), text);
    must(clone, "add", file);
    must(clone, "commit", "-q", "-m", file);
    return must(clone, "rev-parse", "HEAD");
  };
  commit("a.txt", "1");
  must(clone, "push", "-q", "origin", "HEAD:main");
  must(clone, "checkout", "-q", "-b", "feature");
  const first = commit("b.txt", "1");
  const head = commit("b.txt", "2");
  must(clone, "push", "-q", "origin", "feature");
  // a sibling of the head that nothing ever pushed, and one the force-push timeline names
  const tree = must(clone, "rev-parse", `${first}^{tree}`);
  const stray = must(clone, "commit-tree", tree, "-p", first, "-m", "stray");
  const pushedOver = must(clone, "commit-tree", tree, "-p", first, "-m", "pushed over");
  const timeline = { stdout: [{ event: "head_ref_force_pushed", commit_id: pushedOver }, { event: "commented" }] };
  const routes = green({ [`api repos/${REMOTE}/issues/${N}/timeline?per_page=100&page=1`]: timeline }, head);

  let r = run(routes, ["delta-range", "web", String(N), first]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^DISPATCHABLE/);
  assert.match(r.stdout, /range: commit range, base is an ancestor of head/);

  r = run(routes, ["delta-range", "web", String(N), head]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^DO NOT DISPATCH/);
  assert.match(r.stdout, /EMPTY RANGE/);

  r = run(routes, ["delta-range", "web", String(N), stray]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is not a state this PR's head has ever been/);

  r = run(routes, ["delta-range", "web", String(N), pushedOver]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /range: TREE DIFF ONLY, base is NOT an ancestor of head/);
  assert.match(r.stdout, /base evidenced by: GitHub force-push timeline/);
});

test("pr-comment replies only inside a configured bot's thread", () => {
  const { ws, run } = gateWorkspace();
  const body = join(ws, "reply.md");
  writeFileSync(body, "Fixed in the next push.\n");
  const routes = {
    [`api repos/${REMOTE}/pulls/comments/11`]: { stdout: { id: 11, user: { login: "coderabbitai[bot]" } } },
    [`api repos/${REMOTE}/pulls/comments/12`]: { stdout: { id: 12, user: { login: "a-person" } } },
    [`api repos/${REMOTE}/pulls/${N}/comments/11/replies`]: { stdout: { html_url: "https://github.com/acme/web/pull/7#discussion_r13" } },
  };
  const comment = (id: string, ...more: string[]) => run(routes, ["pr-comment", "web", String(N), "bea", body, id, ...more]);

  let r = comment("latest");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a review-comment id/);
  r = run(routes, ["pr-comment", "web", String(N), "bea", body]);
  assert.equal(r.status, 2, "the id is not optional");
  r = comment("12");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /by 'a-person', who is not one of the bots in github\.bots/);
  assert.ok(!r.calls.some((c) => c.includes("/replies")));

  r = comment("11", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /> Written by agent\.\n\nFixed in the next push\./);
  assert.ok(!r.calls.some((c) => c.includes("/replies")));

  r = comment("11");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://github.com/acme/web/pull/7#discussion_r13");
  assert.ok(r.calls.some((c) => c.startsWith(`api repos/${REMOTE}/pulls/${N}/comments/11/replies -f body=> Written by agent.`)));
});

// Aikido reads its ignore command only at the start of a comment.
test("pr-comment puts Aikido's ignore command first, with the marker after it, only in Aikido's threads", () => {
  const { ws, run } = gateWorkspace("", TOML, ["coderabbitai", "aikido-pr-checks"]);
  const body = join(ws, "ignore.md");
  const routes = {
    [`api repos/${REMOTE}/pulls/comments/21`]: { stdout: { id: 21, user: { login: "aikido-pr-checks[bot]" } } },
    [`api repos/${REMOTE}/pulls/comments/22`]: { stdout: { id: 22, user: { login: "coderabbitai[bot]" } } },
    [`api repos/${REMOTE}/pulls/${N}/comments/21/replies`]: { stdout: { html_url: "https://github.com/acme/web/pull/7#discussion_r23" } },
  };
  const comment = (text: string, id: string, ...more: string[]) => {
    writeFileSync(body, text);
    return run(routes, ["pr-comment", "web", String(N), "bea", body, id, ...more]);
  };

  let r = comment("@AikidoSec ignore: a dev script; its paths come from a fixed list.\n", "21");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.some((c) => c === `api repos/${REMOTE}/pulls/${N}/comments/21/replies -f body=@AikidoSec ignore: a dev script; its paths come from a fixed list.\n> Written by agent.`),
    r.calls.join("\n"));

  // Only in Aikido's thread, only that command, only one line; anything else is refused before it posts.
  for (const [text, id, why] of [
    ["@AikidoSec ignore: fine\n", "22", /goes only in Aikido's own threads; comment 22 is by 'coderabbitai\[bot\]'/],
    ["@AikidoSec snooze: later\n", "21", /exactly one line, "@AikidoSec ignore: <reason>"/],
    ["@AikidoSec ignore: fine\nand a second line\n", "21", /exactly one line/],
    ["@AikidoSec ignore:\n", "21", /exactly one line/],
  ] as [string, string, RegExp][]) {
    r = comment(text, id);
    assert.equal(r.status, 1, text);
    assert.match(r.stderr, why);
    assert.ok(!r.calls.some((c) => c.includes("/replies")), text);
  }

  // Any other reply in Aikido's thread keeps the marker first.
  r = comment("Not applicable: a dev script.\n", "21", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /---\n> Written by agent\.\n\nNot applicable: a dev script\./);
});

// pr-media: media stamped at the head is the after set, exactly as it always was; media stamped at
// the PR's base (the merge-base, or the base branch's head) is the before set; any other is refused.
test("pr-media puts a base-stamped demo under Before and refuses any other commit", () => {
  const { ws, run } = gateWorkspace();
  const MB = "b".repeat(40);
  const TIP = "c".repeat(40);
  const dir = join(ws, "media");
  mkdirSync(dir);
  writeFileSync(join(dir, "01-shot.png"), "png");
  writeFileSync(join(dir, "demo.mp4"), "mp4");
  const stampAt = (sha: string) => writeFileSync(join(dir, STAMP), JSON.stringify({ sha }));
  const cmp = `api repos/${REMOTE}/compare/main...${HEAD}`;
  const routes = green({ [cmp]: { stdout: { behind_by: 1, merge_base_commit: { sha: MB }, base_commit: { sha: TIP } } } });
  const media = (r: Routes, ...more: string[]) => run(r, ["pr-media", "web", String(N), ...more]);
  const upload = ["**shot**\n\n![shot](<upload:01-shot.png>)\n", "**demo**\n\n<upload:demo.mp4>\n"];

  // After: the section is what it always was, and the base is never asked about.
  stampAt(HEAD);
  let r = media(routes, "--dir", dir, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [MEDIA_BEGIN, "## Demo", ...upload, MEDIA_END].join("\n") + "\n");
  assert.ok(!r.calls.some((c) => c.includes("/compare/")));

  // Before, at the merge-base or at main's head: its own block, and the after half is kept.
  for (const sha of [MB, TIP]) {
    stampAt(sha);
    r = media(routes, "--dir", dir, "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, [MEDIA_BEGIN, "## Demo", BEFORE_BEGIN, "### Before", ...upload, BEFORE_END, "### After", "No visual change.", MEDIA_END].join("\n") + "\n");
  }

  // Neither head nor base: refused, nothing uploaded or edited.
  stampAt("d".repeat(40));
  r = media(routes, "--dir", dir, "--dry-run");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the demo captured ddddddd but the PR head is aaaaaaa and its base \(main\) is bbbbbbb or ccccccc/);
  r = media({ ...routes, [`pr edit ${N}`]: { stdout: "" } }, "--dir", dir);
  assert.equal(r.status, 1);
  assert.ok(!r.calls.some((c) => c.startsWith("pr edit") || c.startsWith(`api repos/${REMOTE} `)));

  // An after upload writes the body it always did, and keeps a before block that is there.
  const bodies = join(ws, "bodies.md");
  const edit = (body: string) => {
    rmSync(bodies, { force: true });
    const res = run({ ...routes, [`pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`]: { stdout: { ...(green()[`pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`] as { stdout: object }).stdout, body } }, [`pr edit ${N}`]: { stdout: "" } },
      ["pr-media", "web", String(N), "--no-visual-change"], { FAKE_GH_BODIES: bodies });
    assert.equal(res.status, 0, res.stderr);
    return readFileSync(bodies, "utf8");
  };
  assert.equal(edit("Why it changed.\n"), BODY);
  const withBefore = `Why it changed.\n\n${MEDIA_BEGIN}\n## Demo\n${BEFORE_BEGIN}\n### Before\nold\n${BEFORE_END}\n### After\nnew\n${MEDIA_END}\n`;
  assert.equal(edit(withBefore), `Why it changed.\n\n${MEDIA_BEGIN}\n## Demo\n${BEFORE_BEGIN}\n### Before\nold\n${BEFORE_END}\n### After\nNo visual change.\n${MEDIA_END}\n`);
});

// demo --before stamps the commit the files are, not HEAD: the merge-base with origin's default
// branch, or that branch's head, and nothing when the files are neither.
test("demo --before finds the base commit the checked-out files match", () => {
  const dir = join(tempWorkspace(TOML), "repo");
  after(() => rmSync(dirname(dir), { recursive: true, force: true }));
  mkdirSync(dir);
  const g = (...a: string[]) => {
    const r = git(dir, ...a);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "main\n");
  g("add", ".");
  g("commit", "-qm", "main");
  const base = g("rev-parse", "HEAD");
  g("update-ref", "refs/remotes/origin/main", base);
  g("switch", "-qc", "feature");
  writeFileSync(join(dir, "a.txt"), "feature\n");
  g("commit", "-qam", "feature");

  assert.equal(beforeSha(dir).sha, undefined, "the branch's own files are not the base");
  g("checkout", base, "--", "a.txt");
  assert.equal(beforeSha(dir).sha, base, "main's files on the branch's HEAD are the base");
  g("checkout", "HEAD", "--", "a.txt");
  writeFileSync(join(dir, "b.txt"), "new\n");
  g("add", "b.txt");
  g("commit", "-qm", "adds a file");
  g("checkout", base, "--", "a.txt");
  assert.equal(beforeSha(dir).sha, undefined, "a file the branch added is still there");
  g("switch", "-q", "--detach", "origin/main");
  assert.equal(beforeSha(dir).sha, base);
});

// A PR stacked on another branch: its before is that branch's head on origin, named with
// --base-ref, not main.
test("demo --before --base-ref accepts a stacked PR's base and still refuses an unrelated commit", () => {
  const dir = join(tempWorkspace(TOML), "repo");
  after(() => rmSync(dirname(dir), { recursive: true, force: true }));
  mkdirSync(dir);
  const g = (...a: string[]) => {
    const r = git(dir, ...a);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    g("add", ".");
    g("commit", "-qm", text);
    return g("rev-parse", "HEAD");
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("update-ref", "refs/remotes/origin/main", commit("a.txt", "main\n"));
  g("switch", "-qc", "lower");
  const lower = commit("a.txt", "lower\n");
  g("update-ref", "refs/remotes/origin/lower", lower);
  g("switch", "-qc", "upper");
  commit("a.txt", "upper\n");
  g("switch", "-qc", "unrelated", "main");
  const unrelated = commit("b.txt", "unrelated\n");
  g("switch", "-q", "upper");

  // Detached at the base branch's head: refused without --base-ref, accepted with it.
  g("switch", "-q", "--detach", "origin/lower");
  assert.equal(beforeSha(dir).sha, undefined, "without --base-ref only main counts");
  assert.deepEqual(beforeSha(dir, "lower"), { sha: lower, base: "origin/lower" });
  assert.equal(beforeSha(dir, "origin/lower").sha, lower, "origin/ is optional");

  // Anything else is still refused: the stacked branch's own files, or a commit off another branch.
  g("switch", "-q", "upper");
  assert.equal(beforeSha(dir, "lower").sha, undefined, "the PR's own files are not its base");
  g("switch", "-q", "--detach", unrelated);
  assert.equal(beforeSha(dir, "lower").sha, undefined, "an unrelated commit is no base");

  // A base branch whose files equal main's is still the base named.
  g("switch", "-qc", "same", "main");
  g("commit", "-q", "--allow-empty", "-m", "same files as main");
  const same = g("rev-parse", "HEAD");
  g("update-ref", "refs/remotes/origin/same", same);
  g("switch", "-q", "--detach", "origin/same");
  assert.equal(beforeSha(dir, "same").sha, same, "--base-ref's head first");
  assert.equal(beforeSha(dir).sha, g("rev-parse", "origin/main"), "without --base-ref, main");

  // --base-ref names a branch on origin; a sha or a branch never fetched is refused outright.
  assert.throws(() => beforeSha(dir, lower), /is not a branch on origin/);
  assert.throws(() => beforeSha(dir, "unrelated"), /is not a branch on origin; `git fetch origin unrelated` first/);
});

// pr-media for a stacked PR: GitHub compares against the PR's base branch, so media stamped at that
// branch's head is the before set, and main's head is refused.
test("pr-media puts a stacked PR's base-stamped demo under Before and refuses main's head", () => {
  const { ws, run } = gateWorkspace();
  const LOWER = "e".repeat(40);
  const MAIN = "c".repeat(40);
  const dir = join(ws, "media");
  mkdirSync(dir);
  writeFileSync(join(dir, "01-shot.png"), "png");
  const stampAt = (sha: string) => writeFileSync(join(dir, STAMP), JSON.stringify({ sha }));
  const view = `pr view ${N} --repo ${REMOTE} --json ${PR_FIELDS}`;
  const pr = (green()[view] as { stdout: object }).stdout;
  const routes = green({
    [view]: { stdout: { ...pr, baseRefName: "lower" } },
    [`api repos/${REMOTE}/compare/lower...${HEAD}`]: { stdout: { merge_base_commit: { sha: LOWER }, base_commit: { sha: LOWER } } },
  });
  const media = () => run(routes, ["pr-media", "web", String(N), "--dir", dir, "--dry-run"]);

  stampAt(LOWER);
  let r = media();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${BEFORE_BEGIN}\n### Before\n\\*\\*shot\\*\\*`));
  assert.ok(r.calls.some((c) => c.startsWith(`api repos/${REMOTE}/compare/lower...${HEAD}`)));

  stampAt(MAIN);
  r = media();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the demo captured ccccccc but the PR head is aaaaaaa and its base \(lower\) is eeeeeee/);
});

// The spec does not read Before from DEMO_OUT's "-before" suffix, where a key or a moved output dir
// could film the wrong label: factory demo says it, and the template reads it.
test("factory demo tells the spec which film it is by DEMO_BEFORE, and the template reads it", () => {
  const dir = tempWorkspace(TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  writeFileSync(join(dir, "demo.env"), "DEMO_BEFORE=1\n");
  assert.equal(demoEnv(ws, "/pw/node_modules/@playwright/test", "/tmp/demo/WEB-1-before", "/s", undefined, true).DEMO_BEFORE, "1");
  assert.equal(demoEnv(ws, "/pw/node_modules/@playwright/test", "/tmp/demo/WEB-1", "/s", undefined, false).DEMO_BEFORE, undefined, "an after run is never Before");
  const spec = readFileSync(fileURLToPath(new URL("../../templates/demo.spec.ts", import.meta.url)), "utf8");
  assert.match(spec, /const STATE = process\.env\.DEMO_BEFORE === '1' \? 'Before' : 'After';/);
  assert.doesNotMatch(spec, /endsWith\('-before'\)/);
});

// A PR opened for colleagues before CodeRabbit read its final head would get its findings while
// colleagues are already reading. What reaches the human may still go without its review (above);
// nothing opens for colleagues without it.
test("pr-wait-coderabbit asks for the review of the head and waits it out, rate limits included", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const FULL = `pr comment ${N} --repo ${REMOTE} --body @coderabbitai full review`;
  const review = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY };
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const asked = (body: string, created_at: string) => ({ body, created_at, user: { login: "mikael" } });
  // its reply to an ask while limited
  const limitedReply = (created_at: string) => ({ body: "<details>\n<summary>Action not completed</summary>\n\nReview rate limited.\n</details>", created_at, user: { login: "coderabbitai[bot]" } });
  // its reply to an ask it took: an incremental review with nothing new brings no review object
  const performed = (created_at: string, summary = "Action performed") => ({ body: `<details>\n<summary>${summary}</summary>\n\nReview finished.\n</details>`, created_at, user: { login: "coderabbitai[bot]" } });
  const skipped = { [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review skipped: draft pull request" }] } } };
  const limited = { [st]: { stdout: { statuses: [] } }, [cr]: checkRuns(check("test"), rabbitRun("Review rate limited")) };
  const wait = (over: Routes, env: NodeJS.ProcessEnv = {}) => run(green(over), ["pr-wait-coderabbit", "web", String(N)], { FACTORY_REVIEW_POLL: "0", ...env });
  const posts = (calls: string[], c = POST) => calls.filter((x) => x === c).length;

  // reviewed already: nothing asked
  let r = wait({ [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review completed" }] } } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^REVIEWED -- coderabbitai reviewed acme\/web#7 at a+$/m);
  assert.equal(posts(r.calls), 0);

  // never asked: asks once, waits, and its review lands
  r = wait({ ...skipped, [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [review] }], ...asking([], [asked("@coderabbitai review", ago(5))]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 1);
  assert.match(r.stderr, /posted "@coderabbitai review" to ask for a review of aaaaaaa/);

  // rate limited: asks, is limited again, asks again once FACTORY_REVIEW_RETRY has passed, waits
  r = wait({ ...limited, [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [] }, { stdout: [review] }],
    ...asking([], [asked("@coderabbitai review", ago(1000)), limitedReply(ago(990))], [asked("@coderabbitai review", ago(1000)), limitedReply(ago(990)), asked("@coderabbitai review", ago(1))]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 2, "asked, and asked again after the limit");
  assert.match(r.stderr, /waiting \(\d+s\): CodeRabbit is rate limited and has not reviewed aaaaaaa/);

  // the limit said only by its reply comment, with no check-run of its: still the limit, and an ask
  // younger than the retry is not repeated; at the ceiling it stops with exit 3
  r = wait({ ...skipped, [rv]: { stdout: [] }, ...asking([asked("@coderabbitai review", ago(60)), limitedReply(ago(50))]) }, { FACTORY_REVIEW_WAIT_LIMIT: "0" });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(posts(r.calls), 0);
  assert.match(r.stderr, /still waiting after \d+s: CodeRabbit is rate limited and has not reviewed aaaaaaa/);

  // "@coderabbitai review" is incremental: when it brings nothing within the grace, a full review
  r = wait({ ...skipped, [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [review] }],
    ...asking([asked("@coderabbitai review", ago(3600)), performed(ago(3590))], [asked("@coderabbitai review", ago(3600)), performed(ago(3590)), asked("@coderabbitai full review", ago(1))]),
    [FULL]: { stdout: `https://github.com/${REMOTE}/pull/${N}#issuecomment-2\n` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 0);
  assert.equal(posts(r.calls, FULL), 1);
  // its reply in the plural, "Actions performed", answers the ask just as well
  r = wait({ ...skipped, [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [review] }],
    ...asking([asked("@coderabbitai review", ago(3600)), performed(ago(3590), "✅ Actions performed")], [asked("@coderabbitai review", ago(3600)), performed(ago(3590), "✅ Actions performed"), asked("@coderabbitai full review", ago(1))]),
    [FULL]: { stdout: `https://github.com/${REMOTE}/pull/${N}#issuecomment-2\n` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 0);
  assert.equal(posts(r.calls, FULL), 1);
  // a word that only ends in "actions" is no answer: the ask stays held, and no full review is asked
  r = wait({ ...skipped, [rv]: { stdout: [] }, ...asking([asked("@coderabbitai review", ago(3600)), performed(ago(3590), "Transactions performed")]) }, { FACTORY_REVIEW_WAIT_LIMIT: "0" });
  assert.equal(posts(r.calls), 0);
  assert.equal(posts(r.calls, FULL), 0, r.stderr);
  assert.match(r.stderr, /not answered yet/);
  // and a full review that brought nothing either is for a person to read
  r = wait({ ...skipped, [rv]: { stdout: [] }, ...asking([asked("@coderabbitai review", ago(7200)), asked("@coderabbitai full review", ago(3600))]) });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /CodeRabbit was asked for "@coderabbitai full review" at aaaaaaa \d+s ago and has not reviewed it -- read its reply on the PR/);

  // still reviewing: waited on, nothing asked
  r = wait({ [st]: { stdout: { statuses: [] } }, [cr]: [checkRuns(check("test"), rabbitRun("Review in progress", { status: "in_progress", conclusion: null })),
    checkRuns(check("test"), rabbitRun("Finished", { conclusion: "success" }))] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 0);

  // pr-ready keeps the rate limit a remark: what reaches the human may go without its review
  r = run(green({ ...limited, [rv]: { stdout: [] } }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /CodeRabbit is rate limited and has not reviewed aaaaaaa; sent without its review/);
});

test("pr-wait-coderabbit with no review bot configured has nothing to wait for", () => {
  const { run } = gateWorkspace();
  const r = run(green(), ["pr-wait-coderabbit", "web", String(N)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^REVIEWED -- no review bot is configured$/m);
});

test("pr-open-for-review opens nothing until the review bot has reviewed every head", () => {
  const { ws, run } = gateWorkspace('review_bot = "coderabbitai"\n');
  assert.equal(factory(ws, ["state", "WEB-1", "your-review", "--reviewed", HEAD]).status, 0);
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const stateOf = () => /"state": "([a-z-]+)"/.exec(factory(ws, ["state", "WEB-1"]).stdout)?.[1];
  const limited = { [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review rate limited" }] } }, [rv]: { stdout: [] } };

  let r = run(green({ ...limited, ...asking([]) }), ["pr-open-for-review", "WEB-1"], { FACTORY_REVIEW_POLL: "0", FACTORY_REVIEW_WAIT_LIMIT: "0" });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /pr-open-for-review: REFUSED -- nothing opened, WEB-1 stays your-review: acme\/web#7: still waiting after \d+s: CodeRabbit is rate limited/);
  assert.equal(r.calls.filter((c) => c === POST).length, 1, "asked for the review");
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [], "nothing opened");
  assert.equal(stateOf(), "your-review");

  const review = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY };
  r = run(green({ ...limited, [rv]: { stdout: [review] } }), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [`pr ready ${N} --repo ${REMOTE}`]);
  assert.equal(stateOf(), "colleague-review");
});

// GitHub refuses a diff over 20000 lines; pr-ready still checks translations and prose, on the diff
// from the repo's checkout instead.
test("a diff GitHub refuses as too large is read from the checkout, and the prose check still runs", () => {
  const { ws, run } = gateWorkspace();
  const origin = join(ws, "origins", "web.git");
  const clone = join(ws, "repos", "web");
  const must = (dir: string, ...args: string[]) => {
    const r = git(dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args);
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  mkdirSync(dirname(origin), { recursive: true });
  must(ws, "init", "-q", "--bare", "-b", "main", origin);
  must(ws, "clone", "-q", origin, clone);
  must(clone, "commit", "-q", "--allow-empty", "-m", "start");
  must(clone, "push", "-q", "origin", "HEAD:main");
  must(clone, "switch", "-q", "-c", "feature");
  writeFileSync(join(clone, "a.ts"), diffOf(35, 2).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n") + "\n");
  must(clone, "add", "a.ts");
  must(clone, "commit", "-q", "-m", "feature");
  const head = must(clone, "rev-parse", "HEAD");

  const tooLarge = { status: 1, stderr: `could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) (https://api.github.com/repos/${REMOTE}/pulls/${N})\nPullRequest.diff too_large\n` };
  const r = run(green({ [`pr diff ${N} --repo ${REMOTE}`]: tooLarge }, head), ["pr-ready", "web", String(N)]);
  assert.match(r.stdout, /diff read from .*repos\/web: GitHub refuses it as over 20000 lines/);
  assert.match(r.stdout, /35 added prose\/comment lines against 2 of code/);
  assert.doesNotMatch(r.stdout + r.stderr, /could not read the diff|COULD NOT READ the diff/);
});

// Each ask CodeRabbit cannot take is a refusal on the PR. The factory asks once per head, and never
// over its review, an ask it has not answered, or a rate limit that says when its next review is
// available.
test("CodeRabbit is asked once per head, by the factory, and never over its review, an unanswered ask or its rate limit", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const review = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED", body: REVIEW_BODY };
  const now = (s = 0) => new Date(Date.now() - s * 1000).toISOString();
  const byHand = { body: "> Written by agent.\n\n@coderabbitai review", created_at: now(30), user: { login: "mikael" } };
  const posts = (calls: string[]) => calls.filter((c) => c === POST).length;
  const nothing = { [st]: { stdout: { statuses: [] } } };
  const prWait = (over: Routes) => run(green({ ...nothing, ...over }), ["pr-wait", "web", String(N), HEAD]);
  const waitCr = (over: Routes, env: NodeJS.ProcessEnv = {}) => run(green(over), ["pr-wait-coderabbit", "web", String(N)], { FACTORY_REVIEW_POLL: "0", ...env });

  // already reviewed at this head: nothing asked, by either
  let r = waitCr({ ...nothing, [rv]: { stdout: [review] }, ...asking([]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 0);
  r = prWait({ [rv]: { stdout: [review] }, ...asking([]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 0);

  // asked by hand and not answered yet: neither asks again, both wait for its review
  r = prWait({ [rv]: [{ stdout: [] }, { stdout: [review] }], ...asking([byHand]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 0, "an ask by hand is an ask");
  assert.match(r.stdout, /^SENDABLE/m);
  r = waitCr({ ...nothing, [rv]: [{ stdout: [] }, { stdout: [review] }], ...asking([byHand]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 0);

  // never asked and not reviewed: pr-wait asks, once, and sends when its review lands
  r = prWait({ [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [review] }], ...asking([], [{ ...TRIGGER, created_at: now(1) }]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(r.calls), 1);
  assert.match(r.stderr, /pr-wait: posted "@coderabbitai review" to ask for a review of aaaaaaa/);
  assert.match(r.stdout, /^SENDABLE/m);

  // rate limited, its summary saying when the next review is available: not asked before then,
  // though the last ask is older than FACTORY_REVIEW_RETRY
  const refused = { body: "<summary>Action not completed</summary>\n\nReview rate limited.", created_at: now(1190), user: { login: "coderabbitai[bot]" } };
  const summary = { body: "> [!WARNING]\n> ## Review limit reached\n> **Next included review available in 30 minutes.**", created_at: "2026-01-01T09:00:00Z", updated_at: now(60), user: { login: "coderabbitai[bot]" } };
  r = waitCr({ ...nothing, [rv]: { stdout: [] }, ...asking([{ ...TRIGGER, created_at: now(1200) }, refused, summary]) }, { FACTORY_REVIEW_WAIT_LIMIT: "0" });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(posts(r.calls), 0);
  assert.match(r.stderr, /CodeRabbit is rate limited and has not reviewed aaaaaaa; not asking again: rate limited, its next review available in 29 min/);
});

// The review pr-open-for-review waits for can bring findings with it: their threads keep the PR a draft.
test("pr-open-for-review opens nothing while the review it waited for left unresolved threads", () => {
  const { ws, run } = gateWorkspace('review_bot = "coderabbitai"\n');
  assert.equal(factory(ws, ["state", "WEB-1", "your-review", "--reviewed", HEAD]).status, 0);
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const reviewed = { [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review completed" }] } } };
  const threads = (...nodes: unknown[]) => ({ "api graphql": { stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } } } });

  let r = run(green({ ...reviewed, ...threads({ isResolved: true, path: "src/a.ts", line: 3 }, { isResolved: false, path: "src/b.ts", line: 9 }) }), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /pr-open-for-review: REFUSED -- nothing opened:\n {2}acme\/web#7: unresolved review threads: src\/b\.ts:9/);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [], "nothing opened");

  r = run(green({ ...reviewed, ...threads({ isResolved: true, path: "src/b.ts", line: 9 }) }), ["pr-open-for-review", "WEB-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("pr ready")), [`pr ready ${N} --repo ${REMOTE}`]);
});
