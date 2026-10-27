// `factory watch queue`: on the scheduler's cadence, tell the lead about new work in the tracker's
// queue and about fresh merges it owes a done judgement for.
//
// The model does the one thing only a session can: read the tracker through the connector. It is
// handed no state, runs no commands and messages nobody. Everything after the read is here: the
// set difference against the last run and the state store, the merged PRs from fixed `gh` calls,
// and the delivery, which goes by the courier and only when something is new.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { json } from "../gate/github.js";
import { allRecs, branchFor, isLocal, type Rec, recPrs, saveRec, transition } from "../state.js";
import { parseRead, trackerOf, UNAVAILABLE } from "../tracker/read.js";
import { squash } from "../util.js";
import type { Workspace } from "../workspace.js";
import { dockerWatchdog } from "./docker.js";
import { beat, failure, heartbeatAge, heartbeatPath, loadPrompt, logTo, openLog, runClaude, runFailure, TIMED_OUT, watcherGh } from "./job.js";
import { deliver } from "./relay.js";

// What the last runs left: the queue keys already seen, the merge urls already reported, and the
// last few outcomes, which the round reads to tell a failing connector from a stopped schedule.
export interface QueueState {
  known: string[];
  merged: string[];
  outcomes: string[];
}

export const queueStateFile = (ws: Workspace) => join(ws.logsDir, "queue.state");

export function loadQueueState(ws: Workspace): QueueState {
  try {
    const d = JSON.parse(readFileSync(queueStateFile(ws), "utf8")) as Partial<QueueState>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { known: list(d.known), merged: list(d.merged), outcomes: list(d.outcomes) };
  } catch {
    return { known: [], merged: [], outcomes: [] };
  }
}

