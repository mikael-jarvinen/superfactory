// The review bot's review of a PR's current head, waited for before the PR opens for colleagues:
// `factory pr-open-for-review` runs it for every PR on the item, and `factory pr-wait-coderabbit
// <repo> <n>` runs it alone, for a PR opened by hand (a stacked one).
//
// Mikael, 2026-11-24, after lyyti-classic#8878 and #8879 were opened for colleagues before CodeRabbit
// had read their final heads, and it left 12 findings on PRs colleagues were already reading: what
// reaches him may go without its review (his 2026-11-12 decision stands for pr-ready, pr-wait and
// pr-send), but nothing opens for colleagues until it has reviewed the head.
//
// So this asks: "@coderabbitai review", and "@coderabbitai full review" when the incremental one
// brings nothing within the gate's grace (it reviews only commits since its last review). A rate
// limit is waited out: CodeRabbit queues nothing while limited and its docs say to ask again "once
// capacity is restored" (docs.coderabbit.ai/management/rate-limits), so it asks again every
// FACTORY_REVIEW_RETRY seconds (900), polls every FACTORY_REVIEW_POLL (120), and gives up at
// FACTORY_REVIEW_WAIT_LIMIT (7200): the account's limit is one review an hour.
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, sleep } from "../util.js";
import { type CheckRun, checkRuns, conversation, gh, prView, reviews, statuses, Unreadable } from "./github.js";
import { graceS, NOT_A_REVIEW, RATE_LIMITED, REVIEWED_RUN, reviewBotOf } from "./ready.js";
import { seconds } from "./send.js";

export interface BotReview {
  head: string;
  // the bot reviewed this head, or no review bot is configured
  reviewed: boolean;
  // what is outstanding, in words
  text: string;
  // the comment to post now: never asked at this head, or a rate limit's ask old enough to repeat
  post?: string;
  // waiting cannot clear it
  fatal?: boolean;
}

