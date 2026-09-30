// `factory pr-comment <repo> <n> <agent> <body-file> <bot-comment-id> [--dry-run]`
//
// Reply, inside a bot's review thread, with a comment that says an agent wrote it. It can do
// nothing else. A top-level comment reads as the human arguing on their own PR, since everything the
// factory posts goes out under their token, and a colleague cannot tell which comments were theirs.
// A reply inside a bot's thread is bounded and unmistakably an answer to that bot. So there is no
// way to post a standalone comment here, and a colleague's comment is the human's to answer.
//
// <bot-comment-id> is the id of the review comment being answered, from
// `gh api repos/OWNER/REPO/pulls/N/comments` or a GraphQL reviewThreads query. The body comes from
// a file, never from an argument, so quoting cannot mangle it.
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Repo } from "../config.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, pyRepr } from "../util.js";
import { api, gh, json } from "./github.js";

export const MARKER = "> Written by agent.";

// A configured bot, as GitHub spells its login: an app account carries a [bot] suffix.
export function isBot(bots: string[], login: string): boolean {
  const bare = login.replace(/\[bot\]$/, "");
  return bots.some((b) => b === login || b === bare);
}

export interface CommentArgs {
  agent: string;
  bodyFile: string;
  replyTo: string;
  dryRun: boolean;
}

export function comment(ws: Workspace, repo: Repo, n: number, a: CommentArgs, out: (line: string) => void = console.log): void {
  const no = (msg: string) => new FactoryError(`pr-comment: ${msg}`);
  if (!/^\d+$/.test(a.replyTo))
    throw no(`${pyRepr(a.replyTo)} is not a review-comment id. The factory only replies inside a bot's review thread; it does not post standalone PR comments.`);
  if (!ws.config.agents.some((x) => x.name === a.agent)) throw no(`${pyRepr(a.agent)} is not a fleet agent`);
  if (!existsSync(a.bodyFile)) throw no(`no such body file: ${a.bodyFile}`);
  if (statSync(a.bodyFile).size === 0) throw no(`body file is empty: ${a.bodyFile}`);
  const text = `${MARKER}\n\n${readFileSync(a.bodyFile, "utf8")}`;

  // Refuse to answer a human. A colleague's point goes to the human, who answers it.
  const author = api<{ user?: { login?: string } }>(`repos/${repo.remote}/pulls/comments/${a.replyTo}`)?.user?.login;
  if (!author) throw no(`no review comment ${a.replyTo} on ${repo.remote}`);
  const bots = ws.config.github.bots;
  if (!isBot(bots, author))
    throw no(`comment ${a.replyTo} is by '${author}', who is not one of the bots in github.bots (${bots.join(", ") || "none"}). ` +
      "Reply to bot review threads only; take a colleague's point to the human instead.");

  if (a.dryRun) {
    out(`would reply to ${author} in ${repo.remote}#${n} thread ${a.replyTo} as ${a.agent}:`);
    out("---");
    out(text);
    return;
  }
  const r = gh("api", `repos/${repo.remote}/pulls/${n}/comments/${a.replyTo}/replies`, "-f", `body=${text}`);
  const posted = json<{ html_url?: string }>(r);
  if (!posted) throw no(`the reply was not posted: ${r.stderr.trim() || r.stdout.trim()}`);
  out(posted.html_url ?? "posted");
}
