// `factory pr-open-for-review <TICKET>`: open the item's PRs for colleague review, then record it.
//
// A PR is open only in the colleague-review column. A PR stays a draft until its item reaches undrafting(ws). Where that is colleague-review, this is
// where it leaves draft; with [gate] colleague_review = false it is your-review, undrafted by hand, and
// this refuses. Every open PR on the record is checked before any is opened: its head must still be
// the sha that was reviewed, and the review bot must have reviewed that head (reviewbot.ts: it asks and
// waits, rate limits included). The record moves to colleague-review only once all of them are open.
import { releaseForReview } from "../stacks/engine.js";
import { COLLEAGUE_REVIEW_OFF, loadRec, recPrs, transition, undrafting } from "../state.js";
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import { api, gh, prDiff, prView, resolveRepo } from "./github.js";
import { waitForBotReview } from "./reviewbot.js";
import { translationsAt } from "./translations.js";

const refused = (msg: string) => new FactoryError(`pr-open-for-review: REFUSED -- ${msg}`);

export function openForReview(ws: Workspace, ticket: string, out: (line: string) => void = console.log): void {
  if (undrafting(ws) !== "colleague-review") throw refused(`${COLLEAGUE_REVIEW_OFF}; nothing opened`);
  const rec = loadRec(ws, ticket);
  if (!rec) throw refused(`no record for ${ticket}`);
  if (rec.state !== "your-review" && rec.state !== "colleague-review")
    throw refused(`${ticket} is ${rec.state}; a PR goes to colleagues from your-review`);
  const open: { remote: string; n: number; draft: boolean; head: string }[] = [];
  const bad: string[] = [];
  for (const p of recPrs(rec)) {
    if (!p.repo || !p.number) continue;
    const where = `${p.repo}#${p.number}`;
    const repo = resolveRepo(ws, p.repo);
    const pr = prView(repo, p.number);
    if (!pr) {
      bad.push(`${where}: cannot read it`);
      continue;
    }
    // an earlier slice of the item, already merged or closed
    if (pr.state !== "OPEN") continue;
    // stacked on another PR's branch: it waits for that one and stays as it is
    if (pr.baseRefName !== repo.base) {
      out(`${where} is stacked on ${pr.baseRefName}, not ${repo.base}; left as it is`);
      continue;
    }
    if (!p.reviewed_sha) bad.push(`${where}: the record has no reviewed sha for it`);
    else if (!pr.headRefOid.startsWith(p.reviewed_sha))
      bad.push(`${where}: head ${pr.headRefOid.slice(0, 7)} is not the reviewed sha ${p.reviewed_sha.slice(0, 7)}`);
    else {
      // The same translations check as pr-ready, asked again here, so a PR that never went through
      // pr-send cannot reach colleagues without its texts either.
      const diff = prDiff(repo, p.number, pr.baseRefName, pr.headRefOid);
      const cmp = api<{ merge_base_commit?: { sha?: string } }>(`repos/${repo.remote}/compare/${pr.baseRefName}...${pr.headRefOid}`);
      const t = translationsAt(repo, pr.headRefOid, cmp?.merge_base_commit?.sha ?? pr.baseRefName, diff.status === 0 ? diff.stdout : undefined);
      const problems = [...t.failures, ...t.unreadable];
      if (problems.length) bad.push(`${where}: ${problems.join("; ")}`);
      else {
        out(`${where}: ${t.remark}`);
        open.push({ remote: p.repo, n: p.number, draft: pr.isDraft, head: pr.headRefOid });
      }
    }
  }
  if (bad.length) throw refused(`nothing opened:\n${bad.map((b) => `  ${b}`).join("\n")}`);
  if (!open.length) throw refused(`${ticket} has no open PR on its record`);
  // The review bot's review of every head first, so none opens while another still waits for it.
  for (const x of open) {
    let head: string;
    try {
      head = waitForBotReview(ws, resolveRepo(ws, x.remote), x.n, out);
    } catch (e) {
      if (!(e instanceof FactoryError)) throw e;
      throw new FactoryError(`pr-open-for-review: REFUSED -- nothing opened, ${ticket} stays ${rec.state}: ${e.message}`, e.code);
    }
    if (head !== x.head) throw refused(`nothing opened: ${x.remote}#${x.n} moved from ${x.head.slice(0, 7)} to ${head.slice(0, 7)} while waiting for its review`);
  }
  for (const x of open) {
    if (!x.draft) {
      out(`${x.remote}#${x.n} is already open`);
      continue;
    }
    if (gh("pr", "ready", String(x.n), "--repo", x.remote).status !== 0)
      throw refused(`could not open ${x.remote}#${x.n}; ${ticket} stays ${rec.state}`);
    out(`${x.remote}#${x.n} opened for review`);
  }
  if (rec.state === "your-review")
    transition(ws, ticket, "colleague-review", { evidence: `opened for colleague review: ${open.map((x) => `${x.remote}#${x.n}`).join(", ")}` }, out);
  releaseForReview(ws, ticket, out);
}
