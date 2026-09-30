// `factory pr-send <repo> <n> <reviewed-sha>`: the last gate before the human sees a link.
//
// `pr-ready` answers about the head it reads; this asks the two questions it cannot: is the head
// still the sha somebody reviewed, and is it STILL that sha after undrafting. Out of draft is a
// merge on sight, so if the head moves in the window, the PR goes back to draft. The window is as
// long as the reviewers the undraft itself starts take to finish.
import type { Repo } from "../config.js";
import { allRecs, recPrs } from "../state.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, sleep } from "../util.js";
import { checkRuns, gh, headOf, prView, statuses } from "./github.js";
import { ready, report } from "./ready.js";

export function seconds(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new FactoryError(`$${name} must be a number of seconds, got ${JSON.stringify(v)}`, 2);
  return n;
}

const refused = (msg: string) => new FactoryError(`pr-send: REFUSED -- ${msg}`);

export function checkReviewed(reviewed: string, cmd: string): void {
  if (!/^[0-9a-f]{7,40}$/.test(reviewed)) throw new FactoryError(`${cmd}: give the full reviewed sha, not ${reviewed}`);
}

// no check-run incomplete and no commit status pending at this sha
function settled(repo: Repo, sha: string): boolean {
  const runs = checkRuns(repo, sha);
  if (!runs || runs.some((c) => c.status !== "completed")) return false;
  const sts = statuses(repo, sha);
  return !!sts && !sts.some((s) => s.state === "pending");
}

// The ticket the PR belongs to, from the state store, else a key leading the title.
function ticketOf(ws: Workspace, repo: Repo, n: number, title: string): string {
  for (const r of allRecs(ws)) if (recPrs(r).some((p) => p.repo === repo.remote && p.number === n)) return r.ticket;
  return /^[A-Z][A-Z0-9]+-\d+/.exec(title)?.[0] ?? "?";
}

export function send(ws: Workspace, repo: Repo, n: number, reviewed: string, out: (line: string) => void = console.log): void {
  checkReviewed(reviewed, "pr-send");
  const before = headOf(repo, n);
  if (!before) throw refused(`cannot read the head of ${repo.remote}#${n}`);
  if (!before.startsWith(reviewed))
    throw refused(`head ${before} is not the reviewed sha ${reviewed}. Somebody pushed after the review. ` +
      "Get the delta reviewed (factory delta-range), then run this again with the new sha.");

  const first = ready(ws, repo, n, { allowDraft: true });
  for (const l of report(first)) out(l);
  if (!first.sendable) throw refused("pr-ready did not pass");
  if (first.head !== before) throw refused(`head moved from ${before} to ${first.head} while the gate read it`);

  const redraft = () => gh("pr", "ready", String(n), "--repo", repo.remote, "--undo");
  if (gh("pr", "ready", String(n), "--repo", repo.remote).status !== 0) throw refused(`could not undraft #${n}`);
  const fail = (msg: string) => {
    redraft();
    return refused(`${msg} Put back in draft, nothing sent.`);
  };

  const after = headOf(repo, n);
  if (after !== before) throw fail(`head moved from ${before} to ${after ?? "(unreadable)"} while undrafting.`);

  // Leaving draft is itself an event some reviewers wait for: a review bot that skips drafts starts
  // the moment the PR is ready, so its status goes pending a second after the undraft. Gating
  // straight away read that pending as red and put the PR back in draft, which cancelled the review
  // it had just triggered. So wait for whatever the undraft started, and keep watching the head.
  // A first look before the undraft's webhooks land sees the statuses of a draft and calls them
  // settled, which is how a review that has not started yet reads as one that passed.
  sleep(seconds("FACTORY_SEND_DELAY", 30) * 1000);
  const limit = seconds("FACTORY_SEND_LIMIT", 900);
  const poll = seconds("FACTORY_SEND_POLL", 20);
  let waited = 0;
  while (!settled(repo, before)) {
    if (waited >= limit) throw fail(`checks or statuses never settled after undrafting (${waited} s).`);
    sleep(poll * 1000);
    waited += poll;
    const now = headOf(repo, n);
    if (now !== before) throw fail(`head moved from ${before} to ${now ?? "(unreadable)"} while waiting for checks.`);
  }

  let last;
  try {
    last = ready(ws, repo, n);
  } catch (e) {
    throw fail(`the gate could not be read after undrafting: ${(e as Error).message}.`);
  }
  if (!last.sendable || last.head !== before) throw fail("gate went red after undrafting. Run `factory pr-ready` to see why.");
  const pr = prView(repo, n);
  out(`SENDABLE  ${repo.remote}#${n}  head ${before}  reviewed ${reviewed}`);
  out(pr?.url ?? `https://github.com/${repo.remote}/pull/${n}`);
  out(`push text: PR ready: ${ticketOf(ws, repo, n, pr?.title ?? "")} ${repo.remote.split("/")[1]}#${n}`);
}
