// `factory watch queue`: on the scheduler's cadence, tell the lead about new work in the tracker's
// queue and about fresh merges it owes a done judgement for.
//
// The model does the one thing only a session can: read the tracker through the connector. It is
// handed no state, runs no commands and messages nobody. Everything after the read is here: the
// set difference against the last run and the state store, the merged PRs from fixed `gh` calls,
// and the delivery, which goes by the courier and only when something is new.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gh, json } from "../gate/github.js";
import { allRecs, branchFor, isLocal, type Rec, recPrs } from "../state.js";
import { parseRead, trackerOf, UNAVAILABLE } from "../tracker/read.js";
import type { Workspace } from "../workspace.js";
import { dockerWatchdog } from "./docker.js";
import { beat, failure, heartbeatAge, heartbeatPath, loadPrompt, logTo, openLog, runClaude } from "./job.js";
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

const MERGE_WINDOW_MS = 3 * 3600_000;

// Merges in the last three hours that belong to an open record and were not reported before.
function merges(ws: Workspace, recs: Rec[], reported: string[]): { lines: string[]; urls: string[] } {
  const lines: string[] = [];
  const urls: string[] = [];
  const open = recs.filter((r) => r.state !== "done");
  if (!open.length) return { lines, urls };
  for (const repo of Object.values(ws.config.repos)) {
    const prs = json<GhPr[]>(gh("pr", "list", "-R", repo.remote, "--state", "merged", "--limit", "10", "--json", "number,title,url,mergedAt,headRefName"));
    if (!Array.isArray(prs)) {
      failure(ws, `queue: cannot read the merged PRs of ${repo.remote}`);
      continue;
    }
    for (const pr of prs) {
      const at = Date.parse(pr.mergedAt ?? "");
      if (!pr.url || reported.includes(pr.url) || urls.includes(pr.url) || !(Date.now() - at <= MERGE_WINDOW_MS)) continue;
      const rec = open.find((r) => belongs(r, repo.remote, pr).match);
      if (!rec) continue;
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
    for (const k of fresh) lines.push(`queued: ${k}${read.summaries[k] ? ` ${read.summaries[k]}` : ""}`);
  }
  const m = merges(ws, recs, prev.merged);
  lines.push(...m.lines);
  const stale = roundStale(ws);
  if (stale) lines.push(stale.line);
  const docker = dockerWatchdog(ws);
  if (docker) lines.push(docker);

  // What was not delivered is not recorded as told, so the next run says it again.
  const delivered = lines.length ? deliver(ws, ["[queue watcher]", ...lines].join("\n")) : true;
  if (delivered) stale?.told();
  const outcome = r.status !== 0 ? "failed" : read?.outcome === "read" ? (lines.length ? "reported" : "quiet") : (read?.outcome ?? "failed");
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
  if (r.status !== 0) failure(ws, `queue FAILED exit=${r.status}`);
  else if (read?.outcome === "off-contract") failure(ws, `queue READ NOTHING: no QUEUE: line and no ${UNAVAILABLE} sentinel`);
  for (const l of lines) out(l);
  out(`queue: ${outcome}`);
  return outcome === "failed" || outcome === "off-contract" || !delivered ? 1 : 0;
}
