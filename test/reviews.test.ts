import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseAnswer, prQuery, type PrNode, ReviewCache, reviewStatus } from "../src/board/reviews.js";
import { serve } from "../src/board/server.js";
import { transition } from "../src/state.js";
import { openWorkspace } from "../src/workspace.js";
import { tempWorkspace } from "./helpers.js";

const macOnly = process.platform !== "darwin" && "the board tests are macOS-only";

const user = (login: string) => ({ login, __typename: "User" });
const bot = (login: string) => ({ login, __typename: "Bot" });

// An open, mergeable PR by "author" with no reviews; each case changes what it needs.
function pr(over: Partial<PrNode> = {}, reviews: [ReturnType<typeof user>, string][] = [], threads: [ReturnType<typeof user>, boolean][] = []): PrNode {
  return {
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    author: user("author"),
    reviews: { nodes: reviews.map(([author, state]) => ({ author, state })) },
    reviewThreads: { nodes: threads.map(([author, isResolved]) => ({ isResolved, comments: { nodes: [{ author }] } })) },
    ...over,
  };
}

test("no reviews", () => {
  const s = reviewStatus(pr());
  assert.equal(s.state, "none");
  assert.deepEqual(s.reviewers, []);
  assert.equal(s.ready, false);
});

// What the live PRs look like: the bots review, and the author answers them in their threads, which
// GitHub files as the author's own COMMENTED reviews. None of it is a colleague's review.
test("bot reviews and the author's replies count as no reviews", () => {
  const s = reviewStatus(pr({}, [
    [bot("coderabbitai"), "COMMENTED"],
    [bot("aikido-pr-checks"), "COMMENTED"],
    [bot("copilot-pull-request-reviewer"), "COMMENTED"],
    [user("coderabbitai"), "COMMENTED"],
    [user("dependabot[bot]"), "APPROVED"],
    [user("author"), "COMMENTED"],
  ], [[bot("coderabbitai"), false], [user("author"), false]]));
  assert.equal(s.state, "none");
  assert.equal(s.threads, 0, "only a thread a human reviewer opened is an open thread");
});

test("commented", () => {
  const s = reviewStatus(pr({}, [[user("lundis"), "COMMENTED"], [user("lundis"), "COMMENTED"], [user("kim"), "COMMENTED"]], [[user("lundis"), false], [user("kim"), true]]));
  assert.equal(s.state, "commented");
  assert.deepEqual(s.reviewers, [{ login: "lundis", state: "COMMENTED" }, { login: "kim", state: "COMMENTED" }]);
  assert.equal(s.threads, 1);
});

test("changes requested", () => {
  assert.equal(reviewStatus(pr({}, [[user("kim"), "CHANGES_REQUESTED"], [user("lundis"), "APPROVED"]])).state, "changes");
  assert.equal(reviewStatus(pr({ reviewDecision: "CHANGES_REQUESTED" }, [[user("kim"), "COMMENTED"]])).state, "changes");
  // a later approval from the same reviewer takes the request back; a later comment does not
  assert.equal(reviewStatus(pr({ reviewDecision: null }, [[user("kim"), "CHANGES_REQUESTED"], [user("kim"), "APPROVED"]])).state, "approved");
  assert.equal(reviewStatus(pr({}, [[user("kim"), "CHANGES_REQUESTED"], [user("kim"), "COMMENTED"]])).state, "changes");
  assert.equal(reviewStatus(pr({}, [[user("kim"), "CHANGES_REQUESTED"], [user("kim"), "DISMISSED"]])).state, "commented");
});