export interface GhPr {
  number: number;
  title: string;
  headRefName: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  mergedAt?: string | null;
  headRefOid?: string;
  baseRefName?: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Does this PR belong to this record? A PR the record lists is matched by number; `known` says so.
// The name match is for PRs nobody recorded: a tracker key in the branch or at the head of the
// title, and for a local key, whose key never reaches GitHub, the branch it was given.
export function belongs(rec: Rec, remote: string, pr: GhPr): { known: boolean; match: boolean } {
  const known = recPrs(rec).some((p) => p.repo === remote && p.number === pr.number);
  const k = rec.ticket;
  const named = isLocal(k)
    ? pr.headRefName === branchFor(k)
    : new RegExp(`(^|[^A-Z0-9-])${escape(k)}(?![0-9])`).test(pr.headRefName) || pr.title.startsWith(`${k} `) || pr.title.startsWith(`${k}:`);
  return { known, match: known || named };
}

// `gh pr list` returns the newest PRs by creation, so in a busy repo a PR opened days before it
// merged is never among them: lyyti-classic#8428 and #8429 merged on 2026-10-26 behind 52 newer
// PRs, and neither watcher said so. Every PR the store records for these records is read by number.
export function withRecorded(remote: string, recs: Rec[], listed: GhPr[], fields: string): GhPr[] {
  const have = new Set(listed.map((p) => p.number));
  const numbers = new Set(recs.flatMap(recPrs).filter((p) => p.repo === remote && typeof p.number === "number" && !have.has(p.number)).map((p) => p.number as number));
  const read = [...numbers].map((n) => json<GhPr>(watcherGh(["pr", "view", String(n), "-R", remote, "--json", fields])));
  return [...listed, ...read.filter((p): p is GhPr => typeof p?.number === "number")];
}

const MERGE_WINDOW_MS = 3 * 3600_000;
const MERGED_FIELDS = "number,title,url,mergedAt,headRefName";

// Merges that belong to an open record and were not reported before: a recorded PR's until the
// record moves past it, a PR matched only by name in the last three hours.
function merges(ws: Workspace, recs: Rec[], reported: string[], log: string): { lines: string[]; urls: string[] } {
  const lines: string[] = [];
  const urls: string[] = [];
  const open = recs.filter((r) => r.state !== "done");
  if (!open.length) return { lines, urls };
  for (const repo of Object.values(ws.config.repos)) {
    const r = watcherGh(["pr", "list", "-R", repo.remote, "--state", "merged", "--limit", "10", "--json", MERGED_FIELDS]);
    const prs = json<GhPr[]>(r);
    if (!Array.isArray(prs)) {
      const timedOut = r.status === TIMED_OUT;
      if (timedOut) logTo(log, `${repo.remote}: ${r.stderr}`);
      if (!r.slept) failure(ws, `queue: cannot read the merged PRs of ${repo.remote}${timedOut ? `: ${r.stderr}` : ""}`);
    }
    for (const pr of withRecorded(repo.remote, open, Array.isArray(prs) ? prs : [], MERGED_FIELDS)) {
      const at = Date.parse(pr.mergedAt ?? "");
      if (!pr.url || reported.includes(pr.url) || urls.includes(pr.url) || Number.isNaN(at)) continue;
      const rec = open.find((r) => belongs(r, repo.remote, pr).known) ?? open.find((r) => belongs(r, repo.remote, pr).match);
      if (!rec) continue;
      const judged = !!rec.since && Date.parse(rec.since) >= at;
      if (belongs(rec, repo.remote, pr).known ? judged : Date.now() - at > MERGE_WINDOW_MS) continue;
      lines.push(`merged: ${rec.ticket} ${repo.remote.split("/").pop()}#${pr.number} ${pr.url}`);
      urls.push(pr.url);
    }
  }
  return { lines, urls };
}

// Three hours, not two. The round is an hourly calendar job and launchd never replays a fire it
// slept through, so on a closed lid it manages one run per wake window at best and misses some.
// Three hours is at least two misses in a row, which is a real signal rather than a sleeping laptop.
const ROUND_STALE_S = 3 * 3600;

// Said once per outage, not once per run: a stale round is usually the connector being down, which
// can last a day. The marker is newer than the heartbeat only while the same outage continues, so a
// round that succeeds moves the heartbeat past it and re-arms this for the next one.
function roundStale(ws: Workspace): { line: string; told: () => void } | null {
  const age = heartbeatAge(ws, "round");
  if (age === null || age <= ROUND_STALE_S) return null;
  const told = join(ws.logsDir, ".round-stale.told");
  if (existsSync(told) && statSync(told).mtimeMs >= statSync(heartbeatPath(ws, "round")).mtimeMs) return null;
  return {
    line: `round STALE: heartbeat ${Math.floor(age / 60)} min old; the round has stopped, or could not read the tracker or its facts`,
    told: () => writeFileSync(told, ""),
  };
}

export function runQueue(ws: Workspace, out: (line: string) => void = console.log): number {
  const tracker = trackerOf(ws);
  if (!tracker.reads) {
    out(`no queue to watch: [tracker] kind is ${ws.config.tracker.kind}`);
    return 0;
  }
  const prompt = `${loadPrompt(ws, "queue")}\n\n${tracker.instructions(ws)}\n`;
  const log = openLog(ws, "queue");
  const r = runClaude(ws, "queue", prompt, ["ToolSearch", ...tracker.tools], log);
  const read = r.status === 0 ? parseRead(ws, r.stdout) : null;

  const prev = loadQueueState(ws);
  const recs = allRecs(ws);
  const byKey = new Map(recs.map((x) => [x.ticket, x]));
  const lines: string[] = [];
  let fresh: string[] = [];
  if (read?.outcome === "read") {
    // New is a queue key with no record, or a record still queued, that no earlier run has seen. A
    // key in any other state is handled.
    fresh = read.keys.filter((k) => {
      const rec = byKey.get(k);
      return (!rec || rec.state === "queued") && !prev.known.includes(k);
    });
    // Give the card a title the moment the ticket appears, so the board never shows a bare key: the
    // tracker summary is only in reach while the ticket is still in the queue, so stamp it now. A
    // ticket with no record yet gets a queued one; one already recorded without a title gets it set.
    for (const k of fresh) {
      const summary = read.summaries[k];
      if (summary) {
        const rec = byKey.get(k);
        if (!rec) transition(ws, k, "queued", { title: summary }, () => {});
        else if (!rec.title) saveRec(ws, { ...rec, title: squash(summary, 90) });
      }
      lines.push(`queued: ${k}${summary ? ` ${summary}` : ""}`);
    }
  }
  const m = merges(ws, recs, prev.merged, log);
  lines.push(...m.lines);
  const stale = roundStale(ws);
  if (stale) lines.push(stale.line);
  const docker = dockerWatchdog(ws);
  if (docker) lines.push(docker);

  // What was not delivered is not recorded as told, so the next run says it again.
  const delivered = lines.length ? deliver(ws, ["[queue watcher]", ...lines].join("\n")) : true;
  if (delivered) stale?.told();
  const outcome = r.slept ? "slept" : r.status !== 0 ? "failed" : read?.outcome === "read" ? (lines.length ? "reported" : "quiet") : (read?.outcome ?? "failed");
  const state: QueueState = {
    known: read?.outcome === "read" ? read.keys.filter((k) => delivered || !fresh.includes(k)) : prev.known,
    merged: delivered ? [...prev.merged, ...m.urls].slice(-50) : prev.merged,
    outcomes: [...prev.outcomes, outcome].slice(-8),
  };
  writeFileSync(queueStateFile(ws), JSON.stringify(state) + "\n");
  logTo(log, `outcome=${outcome}${lines.length ? ` delivered=${delivered}` : ""}`);

  // The heartbeat needs positive evidence that the tracker was read, so an outage, a failed run and
  // a run that went off contract all leave the last healthy run's heartbeat where it was.
  if (read?.outcome === "read") beat(ws, "queue");
  const failed = r.status !== 0 ? runFailure("queue", r) : null;
  if (failed) failure(ws, failed);
  else if (r.status === 0 && read?.outcome === "off-contract") failure(ws, `queue READ NOTHING: no QUEUE: line and no ${UNAVAILABLE} sentinel`);
  for (const l of lines) out(l);
  out(`queue: ${outcome}`);
  return outcome === "failed" || outcome === "off-contract" || !delivered ? 1 : 0;
}
