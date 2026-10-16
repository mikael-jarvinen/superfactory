// `factory pr-send <repo> <n> <reviewed-sha>`: the last gate before the human sees a link.
//
// `pr-ready` answers about the head it reads; this asks what it cannot: is the head still the sha
// somebody reviewed, before and after the gate. It leaves the PR as it is. Mikael, 2026-10-16: "Only
// when they are in my colleagues review column should they be open PRs", so a PR stays a draft
// through his review and is opened by `factory pr-open-for-review` when it goes to colleagues.
import type { Repo } from "../config.js";
import { allRecs, recPrs } from "../state.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, sleep } from "../util.js";
import { headOf, prView } from "./github.js";
import { ready, report, type Verdict } from "./ready.js";

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

// The ticket the PR belongs to, from the state store, else a key leading the title.
function ticketOf(ws: Workspace, repo: Repo, n: number, title: string): string {
  for (const r of allRecs(ws)) if (recPrs(r).some((p) => p.repo === repo.remote && p.number === n)) return r.ticket;
  return /^[A-Z][A-Z0-9]+-\d+/.exec(title)?.[0] ?? "?";
}

// The gate, read again while every failure is one time clears, the way pr-wait waits: a check
// running, a status pending, mergeability not computed. A merge into the base makes GitHub recompute
// every open PR's mergeability and read UNKNOWN until it has, so a read that lands in that window is
// not an answer. Returns the first verdict that is sendable, on another head, or failing on
// something time will not clear, else the last one once `waited` reaches the limit.
function gateWaiting(ws: Workspace, repo: Repo, n: number, before: string, w: { waited: number; limit: number; poll: number }): Verdict {
  for (;;) {
    const v = ready(ws, repo, n);
    if (v.sendable || v.head !== before || w.waited >= w.limit || v.failures.some((f) => f.kind !== "waits")) return v;
    sleep(w.poll * 1000);
    w.waited += w.poll;
  }
}

export function send(ws: Workspace, repo: Repo, n: number, reviewed: string, out: (line: string) => void = console.log): void {
  checkReviewed(reviewed, "pr-send");
  const before = headOf(repo, n);
  if (!before) throw refused(`cannot read the head of ${repo.remote}#${n}`);
  if (!before.startsWith(reviewed))
    throw refused(`head ${before} is not the reviewed sha ${reviewed}. Somebody pushed after the review. ` +
      "Get the delta reviewed (factory delta-range), then run this again with the new sha.");

  const w = { waited: 0, limit: seconds("FACTORY_SEND_LIMIT", 900), poll: seconds("FACTORY_SEND_POLL", 20) };
  const v = gateWaiting(ws, repo, n, before, w);
  for (const l of report(v)) out(l);
  if (!v.sendable) throw refused("pr-ready did not pass");
  if (v.head !== before) throw refused(`head moved from ${before} to ${v.head} while the gate read it`);
  const after = headOf(repo, n);
  if (after !== before) throw refused(`head moved from ${before} to ${after ?? "(unreadable)"} after the gate passed`);
  const pr = prView(repo, n);
  out(`SENDABLE  ${repo.remote}#${n}  head ${before}  reviewed ${reviewed}`);
  out(pr?.url ?? `https://github.com/${repo.remote}/pull/${n}`);
  out(`push text: PR ready: ${ticketOf(ws, repo, n, pr?.title ?? "")} ${repo.remote.split("/")[1]}#${n}`);
}
