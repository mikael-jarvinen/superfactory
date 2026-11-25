import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { counts, dayOf, daysEnding, pacing, peopleRank, type Person, type Pr, readCache, refreshCache, report, type Review, toPr } from "../src/board/github.js";
import type { Workspace } from "../src/workspace.js";

// Reviews per day and PRs approved per day, by person. The counting is a pure function of the cached PRs.

const who = (login: string, bot = false): Person => ({ login, name: login, avatar: "", bot });
const rv = (login: string, state: string, at: string, more: Partial<Review> = {}): Review => ({ state, at, author: who(login), factory: false, ...more });
const pr = (over: Partial<Pr>): Pr => ({
  repo: "classic", number: 1, title: "t", url: "u", created: "2026-11-10T08:00:00Z", ready: null, merged: null, closed: null,
  state: "OPEN", draft: false, updated: "2026-11-20T08:00:00Z", author: who("author"), reviews: [], ...over,
});
const NOW = new Date("2026-11-20T10:00:00Z");

test("days are Helsinki days, across midnight and the end of summer time", () => {
  // 22:30 UTC is 00:30 the next day in Helsinki (UTC+2 in winter)
  assert.equal(dayOf("2026-11-19T22:30:00Z"), "2026-11-20");
  assert.equal(dayOf("2026-11-19T21:59:59Z"), "2026-11-19");
  // summer time (UTC+3): 21:30 UTC is already the next day
  assert.equal(dayOf("2026-07-01T21:30:00Z"), "2026-07-02");
  // the days around the October change are each listed once
  assert.deepEqual(daysEnding(new Date("2026-10-26T12:00:00Z"), 3), ["2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.deepEqual(daysEnding(NOW, 7), ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
});

test("PR traffic: opened, merged, closed unmerged and open at each day's end, by repo", () => {
  const prs = [
    pr({ number: 1, created: "2026-11-18T06:00:00Z", merged: "2026-11-19T22:30:00Z", closed: "2026-11-19T22:30:00Z", state: "MERGED" }), // merged after Helsinki midnight: the 20th
    pr({ number: 2, created: "2026-11-18T07:00:00Z", closed: "2026-11-19T10:00:00Z", state: "CLOSED" }),
    pr({ number: 3, created: "2026-11-01T07:00:00Z" }), // opened before the range, still open
    pr({ number: 4, repo: "portal", created: "2026-11-19T07:00:00Z" }),
    pr({ number: 5, repo: "events", created: "2026-11-19T07:00:00Z" }), // not selected
  ];
  const r = report(prs, { days: 3, repos: ["classic", "portal"], bots: false, now: NOW });
  assert.deepEqual(r.days, ["2026-11-18", "2026-11-19", "2026-11-20"]);
  assert.deepEqual(r.traffic.opened.classic, [2, 0, 0]);
  assert.deepEqual(r.traffic.opened.portal, [0, 1, 0]);
  assert.deepEqual(r.traffic.merged.classic, [0, 0, 1]);
  assert.deepEqual(r.traffic.closed.classic, [0, 1, 0]);
  // #3 every day; #1 until its merge on the 20th; #2 until it closed on the 19th
  assert.deepEqual(r.traffic.open.classic, [3, 2, 1]);
  assert.deepEqual(r.traffic.open.portal, [0, 1, 1]);
  assert.equal(r.traffic.opened.events, undefined, "an unselected repo is not counted");
  assert.equal(r.prs, 4);
});

test("only human reviews count: bots, the factory's replies and the author's own are left out", () => {
  const p = pr({ reviews: [
    rv("lundis", "APPROVED", "2026-11-19T09:00:00Z"),
    rv("coderabbitai[bot]", "COMMENTED", "2026-11-19T09:00:00Z", { author: who("coderabbitai[bot]", true) }),
    rv("mikael", "COMMENTED", "2026-11-19T09:00:00Z", { factory: true }),
    rv("author", "COMMENTED", "2026-11-19T09:00:00Z"),
    rv("kim", "PENDING", "2026-11-19T09:00:00Z"),
  ] });
  assert.deepEqual(p.reviews.map((r) => counts(r, p, false)), [true, false, false, false, false]);
  assert.deepEqual(p.reviews.map((r) => counts(r, p, true)), [true, true, true, false, false], "the toggle brings back bots and the factory, never the author");
  const humans = report([p], { days: 2, repos: ["classic"], bots: false, now: NOW });
  assert.deepEqual(humans.people.map((x) => x.login), ["lundis"]);
  const all = report([p], { days: 2, repos: ["classic"], bots: true, now: NOW });
  assert.deepEqual(all.people.map((x) => x.login).sort(), ["coderabbitai[bot]", "lundis", "mikael"]);
});

test("reviews, approvals and changes requested per day, grouped by person: one review per reviewer, PR and day", () => {
  const prs = [
    pr({ number: 1, reviews: [rv("lundis", "APPROVED", "2026-11-19T09:00:00Z"), rv("kim", "CHANGES_REQUESTED", "2026-11-19T21:30:00Z"), rv("kim", "APPROVED", "2026-11-20T08:00:00Z")] }),
    // Lundis comments, replies twice in threads and approves on the 20th: one review, an approval
    pr({ number: 2, reviews: [rv("lundis", "COMMENTED", "2026-11-20T08:00:00Z"), rv("lundis", "COMMENTED", "2026-11-20T08:05:00Z"), rv("lundis", "COMMENTED", "2026-11-20T08:10:00Z"),
      rv("lundis", "APPROVED", "2026-11-20T09:00:00Z"), rv("lundis", "DISMISSED", "2026-11-01T09:00:00Z")] }),
    // three thread replies on one day: one review, a comment
    pr({ number: 3, reviews: [rv("kim", "COMMENTED", "2026-11-19T10:00:00Z"), rv("kim", "COMMENTED", "2026-11-19T11:00:00Z"), rv("kim", "COMMENTED", "2026-11-19T12:00:00Z")] }),
  ];
  const r = report(prs, { days: 2, repos: ["classic"], bots: false, now: NOW });
  // kim's 21:30 UTC change request is the 19th's 23:30 in Helsinki
  assert.deepEqual(r.reviews.reviews, { lundis: [1, 1], kim: [2, 1] });
  assert.deepEqual(r.reviews.approvals, { lundis: [1, 1], kim: [0, 1] });
  assert.deepEqual(r.reviews.changes, { kim: [1, 0] });
  assert.deepEqual(r.people.map((p) => [p.login, p.reviews, p.approvals, p.changes, p.comments]), [["kim", 3, 1, 1, 1], ["lundis", 2, 2, 0, 0]], "the review before the range is not counted");
});

test("medians run from opening, or from the first undrafting, to the first human review and to merge", () => {
  const prs = [
    // opened ready: 2 h to Lundis, 10 h to merge
    pr({ number: 1, created: "2026-11-19T06:00:00Z", merged: "2026-11-19T16:00:00Z", closed: "2026-11-19T16:00:00Z",
      reviews: [rv("coderabbitai", "COMMENTED", "2026-11-19T06:30:00Z", { author: who("coderabbitai", true) }), rv("lundis", "APPROVED", "2026-11-19T08:00:00Z")] }),
    // opened as a draft on the 10th, ready on the 19th: timed from ready; a review before it does not count
    pr({ number: 2, created: "2026-11-10T06:00:00Z", ready: "2026-11-19T06:00:00Z", merged: "2026-11-19T10:00:00Z", closed: "2026-11-19T10:00:00Z",
      reviews: [rv("kim", "COMMENTED", "2026-11-12T06:00:00Z"), rv("kim", "APPROVED", "2026-11-19T10:00:00Z")] }),
    // still a draft: not started
    pr({ number: 3, created: "2026-11-19T06:00:00Z", draft: true, reviews: [rv("kim", "COMMENTED", "2026-11-19T07:00:00Z")] }),
  ];
  const r = report(prs, { days: 7, repos: ["classic"], bots: false, now: NOW });
  assert.deepEqual(r.medians, { firstReviewHours: 3, firstReviewN: 2, mergeHours: 7, mergeN: 2 });
});

test("a PR from GitHub: opened as a draft when its first draft event made it ready, the factory's replies marked", () => {
  const raw = {
    number: 8763, title: "AI plan", url: "u", createdAt: "2026-11-10T06:00:00Z", updatedAt: "2026-11-20T06:00:00Z", mergedAt: null, closedAt: null, state: "OPEN", isDraft: false,
    author: { login: "mikael-jarvinen", __typename: "User", avatarUrl: "a", name: "Mikael" },
    timelineItems: { nodes: [{ __typename: "ReadyForReviewEvent", createdAt: "2026-11-18T06:00:00Z" }] },
    reviews: { nodes: [
      { state: "COMMENTED", submittedAt: "2026-11-19T06:00:00Z", body: "", author: { login: "Lundis", __typename: "User", avatarUrl: "b", name: null } },
      { state: "COMMENTED", submittedAt: "2026-11-19T07:00:00Z", body: "> Written by agent.\n\nFixed.", author: { login: "mikael-jarvinen", __typename: "User", avatarUrl: "a", name: "Mikael" } },
      { state: "APPROVED", submittedAt: "2026-11-19T08:00:00Z", body: "LGTM", author: { login: "copilot-pull-request-reviewer", __typename: "Bot", avatarUrl: "c" } },
      { state: "PENDING", submittedAt: null, body: "", author: { login: "kim", __typename: "User", avatarUrl: "d", name: "Kim" } },
    ] },
  };
  const p = toPr("lyytioy/lyyti-classic", raw, new Set(["coderabbitai"]));
  assert.equal(p.ready, "2026-11-18T06:00:00Z");
  assert.deepEqual(p.reviews.map((r) => [r.author?.login, r.author?.name, r.factory, r.author?.bot]), [
    ["Lundis", "Lundis", false, false],
    ["mikael-jarvinen", "Mikael", true, false],
    ["copilot-pull-request-reviewer", "copilot-pull-request-reviewer", false, true],
  ], "a pending review has no submittedAt and is left out");
  const converted = toPr("r", { ...raw, timelineItems: { nodes: [{ __typename: "ConvertToDraftEvent", createdAt: "2026-11-12T06:00:00Z" }] } }, new Set());
  assert.equal(converted.ready, null, "opened ready and converted later: timed from opening");
});

test("a PR a bot opened is traffic only with bots shown, and a person's review of it counts either way", () => {
  const prs = [pr({ number: 1, created: "2026-11-19T08:00:00Z" }),
    pr({ number: 2, created: "2026-11-19T08:00:00Z", author: who("dependabot", true), reviews: [rv("slipslop", "APPROVED", "2026-11-19T09:00:00Z")] })];
  const off = report(prs, { days: 2, repos: ["classic"], bots: false, now: NOW });
  assert.deepEqual(off.traffic.opened.classic, [1, 0]);
  assert.deepEqual(off.reviews.approvals, { slipslop: [1, 0] }, "a human approving dependabot's PR is a human review");
  assert.deepEqual(report(prs, { days: 2, repos: ["classic"], bots: true, now: NOW }).traffic.opened.classic, [2, 0]);
});

// GitHub's secondary rate limit refuses a run of heavy searches; a refused page waits and is asked again,
// and a first read also takes the open PRs nobody touched in the window.
test("the fetch pages, waits out a rate-limited page, reads open PRs the first time, and only what changed after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-gh-"));
  try {
    const was = { ...pacing };
    Object.assign(pacing, { pageMs: 0, limitedMs: 0 });
    const ws = { logsDir: dir, config: { github: { bots: [] } } } as unknown as Workspace;
    const node = (number: number, updatedAt: string) => ({ number, title: "t", url: "u", createdAt: "2026-11-01T08:00:00Z", updatedAt, mergedAt: null, closedAt: null, state: "OPEN", isDraft: false,
      author: { login: "a", __typename: "User", avatarUrl: "", name: "A" }, timelineItems: { nodes: [] }, reviews: { nodes: [] } });
    const page = (nodes: unknown[], next?: string) => JSON.stringify({ data: { search: { issueCount: nodes.length, pageInfo: { hasNextPage: !!next, endCursor: next ?? "" }, nodes } } });
    const asked: string[] = [];
    let refusals = 1;
    const gql = async (_q: string, v: Record<string, string>) => {
      asked.push(`${v.q} ${v.after ?? ""}`.trim());
      if (refusals-- > 0) return JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] });
      if (v.q?.includes("is:open")) return page([node(9, "2026-01-01T08:00:00Z")]);
      return v.after ? page([node(2, "2026-11-19T08:00:00Z")]) : page([node(1, "2026-11-19T08:00:00Z")], "c1");
    };
    const now = new Date("2026-11-20T10:00:00Z");
    const first = await refreshCache(ws, ["o/r"], gql, now);
    assert.deepEqual(first.failed, []);
    assert.deepEqual(Object.keys(readCache(ws).repos["o/r"]!.prs).sort(), ["1", "2", "9"]);
    assert.match(asked[0]!, /^repo:o\/r is:pr updated:2026-08-15T10:00:00Z\.\.2026-08-25T10:00:00Z$/, "97 days back the first time, ten days a step");
    assert.equal(asked.filter((a) => a.includes("updated:") && !a.includes("is:open") && !a.includes(" c1")).length, 11, "ten steps, the first asked twice");
    assert.equal(asked[0], asked[1], "the refused page is asked again");
    assert.ok(asked.some((a) => a.includes("is:open")));
    asked.length = 0;
    await refreshCache(ws, ["o/r"], gql, new Date("2026-11-20T10:30:00Z"));
    assert.match(asked[0]!, /updated:2026-11-20T09:55:00Z\.\.2026-11-20T10:30:00Z$/, "then only since the last read, five minutes back");
    assert.ok(!asked.some((a) => a.includes("is:open")));
    Object.assign(pacing, was);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read stops while the fleet's GraphQL points run low, and goes on from the same step later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-gh-"));
  try {
    const was = { ...pacing };
    Object.assign(pacing, { pageMs: 0, limitedMs: 0 });
    const ws = { logsDir: dir, config: { github: { bots: [] } } } as unknown as Workspace;
    let remaining = 100;
    const asked: string[] = [];
    const gql = async (_q: string, v: Record<string, string>) => {
      asked.push(v.q ?? "");
      return JSON.stringify({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [] }, rateLimit: { remaining, resetAt: "2026-11-20T11:00:00Z" } } });
    };
    const now = new Date("2026-11-20T10:00:00Z");
    const r = await refreshCache(ws, ["o/a", "o/b"], gql, now);
    assert.equal(r.failed.length, 2);
    assert.match(r.failed[0]!, /^o\/a \(paused with 100 GraphQL points left, under the 1500 kept for the fleet; goes on after 2026-11-20T11:00:00Z\)$/);
    assert.match(r.failed[1]!, /^o\/b \(paused/, "the next repo is not even asked");
    assert.equal(asked.length, 1);
    assert.equal(readCache(ws).repos["o/a"]!.fetched, "2026-08-15T10:00:00.000Z", "the step it stopped in is not counted as read");
    remaining = 4000;
    asked.length = 0;
    const later = await refreshCache(ws, ["o/a"], gql, now);
    assert.deepEqual(later.failed, []);
    assert.match(asked[0]!, /updated:2026-08-15T10:00:00Z\.\./, "it goes on from the same step");
    assert.equal(readCache(ws).repos["o/a"]!.complete, true);
    Object.assign(pacing, was);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PR traffic and review traffic also show the lines changed.
test("lines changed: merged PRs' additions plus deletions per day by repo, and each review counts its PR's size", () => {
  const prs = [
    pr({ number: 1, merged: "2026-11-19T10:00:00Z", closed: "2026-11-19T10:00:00Z", state: "MERGED", additions: 120, deletions: 30,
      reviews: [rv("lundis", "COMMENTED", "2026-11-19T08:00:00Z"), rv("lundis", "APPROVED", "2026-11-19T09:00:00Z"), rv("kim", "APPROVED", "2026-11-20T08:00:00Z")] }),
    pr({ number: 2, merged: "2026-11-19T22:30:00Z", closed: "2026-11-19T22:30:00Z", state: "MERGED", additions: 5, deletions: 5 }), // the 20th in Helsinki
    pr({ number: 3, repo: "portal", merged: "2026-11-20T08:00:00Z", closed: "2026-11-20T08:00:00Z", state: "MERGED", additions: 1000, deletions: 0 }),
    pr({ number: 4, closed: "2026-11-19T10:00:00Z", state: "CLOSED", additions: 999, deletions: 999 }), // closed unmerged: no lines merged
    pr({ number: 5, merged: "2026-11-19T10:00:00Z", closed: "2026-11-19T10:00:00Z", state: "MERGED", additions: undefined, deletions: undefined }), // read before lines were
  ];
  const r = report(prs, { days: 2, repos: ["classic", "portal"], bots: false, now: NOW });
  assert.deepEqual(r.traffic.lines, { classic: [150, 10], portal: [0, 1000] });
  assert.deepEqual(r.traffic.added, { classic: [120, 5], portal: [0, 1000] });
  assert.deepEqual(r.traffic.deleted, { classic: [30, 5], portal: [0, 0] });
  // Lundis's two reviews of #1 on the 19th are one review: its 150 lines once
  assert.deepEqual(r.reviews.lines, { lundis: [150, 0], kim: [0, 150] });
  assert.deepEqual(r.people.map((p) => [p.login, p.lines]), [["kim", 150], ["lundis", 150]]);
});

test("a cache read before lines were is read again from the start, keeping its PRs meanwhile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-gh-"));
  try {
    const was = { ...pacing };
    Object.assign(pacing, { pageMs: 0, limitedMs: 0 });
    const ws = { logsDir: dir, config: { github: { bots: [] } } } as unknown as Workspace;
    const { writeFileSync } = await import("node:fs");
    const old = { repos: { "o/r": { fetched: "2026-11-20T09:00:00.000Z", complete: true, prs: { 7: pr({ repo: "o/r", number: 7 }) } } } };
    writeFileSync(join(dir, "github-analytics.json"), JSON.stringify(old));
    const asked: string[] = [];
    const gql = async (_q: string, v: Record<string, string>) => {
      asked.push(v.q ?? "");
      return JSON.stringify({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [] }, rateLimit: { remaining: 5000 } } });
    };
    await refreshCache(ws, ["o/r"], gql, new Date("2026-11-20T10:00:00Z"));
    assert.match(asked[0]!, /updated:2026-08-15T10:00:00Z\.\./, "from the start of the kept window, not from the last read");
    assert.ok(asked.some((a) => a.includes("is:open")), "and the old open PRs again");
    const c = readCache(ws);
    assert.equal(c.version, 2);
    assert.ok(c.repos["o/r"]!.prs[7], "the PRs it had stay until read again");
    asked.length = 0;
    await refreshCache(ws, ["o/r"], gql, new Date("2026-11-20T10:30:00Z"));
    assert.match(asked[0]!, /updated:2026-11-20T09:55:00Z\.\./, "once upgraded, only what changed");
    Object.assign(pacing, was);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a page GitHub's gateway gives up on (HTTP 502) is asked again at half the size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-gh-"));
  try {
    const was = { ...pacing };
    Object.assign(pacing, { pageMs: 0, limitedMs: 0, failedMs: 0 });
    const ws = { logsDir: dir, config: { github: { bots: [] } } } as unknown as Workspace;
    const sizes: string[] = [];
    const gql = async (_q: string, v: Record<string, string>) => {
      if (v.q?.includes("is:open")) return JSON.stringify({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [] } } });
      sizes.push(v.first ?? "");
      if (Number(v.first) > 25) return JSON.stringify({ errors: [{ message: "HTTP 502" }] });
      return JSON.stringify({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [] } } });
    };
    const r = await refreshCache(ws, ["o/r"], gql, new Date("2026-08-20T10:00:00Z"));
    assert.deepEqual(r.failed, []);
    assert.deepEqual(sizes.slice(0, 3), ["100", "50", "25"]);
    Object.assign(pacing, was);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PR traffic colours its columns by repo, and can also be viewed by PR author.
