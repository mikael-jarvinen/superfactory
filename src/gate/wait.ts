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
// Exit codes: 1 not sendable, 2 the gate could not be read, 3 still waiting at the limit, 4 green
// but held on prose.
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, sleep } from "../util.js";
import { Unreadable } from "./github.js";
import { ready } from "./ready.js";
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
      const v = ready(ws, repo, n, { allowDraft: true });
      if (!v.head.startsWith(reviewed)) throw stop(1, `head ${v.head} is not the reviewed sha ${reviewed} -- get the delta reviewed`);
      if (v.sendable) {
        if (v.prose && !process.env[ACCEPT_PROSE])
          throw stop(4, `gate is green but not sending:\n  - ${v.prose}\n  trim the comments, or rerun with ${ACCEPT_PROSE}=1 if the volume is right`);
        break;
      }
      const fatal = v.failures.filter((f) => f.kind === "fatal");
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
