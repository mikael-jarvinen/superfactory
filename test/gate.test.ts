import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
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
    [`pr diff ${N} --repo ${REMOTE}`]: { stdout: diffOf(2, 20) },
    [`pr ready ${N} --repo ${REMOTE}`]: { stdout: "" },
    ...over,
  };
}

// A workspace whose gh is the fake, with a record for the PR that is past its working states.
function gateWorkspace(gate = "") {
  const ws = tempWorkspace(`${TOML}\n[github]\nbots = ["coderabbitai", "Copilot"]\n\n[gate]\nprose_remark = 30\n${gate}`);
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

  // A draft is no failure: every PR is one until colleague review.
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

// Mikael, 2026-10-16: a PR is a draft until it goes to colleagues. pr-send gates it as it is, checks the
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

// On 2026-10-16 pr-wait saw CL-2290 green and pr-send's own read, a moment later, met mergeability
// being recomputed after a merge into the base.
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

// Every PR is a draft until colleague review, and CodeRabbit skips drafts with a green status. With
// no review bot required, that is only named.
test("a review bot that skipped the draft is named as having reviewed nothing", () => {
  const { run } = gateWorkspace();
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const r = run(green({ [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review skipped: draft pull request" }] } } }),
    ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /status 'CodeRabbit' is green only because it skipped a draft and reviewed nothing -- comment "@coderabbitai review" on the PR/);
});

// The head commit, the PR's comments since it (one reply per read), and posting the trigger.
const POST = `pr comment ${N} --repo ${REMOTE} --body @coderabbitai review`;
const TRIGGER = { body: "@coderabbitai review", created_at: "2026-01-01T10:01:00Z" };
const asking = (...reads: unknown[][]): Routes => ({
  [`api repos/${REMOTE}/commits/${HEAD}`]: { stdout: { commit: { committer: { date: "2026-01-01T09:59:00Z" } } } },
  [`api repos/${REMOTE}/issues/${N}/comments`]: reads.map((stdout) => ({ stdout })),
  [POST]: { stdout: `https://github.com/${REMOTE}/pull/${N}#issuecomment-1\n` },
});

// Mikael, 2026-10-20: "Coderabbit should review before you even give the PR to me?" The statuses
// are CodeRabbit's own, as read off lyyti-api#3270 and #3271, lyyti-classic#8350 and lyyti-public#1740.
test("a required review bot must have reviewed the head: pr-ready refuses, pr-wait waits while it reviews", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const rabbit = (state: string, description: string) => ({ stdout: { statuses: [{ context: "CodeRabbit", state, description, created_at: "2026-01-01T10:00:10Z" }] } });
  const review = (commit: string) => ({ user: { login: "coderabbitai[bot]" }, commit_id: commit, state: "COMMENTED" });
  const ready = (over: Routes, env: NodeJS.ProcessEnv = {}) => run(green(over), ["pr-ready", "web", String(N)], env);
  const ASK = /-- comment "@coderabbitai review" on the PR, then run this again/;

  let r = ready({ [st]: rabbit("success", "Review completed") });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.calls.includes(rv), "a completed review at this head needs nothing more");

  for (const desc of ["Review skipped: draft pull request"]) {
    r = ready({ [st]: rabbit("success", desc), [rv]: { stdout: [review("b".repeat(40))] } });
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

// On 2026-10-28 CodeRabbit skipped seven drafts, and each time the lead asked for the review by hand
// and polled. Its check-runs are its own, as read off lyyti-classic#8509 and lyyti-api#3278.
test("pr-wait asks a review bot that skipped the head, once, and waits for it", () => {
  const { run } = gateWorkspace('review_bot = "coderabbitai"\n');
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const rv = `api repos/${REMOTE}/pulls/${N}/reviews?per_page=100&page=1`;
  const cr = `api repos/${REMOTE}/commits/${HEAD}/check-runs?per_page=100&page=1`;
  const skipped = (title: string) => checkRuns(check("test"), rabbitRun(title, { conclusion: "skipped" }));
  const review = { user: { login: "coderabbitai[bot]" }, commit_id: HEAD, state: "COMMENTED" };
  const wait = (over: Routes) => run(green({ [st]: { stdout: { statuses: [] } }, ...over }), ["pr-wait", "web", String(N), HEAD]);

  // it skipped: asked once, then its review lands and the PR is sent
  let r = wait({ [cr]: skipped("Review skipped"), [rv]: [{ stdout: [] }, { stdout: [] }, { stdout: [review] }], ...asking([], [TRIGGER]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c === POST).length, 1, "asked once, not on every poll");
  assert.match(r.stderr, /posted "@coderabbitai review" to ask for a review of aaaaaaa/);
  assert.match(r.stdout, /^SENDABLE/m);

  // asked, and then rate limited: sent with the remark
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

// Mikael, 2026-10-27: "we should be able to work without coderabbit when the limits are hit." The
// check-run is CodeRabbit's own, as read off lyyti-classic#8447: neutral, titled "Review rate limited".
const rabbitRun = (title: string, o: Record<string, unknown> = {}) =>
  check("CodeRabbit", { conclusion: "neutral", output: { title }, app: { slug: "coderabbitai" }, details_url: null, ...o });

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

  r = run(green(limited), ["pr-send", "web", String(N), HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(REMARK), `pr-send shows the remark:\n${r.stdout}`);

  // an older rate limit under a later run still in progress is waited out, not sent
  r = run(green({ ...limited, [cr]: checkRuns(check("test"), rabbitRun("Review rate limited"), rabbitRun("Review in progress", { status: "in_progress", conclusion: null, started_at: "2026-01-01T10:05:00Z" })) }), ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /check 'CodeRabbit' is in_progress, not completed/);
});

// lyyti-events#847, 2026-10-27: after a rebase CodeRabbit said "Already reviewed the last commit",
// finished its check-run green, and set no status and no review object.
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
  assert.match(r.stdout, /CodeRabbit has not reviewed aaaaaaa: its status here says "Review skipped: draft pull request" -- comment "@coderabbitai review" on the PR, then run this again/);
  assert.doesNotMatch(r.stdout, /rate limited/);
});

// On 2026-10-20 pr-wait refused a lyyti-api PR whose gate jobs had simply not started yet.
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

// Mikael, 2026-10-16: "Only when they are in my colleagues review column should they be open PRs."
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

// A PR stacked on another PR's branch waits for that one: CL-2284's #8351 sits on #8315's branch.
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
