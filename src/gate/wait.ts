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
// A review bot that skipped or paused a draft, or has posted nothing at the head, reviews nothing
// until asked, so it asks: it posts the gate's trigger comment once per head, and never over an ask
// the bot has not answered or before its rate limit says a review is available, then waits for the
// review like any other. An ask posted by hand counts. Once asked, a bot that has posted nothing at
// the head yet is waited on for the gate's grace from the ask.
//
// Exit codes: 1 not sendable, 2 the gate could not be read, 3 still waiting at the limit, 4 green
// but held on prose.
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, sleep } from "../util.js";
import { conversation, gh, holdAsk, Unreadable } from "./github.js";
import { type Failure, graceS, ready } from "./ready.js";
import { checkReviewed, seconds, send } from "./send.js";

export const ACCEPT_PROSE = "FACTORY_ACCEPT_PROSE";

const stop = (code: number, msg: string) => new FactoryError(`pr-wait: ${msg}`, code);

export function waitAndSend(ws: Workspace, repo: Repo, n: number, reviewed: string, err: (line: string) => void = console.error): void {
  checkReviewed(reviewed, "pr-wait");
  const limit = seconds("FACTORY_WAIT_LIMIT", 1800);
  const poll = seconds("FACTORY_WAIT_POLL", 30);
  const retries = seconds("FACTORY_WAIT_RETRIES", 5);
  const started = Date.now();
  let misses = 0;
  let last = "";
  for (;;) {
    let unread = "";
    let waiting: string[] = [];
    try {
      const v = ready(ws, repo, n);
      if (!v.head.startsWith(reviewed)) throw stop(1, `head ${v.head} is not the reviewed sha ${reviewed} -- get the delta reviewed`);
      if (v.sendable) {
        if (v.prose && !process.env[ACCEPT_PROSE])
          throw stop(4, `gate is green but not sending:\n  - ${v.prose}\n  trim the comments, or rerun with ${ACCEPT_PROSE}=1 if the volume is right`);
        break;
      }
      // Asked at this head within the grace, or holding the ask, is a wait, timed from the ask.
      const asked = new Set<Failure>();
      for (const f of v.failures) {
        const body = f.trigger ?? f.asked;
        if (!body) continue;
        const a = askOnce(ws, repo, n, v.head, body, err);
        if (f.asked && (a.held || (a.since ?? Infinity) < graceS())) asked.add(f);
      }
      const fatal = v.failures.filter((f) => f.kind === "fatal" && !f.trigger && !asked.has(f));
      if (fatal.length) throw stop(1, `NOT SENDABLE, and waiting will not clear it:\n${fatal.map((f) => `  - ${f.text}`).join("\n")}`);
      unread = v.failures.find((f) => f.kind === "unreadable")?.text ?? "";
      waiting = v.failures.map((f) => f.text);
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      unread = e.message;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (unread) {
      if (++misses > retries) throw stop(2, `cannot read the gate after ${retries} retries -- ${unread}`);
    } else {
      misses = 0;
      if (elapsed >= limit) throw stop(3, `still waiting after ${elapsed}s on:\n${waiting.map((w) => `  - ${w}`).join("\n")}`);
      const now = waiting.join("; ");
      if (now !== last) err(`pr-wait: waiting (${elapsed}s) on: ${now}`);
      last = now;
    }
    sleep(poll * 1000);
  }
  // Outside the loop's catch: a send that fails part way must not be retried as though it were a
  // read that failed.
  send(ws, repo, n, reviewed);
}

// Asks the review bot for a review of the head, once: not when it was asked at this head already, in
// any form and by anyone, and not while holdAsk says no. Says how long ago it was asked, or why not.
function askOnce(ws: Workspace, repo: Repo, n: number, head: string, body: string, err: (line: string) => void): { since?: number; held?: string } {
  const login = ws.config.gate.reviewBot ?? body.replace(/^@(\S+).*$/, "$1");
  const talk = conversation(repo, n, head, login);
  if (!talk) throw new Unreadable(`cannot read whether "${body}" was already asked at ${head.slice(0, 7)}`);
  if (talk.lastAsk !== undefined) return { since: Math.round((Date.now() - talk.lastAsk) / 1000) };
  const held = holdAsk(talk);
  if (held) return { held };
  const r = gh("pr", "comment", String(n), "--repo", repo.remote, "--body", body);
  if (r.status !== 0) throw stop(1, `could not post "${body}" -- ${r.stderr.trim() || r.stdout.trim()}`);
  err(`pr-wait: posted "${body}" to ask for a review of ${head.slice(0, 7)}`);
  return { since: 0 };
}
