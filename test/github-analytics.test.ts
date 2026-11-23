import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { counts, dayOf, daysEnding, pacing, type Person, type Pr, readCache, refreshCache, report, type Review, toPr } from "../src/board/github.js";
import type { Workspace } from "../src/workspace.js";

// Mikael, 2026-11-23: "how many reviews happen per day, how many PRs get approved per day and
// grouped by person." The counting is a pure function of the cached PRs.

const who = (login: string, bot = false): Person => ({ login, name: login, avatar: "", bot });
const rv = (login: string, state: string, at: string, more: Partial<Review> = {}): Review => ({ state, at, author: who(login), reply: false, factory: false, ...more });
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

test("only human reviews count: bots, the factory's replies, thread replies and the author's own are left out", () => {
  const p = pr({ reviews: [
    rv("lundis", "APPROVED", "2026-11-19T09:00:00Z"),
    rv("coderabbitai[bot]", "COMMENTED", "2026-11-19T09:00:00Z", { author: who("coderabbitai[bot]", true) }),
    rv("mikael", "COMMENTED", "2026-11-19T09:00:00Z", { factory: true }),
    rv("kim", "COMMENTED", "2026-11-19T09:00:00Z", { reply: true }),
    rv("author", "COMMENTED", "2026-11-19T09:00:00Z"),
    rv("kim", "PENDING", "2026-11-19T09:00:00Z"),
  ] });
  assert.deepEqual(p.reviews.map((r) => counts(r, p, false)), [true, false, false, false, false, false]);
  assert.deepEqual(p.reviews.map((r) => counts(r, p, true)), [true, true, true, false, false, false], "the toggle brings back bots and the factory, never a thread reply or the author");
  const humans = report([p], { days: 2, repos: ["classic"], bots: false, now: NOW });
  assert.deepEqual(humans.people.map((x) => x.login), ["lundis"]);
  const all = report([p], { days: 2, repos: ["classic"], bots: true, now: NOW });
  assert.deepEqual(all.people.map((x) => x.login).sort(), ["coderabbitai[bot]", "lundis", "mikael"]);
});

test("reviews, approvals and changes requested per day, grouped by person", () => {
  const prs = [
    pr({ number: 1, reviews: [rv("lundis", "APPROVED", "2026-11-19T09:00:00Z"), rv("kim", "CHANGES_REQUESTED", "2026-11-19T21:30:00Z"), rv("kim", "APPROVED", "2026-11-20T08:00:00Z")] }),
    pr({ number: 2, reviews: [rv("lundis", "COMMENTED", "2026-11-20T08:00:00Z"), rv("lundis", "APPROVED", "2026-11-20T09:00:00Z"), rv("lundis", "DISMISSED", "2026-11-01T09:00:00Z")] }),
  ];
  const r = report(prs, { days: 2, repos: ["classic"], bots: false, now: NOW });
  // kim's 21:30 UTC change request is the 19th's 23:30 in Helsinki
  assert.deepEqual(r.reviews.reviews, { lundis: [1, 2], kim: [1, 1] });
  assert.deepEqual(r.reviews.approvals, { lundis: [1, 1], kim: [0, 1] });
  assert.deepEqual(r.reviews.changes, { kim: [1, 0] });
  assert.deepEqual(r.people.map((p) => [p.login, p.reviews, p.approvals, p.changes, p.comments]), [["lundis", 3, 2, 0, 1], ["kim", 2, 1, 1, 0]], "the review before the range is not counted");
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

test("a PR from GitHub: opened as a draft when its first draft event made it ready, thread replies and factory replies marked", () => {
  const raw = {
    number: 8763, title: "AI plan", url: "u", createdAt: "2026-11-10T06:00:00Z", updatedAt: "2026-11-20T06:00:00Z", mergedAt: null, closedAt: null, state: "OPEN", isDraft: false,
    author: { login: "mikael-jarvinen", __typename: "User", avatarUrl: "a", name: "Mikael" },
    timelineItems: { nodes: [{ __typename: "ReadyForReviewEvent", createdAt: "2026-11-18T06:00:00Z" }] },
    reviews: { nodes: [
      { state: "COMMENTED", submittedAt: "2026-11-19T06:00:00Z", body: "", author: { login: "Lundis", __typename: "User", avatarUrl: "b", name: null }, comments: { nodes: [{ body: "agreed", replyTo: { id: "x" } }] } },
      { state: "COMMENTED", submittedAt: "2026-11-19T07:00:00Z", body: "", author: { login: "mikael-jarvinen", __typename: "User", avatarUrl: "a", name: "Mikael" }, comments: { nodes: [{ body: "> Written by agent.\n\nFixed.", replyTo: { id: "y" } }] } },
      { state: "APPROVED", submittedAt: "2026-11-19T08:00:00Z", body: "LGTM", author: { login: "copilot-pull-request-reviewer", __typename: "Bot", avatarUrl: "c" }, comments: { nodes: [] } },
      { state: "PENDING", submittedAt: null, body: "", author: { login: "kim", __typename: "User", avatarUrl: "d", name: "Kim" } },
    ] },
  };
  const p = toPr("lyytioy/lyyti-classic", raw, new Set(["coderabbitai"]));
  assert.equal(p.ready, "2026-11-18T06:00:00Z");
  assert.deepEqual(p.reviews.map((r) => [r.author?.login, r.author?.name, r.reply, r.factory, r.author?.bot]), [
    ["Lundis", "Lundis", true, false, false],
    ["mikael-jarvinen", "Mikael", true, true, false],
    ["copilot-pull-request-reviewer", "copilot-pull-request-reviewer", false, false, true],
  ], "a pending review has no submittedAt and is left out");
  const converted = toPr("r", { ...raw, timelineItems: { nodes: [{ __typename: "ConvertToDraftEvent", createdAt: "2026-11-12T06:00:00Z" }] } }, new Set());
  assert.equal(converted.ready, null, "opened ready and converted later: timed from opening");
});

test("a PR a bot opened is traffic only with bots shown", () => {
  const prs = [pr({ number: 1, created: "2026-11-19T08:00:00Z" }), pr({ number: 2, created: "2026-11-19T08:00:00Z", author: who("dependabot", true) })];
  assert.deepEqual(report(prs, { days: 2, repos: ["classic"], bots: false, now: NOW }).traffic.opened.classic, [1, 0]);
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
