// `factory pr-wait <repo> <n> <reviewed-sha>`: wait for the gate, then send.
//
// Waits only while every failure the gate still lists is one that time clears: a check running, a
// status pending, mergeability not computed. Anything else will not clear by waiting, so it stops at
// once naming it. The failures are the gate's own, never a second read of GitHub.
//
// It also stops before sending when the gate remarks on comment volume. The remark does not block
// `pr-ready`, but nobody reads a remark between the wait and the send, so a green gate would carry
// a comment-heavy PR straight to the human. FACTORY_ACCEPT_PROSE=1 sends anyway, for when the
// volume is right.
//
// A review bot that skipped or paused a draft reviews nothing until asked, so it asks: it posts the
// gate's trigger comment once per head, then waits for the review like any other. Once asked, a bot
// that has posted nothing at the head yet is waited on for the gate's grace from the ask.
//
// A rate-limited bot is waited out, never sent past: CodeRabbit queues nothing while limited, and its
// docs say to ask again "once capacity is restored" (docs.coderabbit.ai/management/rate-limits). So
// it asks again every FACTORY_REVIEW_RETRY seconds (900) while the bot's latest word is the limit; a
// limited ask uses up nothing. While only the review bot is outstanding it polls every
// FACTORY_REVIEW_POLL seconds (120), and it gives up at FACTORY_REVIEW_WAIT_LIMIT (7200), not the
// general limit, since the account's limit is one review an hour.
//
// Exit codes: 1 not sendable, 2 the gate could not be read, 3 still waiting at the limit, 4 green
// but held on prose.
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, sleep } from "../util.js";
import { gh, Unreadable } from "./github.js";
import { graceS, ready } from "./ready.js";
import { checkReviewed, seconds, send } from "./send.js";

export const ACCEPT_PROSE = "FACTORY_ACCEPT_PROSE";

const stop = (code: number, msg: string) => new FactoryError(`pr-wait: ${msg}`, code);

export function waitAndSend(ws: Workspace, repo: Repo, n: number, reviewed: string, err: (line: string) => void = console.error): void {
  checkReviewed(reviewed, "pr-wait");
  const limit = seconds("FACTORY_WAIT_LIMIT", 1800);
  const poll = seconds("FACTORY_WAIT_POLL", 30);
  const retries = seconds("FACTORY_WAIT_RETRIES", 5);
  const reviewLimit = seconds("FACTORY_REVIEW_WAIT_LIMIT", 7200);
  const reviewPoll = seconds("FACTORY_REVIEW_POLL", 120);
  const retryS = seconds("FACTORY_REVIEW_RETRY", 900);
  const started = Date.now();
  let misses = 0;
  let last = "";
  for (;;) {
    let unread = "";
    let waiting: string[] = [];
    let onlyReview = false;
    try {
      const v = ready(ws, repo, n);
      if (!v.head.startsWith(reviewed)) throw stop(1, `head ${v.head} is not the reviewed sha ${reviewed} -- get the delta reviewed`);
      if (v.sendable) {
        if (v.prose && !process.env[ACCEPT_PROSE])
          throw stop(4, `gate is green but not sending:\n  - ${v.prose}\n  trim the comments, or rerun with ${ACCEPT_PROSE}=1 if the volume is right`);
        break;
      }
      // Asked at this head and not answered yet is a wait, timed from the ask (lyyti-classic#8522, #8524).
      const asked = new Set(v.failures.filter((f) => f.asked && (f.askedAgo ?? Infinity) < graceS()));
      const fatal = v.failures.filter((f) => f.kind === "fatal" && !f.trigger && !asked.has(f));
      if (fatal.length) throw stop(1, `NOT SENDABLE, and waiting will not clear it:\n${fatal.map((f) => `  - ${f.text}`).join("\n")}`);
      // Once per head, or again after a rate limit once the last ask is old enough. The gate read
      // the asks already made at this head, by an earlier run or by hand.
      for (const f of v.failures)
        if (f.trigger && (f.askedAgo === undefined || (f.retry && f.askedAgo >= retryS))) ask(repo, n, v.head, f.trigger, err);
      unread = v.failures.find((f) => f.kind === "unreadable")?.text ?? "";
      waiting = v.failures.map((f) => f.text);
      onlyReview = v.failures.every((f) => f.review);
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      unread = e.message;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (unread) {
      if (++misses > retries) throw stop(2, `cannot read the gate after ${retries} retries -- ${unread}`);
    } else {
      misses = 0;
      if (elapsed >= (onlyReview ? Math.max(limit, reviewLimit) : limit)) throw stop(3, `still waiting after ${elapsed}s on:\n${waiting.map((w) => `  - ${w}`).join("\n")}`);
      const now = waiting.join("; ");
      if (now !== last) err(`pr-wait: waiting (${elapsed}s) on: ${now}`);
      last = now;
    }
    sleep((onlyReview && !unread ? Math.max(poll, reviewPoll) : poll) * 1000);
  }
  // Outside the loop's catch: a send that fails part way must not be retried as though it were a
  // read that failed.
  send(ws, repo, n, reviewed);
}

// Posts the trigger at this head.
function ask(repo: Repo, n: number, head: string, body: string, err: (line: string) => void): void {
  const r = gh("pr", "comment", String(n), "--repo", repo.remote, "--body", body);
  if (r.status !== 0) throw stop(1, `could not post "${body}" -- ${r.stderr.trim() || r.stdout.trim()}`);
  err(`pr-wait: posted "${body}" to ask for a review of ${head.slice(0, 7)}`);
}