test("approved, and ready to merge only when clean and not a draft", () => {
  const ok = reviewStatus(pr({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }, [[user("kim"), "APPROVED"], [user("kim"), "COMMENTED"]]));
  assert.equal(ok.state, "approved");
  assert.deepEqual(ok.reviewers, [{ login: "kim", state: "APPROVED" }]);
  assert.equal(ok.ready, true);
  assert.equal(reviewStatus(pr({ reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" }, [[user("kim"), "APPROVED"]])).ready, false, "a required check still failing");
  assert.equal(reviewStatus(pr({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", isDraft: true }, [[user("kim"), "APPROVED"]])).ready, false);
  // under branch protection that wants two, one approval is not yet the approval
  assert.equal(reviewStatus(pr({ reviewDecision: "REVIEW_REQUIRED" }, [[user("kim"), "APPROVED"]])).state, "commented");
});

test("approved with conflicts", () => {
  const s = reviewStatus(pr({ reviewDecision: "APPROVED", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, [[user("kim"), "APPROVED"]]));
  assert.equal(s.state, "approved");
  assert.equal(s.conflicts, true);
  assert.equal(s.ready, false);
  assert.equal(reviewStatus(pr({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).conflicts, false, "not yet computed is not a conflict");
});

test("merged and closed", () => {
  assert.equal(reviewStatus(pr({ state: "MERGED" }, [[user("kim"), "APPROVED"]])).state, "merged");
  assert.equal(reviewStatus(pr({ state: "CLOSED" })).state, "closed");
});

test("one query for every PR, and its answer read back per PR", () => {
  const keys = ["lyytioy/lyyti-classic#8315", "lyytioy/other#7", "lyytioy/lyyti-classic#8250", "bad repo#1", "lyytioy/lyyti-classic#x"];
  const q = prQuery(keys);
  assert.match(q, /r0: repository\(owner: "lyytioy", name: "lyyti-classic"\) \{ p8315: pullRequest\(number: 8315\).*p8250: pullRequest\(number: 8250\)/s);
  assert.match(q, /r1: repository\(owner: "lyytioy", name: "other"\) \{ p7: /);
  assert.doesNotMatch(q, /bad repo|number: x/);
  // GitHub answers what it can and nulls the rest
  const got = parseAnswer(keys, JSON.stringify({ data: { r0: { p8315: pr(), p8250: null }, r1: { p7: pr({ state: "MERGED" }) } }, errors: [{ message: "not found" }] }));
  assert.deepEqual([...got.keys()], ["lyytioy/lyyti-classic#8315", "lyytioy/other#7"]);
  assert.equal(parseAnswer(keys, "not json").size, 0);
});

test("a failed read keeps the previous answer and marks it stale", async () => {
  const answers = [
    JSON.stringify({ data: { r0: { p1: pr({}, [[user("kim"), "COMMENTED"]]), p2: pr() } } }),
    JSON.stringify({ data: { r0: { p1: null, p2: pr({ reviewDecision: "APPROVED" }, [[user("kim"), "APPROVED"]]) } } }),
    "",
  ];
  const asked: string[] = [];
  const cache = new ReviewCache(async (q) => (asked.push(q), answers.shift() as string));
  const keys = ["o/r#1", "o/r#2"];
  assert.equal(cache.get("o/r#1"), null);
  await cache.refresh(keys);
  assert.equal(cache.get("o/r#1")?.state, "commented");
  await cache.refresh(keys);
  assert.deepEqual([cache.get("o/r#1")?.state, cache.get("o/r#1")?.stale], ["commented", true]);
  assert.deepEqual([cache.get("o/r#2")?.state, cache.get("o/r#2")?.stale], ["approved", false]);
  await cache.refresh(keys);
  assert.deepEqual([cache.get("o/r#2")?.state, cache.get("o/r#2")?.stale], ["approved", true], "gh failing outright");
  assert.equal(asked.length, 3, "one call per refresh, whatever the number of PRs");
});

// The badge reaches the card only for a PR in review, and the request is served from the cache.
test("the snapshot carries the review of a PR in review", { skip: macOnly }, async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  const ws = openWorkspace(dir);
  const quiet = () => {};
  transition(ws, "WEB-1", "building", {}, quiet);
  transition(ws, "WEB-1", "colleague-review", { pr: "acme/web#11", force: true }, quiet);
  transition(ws, "WEB-2", "building", { pr: "acme/web#12" }, quiet);
  let calls = 0;
  const board = await serve(ws, {
    host: "127.0.0.1",
    port: 0,
    reviews: async () => (calls++, JSON.stringify({ data: { r0: { p11: pr({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }, [[user("kim"), "APPROVED"]]) } } })),
  });
  after(() => board.close());
  const snap = async () => (await (await fetch(board.url + "/api")).json()) as { tickets: { ticket: string; prs: { review: { state: string; ready: boolean } | null }[] }[] };
  for (let i = 0; i < 50 && !(await snap()).tickets.find((t) => t.ticket === "WEB-1")?.prs[0]?.review; i++) await new Promise((r) => setTimeout(r, 50));
  const s = await snap();
  const by = (k: string) => s.tickets.find((t) => t.ticket === k)?.prs[0];
  assert.deepEqual([by("WEB-1")?.review?.state, by("WEB-1")?.review?.ready], ["approved", true]);
  assert.equal(by("WEB-2")?.review, null, "a PR still being built is not read");
  for (let i = 0; i < 5; i++) await snap();
  assert.equal(calls, 1, "requests are served from the cache");
});