// One read of where the bot stands at the PR's head. Throws Unreadable when a read fails.
export function botReview(ws: Workspace, repo: Repo, n: number): BotReview {
  const pr = prView(repo, n);
  if (!pr) throw new Unreadable(`cannot read PR #${n} from ${repo.remote}, or it returned no head sha`);
  const head = pr.headRefOid;
  const short = head.slice(0, 7);
  const login = ws.config.gate.reviewBot;
  if (!login) return { head, reviewed: true, text: "no review bot is configured" };
  const bot = reviewBotOf(login);
  const isBotRun = (c: CheckRun) => c.app?.slug === login || c.name.toLowerCase() === bot.status.toLowerCase();

  const runs = checkRuns(repo, head);
  if (runs === undefined) throw new Unreadable(`cannot read the check-runs at ${short}`);
  const sts = statuses(repo, head);
  if (sts === undefined) throw new Unreadable(`cannot read the commit statuses at ${short}`);
  const st = sts.find((s) => s.context.toLowerCase() === bot.status.toLowerCase());
  const desc = st?.description ?? "-";
  const run = runs.filter(isBotRun).sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "")).at(-1);

  // Reviewed: its status says so, its own check-run finished (a rebase it had already reviewed posts
  // no review object, lyyti-events#847), or a review with a body at this head (its thread replies are
  // empty review objects, lyyti-classic#8705).
  if (st?.state === "success" && !NOT_A_REVIEW.test(desc)) return { head, reviewed: true, text: `${bot.status} reviewed ${short}` };
  if (!st && run?.status === "completed" && run.conclusion === "success" && REVIEWED_RUN.test(run.output?.title ?? ""))
    return { head, reviewed: true, text: `${bot.status} reviewed ${short}` };
  if (st?.state === "pending") return { head, reviewed: false, text: `${bot.status} is reviewing ${short} (${desc})` };
  if (run && run.status !== "completed") return { head, reviewed: false, text: `${bot.status} is reviewing ${short} (its check here is ${run.status})` };
  const rs = reviews(repo, n);
  if (rs === undefined) throw new Unreadable(`cannot read the reviews of #${n}`);
  if (rs.some((r) => (r.user?.login ?? "").replace(/\[bot\]$/, "") === login && r.commit_id === head && !!r.body?.trim()))
    return { head, reviewed: true, text: `${bot.status} reviewed ${short}` };

  if (!bot.trigger) return { head, reviewed: false, fatal: true, text: `${bot.status} has not reviewed ${short} -- ${bot.ask}` };
  const talk = conversation(repo, n, head, login);
  if (!talk) throw new Unreadable(`cannot read the comments of #${n} since ${short}`);
  const ago = (body?: string) => {
    const t = body ? talk.asked.get(body) : undefined;
    return t === undefined ? undefined : Math.round((Date.now() - t) / 1000);
  };

  // Rate limited: its latest word, by status, check-run or a reply, is the limit, with nothing asked
  // since. An ask made after it is waited on as an ask; limited again, it says so again.
  const limitedAt = Math.max(
    st && RATE_LIMITED.test(desc) ? Date.parse(st.created_at ?? "") || 1 : 0,
    run && RATE_LIMITED.test(run.output?.title ?? "") ? Date.parse(run.started_at ?? "") || 1 : 0,
    talk.limitedAt ?? 0,
  );
  const lastAsk = Math.max(0, ...talk.asked.values());
  const asked = ago(bot.trigger);
  if (limitedAt > 0 && limitedAt >= lastAsk) {
    const text = `${bot.status} is rate limited and has not reviewed ${short}`;
    return { head, reviewed: false, text, post: asked === undefined || asked >= seconds("FACTORY_REVIEW_RETRY", 900) ? bot.trigger : undefined };
  }
  const full = ago(bot.full);
  if (bot.full && full !== undefined)
    return full < graceS()
      ? { head, reviewed: false, text: `${bot.status} was asked for "${bot.full}" at ${short} ${full}s ago` }
      : { head, reviewed: false, fatal: true, text: `${bot.status} was asked for "${bot.full}" at ${short} ${full}s ago and has not reviewed it -- read its reply on the PR` };
  if (asked === undefined) return { head, reviewed: false, text: `${bot.status} has not reviewed ${short}`, post: bot.trigger };
  if (asked < graceS()) return { head, reviewed: false, text: `${bot.status} was asked for "${bot.trigger}" at ${short} ${asked}s ago` };
  // The incremental review brought nothing: it had nothing new to review since its last one.
  if (bot.full) return { head, reviewed: false, text: `"${bot.trigger}" brought no review of ${short} in ${asked}s`, post: bot.full };
  return { head, reviewed: false, fatal: true, text: `${bot.status} was asked for "${bot.trigger}" at ${short} ${asked}s ago and has not reviewed it` };
}

// Asks and waits until the bot has reviewed the head, and returns that head. Throws a FactoryError
// naming what is left: exit 1 when waiting cannot clear it, 2 when the reads keep failing, 3 at the
// limit.
export function waitForBotReview(ws: Workspace, repo: Repo, n: number, err: (line: string) => void = console.error): string {
  const limit = seconds("FACTORY_REVIEW_WAIT_LIMIT", 7200);
  const poll = seconds("FACTORY_REVIEW_POLL", 120);
  const retries = seconds("FACTORY_WAIT_RETRIES", 5);
  const where = `${repo.remote}#${n}`;
  const started = Date.now();
  let misses = 0;
  let last = "";
  for (;;) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    try {
      const b = botReview(ws, repo, n);
      misses = 0;
      if (b.reviewed) return b.head;
      if (b.fatal) throw new FactoryError(`${where}: ${b.text}`, 1);
      if (b.post) {
        const r = gh("pr", "comment", String(n), "--repo", repo.remote, "--body", b.post);
        if (r.status !== 0) throw new FactoryError(`${where}: could not post "${b.post}" -- ${r.stderr.trim() || r.stdout.trim()}`, 1);
        err(`${where}: posted "${b.post}" to ask for a review of ${b.head.slice(0, 7)}`);
      }
      if (elapsed >= limit) throw new FactoryError(`${where}: still waiting after ${elapsed}s: ${b.text}`, 3);
      if (b.text !== last) err(`${where}: waiting (${elapsed}s): ${b.text}`);
      last = b.text;
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      if (++misses > retries) throw new FactoryError(`${where}: cannot read the review bot's state after ${retries} retries -- ${e.message}`, 2);
    }
    sleep(poll * 1000);
  }
}
