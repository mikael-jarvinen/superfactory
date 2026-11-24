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
// Exit codes: 1 not sendable, 2 the gate could not be read, 3 still waiting at the limit, 4 green
// but held on prose.
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, sleep } from "../util.js";
import { api, gh, Unreadable } from "./github.js";
import { graceS, ready } from "./ready.js";
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
      // Asked at this head and not answered yet is a wait, timed from the ask (lyyti-classic#8522, #8524).
      const asked = new Set(v.failures.filter((f) => f.asked && (sinceAsked(repo, n, v.head, f.asked) ?? Infinity) < graceS()));
      const fatal = v.failures.filter((f) => f.kind === "fatal" && !f.trigger && !asked.has(f));
      if (fatal.length) throw stop(1, `NOT SENDABLE, and waiting will not clear it:\n${fatal.map((f) => `  - ${f.text}`).join("\n")}`);
      for (const f of v.failures) if (f.trigger) askOnce(repo, n, v.head, f.trigger, err);
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

// When the trigger was last asked after the head commit, from an earlier run or by hand.
function askedAt(repo: Repo, n: number, head: string, body: string): string | undefined {
  const at = api<{ commit?: { committer?: { date?: string } } }>(`repos/${repo.remote}/commits/${head}`)?.commit?.committer?.date;
  const comments = at ? api<{ body?: string; created_at?: string }[]>(`repos/${repo.remote}/issues/${n}/comments?since=${at}&per_page=100`) : undefined;
  if (!at || !Array.isArray(comments)) throw new Unreadable(`cannot read whether "${body}" was already asked at ${head.slice(0, 7)}`);
  return comments.filter((c) => c.body?.trim() === body && (c.created_at ?? "") > at).map((c) => c.created_at as string).sort().at(-1);
}

// Seconds since the trigger was asked at this head, or undefined when it was not.
function sinceAsked(repo: Repo, n: number, head: string, body: string): number | undefined {
  const at = askedAt(repo, n, head, body);
  return at ? Math.round((Date.now() - Date.parse(at)) / 1000) : undefined;
}

// Posts the trigger unless it was already asked at this head.
function askOnce(repo: Repo, n: number, head: string, body: string, err: (line: string) => void): void {
  if (askedAt(repo, n, head, body)) return;
  const r = gh("pr", "comment", String(n), "--repo", repo.remote, "--body", body);
  if (r.status !== 0) throw stop(1, `could not post "${body}" -- ${r.stderr.trim() || r.stdout.trim()}`);
  err(`pr-wait: posted "${body}" to ask for a review of ${head.slice(0, 7)}`);
}
