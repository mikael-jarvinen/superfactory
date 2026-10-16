import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { proseLines } from "../src/gate/ready.js";
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
function gateWorkspace() {
  const ws = tempWorkspace(`${TOML}\n[github]\nbots = ["coderabbitai", "Copilot"]\n\n[gate]\nprose_remark = 30\n`);
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

// Every PR is a draft until colleague review, and CodeRabbit skips drafts with a green status.
test("a review bot that skipped the draft is named as having reviewed nothing", () => {
  const { run } = gateWorkspace();
  const st = `api repos/${REMOTE}/commits/${HEAD}/status`;
  const r = run(green({ [st]: { stdout: { statuses: [{ context: "CodeRabbit", state: "success", description: "Review skipped: draft pull request" }] } } }),
    ["pr-ready", "web", String(N)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /status 'CodeRabbit' is green only because it skipped a draft and reviewed nothing -- comment "@coderabbitai review" on the PR/);
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
