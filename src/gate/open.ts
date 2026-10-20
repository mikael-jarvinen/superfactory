// `factory pr-open-for-review <TICKET>`: open the item's PRs for colleague review, then record it.
//
// Mikael, 2026-10-16: "Only when they are in my colleagues review column should they be open PRs."
// Every PR stays a draft through the factory's rounds and his own review, and this is where it
// leaves draft. Every open PR on the record is checked before any is opened: its head must still be
// the sha that was reviewed. The record moves to colleague-review only once all of them are open.
import { releaseForReview } from "../stacks/engine.js";
import { loadRec, recPrs, transition } from "../state.js";
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import { gh, prView, resolveRepo } from "./github.js";

const refused = (msg: string) => new FactoryError(`pr-open-for-review: REFUSED -- ${msg}`);

export function openForReview(ws: Workspace, ticket: string, out: (line: string) => void = console.log): void {
  const rec = loadRec(ws, ticket);
  if (!rec) throw refused(`no record for ${ticket}`);
  if (rec.state !== "your-review" && rec.state !== "colleague-review")
    throw refused(`${ticket} is ${rec.state}; a PR goes to colleagues from your-review`);
  const open: { remote: string; n: number; draft: boolean }[] = [];
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
    else open.push({ remote: p.repo, n: p.number, draft: pr.isDraft });
  }
  if (bad.length) throw refused(`nothing opened:\n${bad.map((b) => `  ${b}`).join("\n")}`);
  if (!open.length) throw refused(`${ticket} has no open PR on its record`);
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