test("PR traffic by author: the same counts per PR author, adding up to the repo totals, and an author table", () => {
  const prs = [
    pr({ number: 1, author: who("niilo"), created: "2026-11-18T06:00:00Z", merged: "2026-11-19T10:00:00Z", closed: "2026-11-19T10:00:00Z", state: "MERGED", additions: 100, deletions: 20 }),
    pr({ number: 2, author: who("niilo"), repo: "portal", created: "2026-11-19T07:00:00Z" }),
    pr({ number: 3, author: who("sami"), created: "2026-11-18T07:00:00Z", closed: "2026-11-20T10:00:00Z", state: "CLOSED" }),
    pr({ number: 4, author: who("kim"), created: "2026-11-01T07:00:00Z" }), // opened before the range, still open
    pr({ number: 5, author: null, created: "2026-11-20T07:00:00Z" }), // a deleted account
    pr({ number: 6, author: who("dependabot", true), created: "2026-11-19T07:00:00Z" }),
  ];
  const r = report(prs, { days: 3, repos: ["classic", "portal"], bots: false, now: NOW });
  assert.deepEqual(r.byAuthor.opened, { niilo: [1, 1, 0], sami: [1, 0, 0], ghost: [0, 0, 1] });
  assert.deepEqual(r.byAuthor.merged, { niilo: [0, 1, 0] });
  assert.deepEqual(r.byAuthor.closed, { sami: [0, 0, 1] });
  assert.deepEqual(r.byAuthor.lines, { niilo: [0, 120, 0] });
  assert.deepEqual(r.byAuthor.added, { niilo: [0, 100, 0] });
  assert.deepEqual(r.byAuthor.open, { niilo: [1, 1, 1], sami: [1, 1, 0], kim: [1, 1, 1], ghost: [0, 0, 1] });
  // grouped by author or by repo, every metric adds up the same each day
  const total = (per: Record<string, number[]>) => r.days.map((_, i) => Object.values(per).reduce((a, v) => a + (v[i] ?? 0), 0));
  for (const m of ["opened", "merged", "closed", "open", "lines", "added", "deleted"] as const)
    assert.deepEqual(total(r.byAuthor[m]), total(r.traffic[m]), m);
  // the table: the range's own PRs per author, most opened first; kim's only PR predates the range
  assert.deepEqual(r.authors.map((a) => [a.login, a.opened, a.merged, a.closed, a.lines, a.added, a.deleted]), [
    ["niilo", 2, 1, 0, 120, 100, 20], ["ghost", 1, 0, 0, 0, 0, 0], ["sami", 1, 0, 1, 0, 0, 0], ["kim", 0, 0, 0, 0, 0, 0],
  ]);
  // with bots shown, the bot's PR is traffic and an author like anyone's
  const withBots = report(prs, { days: 3, repos: ["classic", "portal"], bots: true, now: NOW });
  assert.deepEqual(withBots.byAuthor.opened.dependabot, [0, 1, 0]);
  assert.equal(Object.hasOwn(r.byAuthor.opened, "dependabot"), false, "bots hidden: not an author either");
});

// One colour per person across PR and review traffic, by one rank of both.
test("people rank: PRs opened plus reviews that count, bots' PRs only with bots shown", () => {
  const prs = [
    pr({ number: 1, author: who("niilo"), reviews: [rv("lundis", "APPROVED", "2026-11-19T09:00:00Z"), rv("niilo", "COMMENTED", "2026-11-19T09:30:00Z")] }),
    pr({ number: 2, author: who("niilo") }),
    pr({ number: 3, author: who("sami"), reviews: [rv("lundis", "COMMENTED", "2026-11-19T10:00:00Z"), rv("kim", "APPROVED", "2026-11-19T11:00:00Z")] }),
    pr({ number: 4, author: who("dependabot", true), reviews: [rv("kim", "APPROVED", "2026-11-19T12:00:00Z")] }),
  ];
  // niilo: 2 PRs (the reply on their own PR is no review); lundis: 2 reviews; kim: 2 reviews; sami: 1 PR
  assert.deepEqual(peopleRank(prs, false), ["kim", "lundis", "niilo", "sami"]);
  assert.deepEqual(peopleRank(prs, true), ["kim", "lundis", "niilo", "dependabot", "sami"]);
});
