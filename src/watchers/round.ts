// `factory watch round`: once an hour, facts gathered here, and the lines among them that need the
// lead left for it as one note. No model: each section says which of its lines escalate.
//
// The facts compare three views, the state store, GitHub and the live sessions, and flag what is
// out of line, plus any files [[watchers.facts]] names. A store flag that was already escalated
// says so and does not escalate again. Any other escalating line is told once, and again a day
// later while it is still there. Markers, the failures cursor and what was told move only once the
// note is written, so a round that could not tell the lead tells the next one.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fleetLines, owedNote, type Session } from "../fleet.js";
import { json } from "../gate/github.js";
import { readTail } from "../messages.js";
import { loaded } from "../scheduler/index.js";
import { allRecs, BUSY, isLocal, recPrs, WAITING_ON_LEAD, WAITING_ON_YOU } from "../state.js";
import { trackerOf } from "../tracker/read.js";
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import { git, worktreeDirty } from "../worktree.js";
import { failure, failuresLog } from "../failures.js";
import { beat, heartbeatAge, logTo, openLog, watcherGh } from "./job.js";
import { belongs, type GhPr, loadQueueState, withRecorded } from "./queue.js";
import { deliver } from "./relay.js";

export interface Facts {
  text: string;
  // false when a section could not be read, so the facts are partial
  complete: boolean;
  // the lines of text that need the lead
  escalations: string[];
  // records what this round escalated and how far it read the failures log
  commit: () => void;
}

const WORKING_S = 90 * 60;
const WAITING_S = 8 * 3600;
const LEAD_WAITING_S = 2 * 3600;
const UNREPORTED_COMMIT_S = 3 * 3600;
// Two hours at the default cadence, not three runs' worth: on a sleeping laptop launchd services a
// calendar fire about once an hour and never replays a missed one, so a shorter bound cries stale
// for a machine that is working correctly.
const queueStaleS = (ws: Workspace) => Math.max(2 * 3600, 3 * 60 * (ws.config.watchers.queueEveryMinutes ?? 15));
const ROUND_STALE_S = 130 * 60;

export function gatherFacts(ws: Workspace, at = Date.now()): Facts {
  const out: string[] = [];
  let complete = true;
  const human = ws.config.human.name;
  const markers: string[] = [];
  const reportedDir = join(ws.logsDir, "reported");
  // Keyed by item, state and since, so a flag returns the moment anything moves and stays quiet
  // while nothing does.
  const firstTime = (ticket: string, state: string, since: string) => {
    const p = join(reportedDir, `${ticket}.${state}.${since}`.replace(/\//g, "_").replace(/:/g, "-"));
    if (existsSync(p)) return false;
    markers.push(p);
    return true;
  };
  const escalations: string[] = [];
  // A read that fails is a CANNOT line in its section, which escalates. A section that throws is a
  // bug here, and makes the facts partial. `escalates` picks the section's lines that need the lead,
  // or says which parts of a line to tell.
  const section = (title: string, body: () => void, escalates: (line: string) => boolean | string[] = ALARM) => {
    out.push(`-- ${title} --`);
    const from = out.length;
    try {
      body();
    } catch (e) {
      complete = false;
      out.push(`  CANNOT read: ${(e as Error).message.split("\n")[0]}`);
    }
    for (const l of out.slice(from)) {
      const e = /CANNOT/.test(l) || escalates(l);
      for (const part of e === true ? [l.trim()] : e || []) escalations.push(`${title}: ${part}`);
    }
  };
  const lead = ws.config.agents.find((a) => a.role === "lead")?.name;

  let live: Map<string, Session> | null = null;
  let unknown = new Map<string, string>();
  section("sessions", () => {
    try {
      const f = fleetLines(ws);
      live = f.live;
      unknown = f.unknown;
      out.push(...f.lines);
    } catch (e) {
      if (!(e instanceof FactoryError)) throw e;
      out.push(`  CANNOT read sessions: ${e.message}`);
    }
  }, (l) => !!lead && l.trim().split(/\s+/)[0] === lead && /\s(not running|unknown \()/.test(l));

  const allItems = allRecs(ws);
  // ticket -> state across every record, done included, so a blocked item's named blocker can be
  // looked up even after it has reached done and left the open set below.
  const stateByTicket = new Map(allItems.map((r) => [r.ticket, r.state ?? ""]));
  const recs = allItems.filter((r) => r.state !== "done");
  section("state store", () => {
    if (!recs.length) out.push("  no open items");
    for (const r of recs) {
      const s = r.state ?? "?";
      const sinceMs = r.since ? Date.parse(r.since) : NaN;
      const age = Number.isNaN(sinceMs) ? null : Math.floor((at - sinceMs) / 1000);
      let flag = "";
      // A long working state is escalated once. A builder reading a large ticket before writing
      // anything looks the same as a stall from out here, and only asking tells them apart, so
      // asking once is right and asking every hour is noise.
      if (BUSY.has(s) && age !== null && age > WORKING_S)
        flag = firstTime(r.ticket, s, r.since!) ? "  OVER 90 MIN in a working state -- probe" : "  over 90 min (already probed, not an escalation)";
      if (s === "queued")
        flag = firstTime(r.ticket, s, r.since ?? "") ? "  QUEUED -- not dispatched" : "  queued (already reported, not an escalation)";
      if (WAITING_ON_YOU.has(s) && age !== null && age > WAITING_S)
        flag = firstTime(r.ticket, s, r.since!) ? `  waiting on ${human} over a working day` : `  waiting on ${human} (already reported, not an escalation)`;
      if (WAITING_ON_LEAD.has(s) && age !== null && age > LEAD_WAITING_S)
        flag = firstTime(r.ticket, s, r.since!) ? "  waiting on the lead over 2 h -- report, review or gate it" : "  waiting on the lead (already reported, not an escalation)";
      const sessions = live as Map<string, Session> | null;
      const note = sessions && owedNote(r, sessions, unknown);
      if (note) flag += `  ${note.label.round}: ${note.says}`;
      // Mikael, 2026-10-09: the round must check whether a blocked item is still truly blocked. A
      // blocked item that names a ticket it waits on ("held behind CL-2247 merge") stays blocked
      // silently after that ticket merges. When a named blocker has reached done, say so once, so
      // the dependent is re-dispatched rather than forgotten -- CL-2246 sat blocked for days behind
      // a dependency that had already merged.
      if (s === "blocked" && r.asked_you?.question) {
        // Any key-shaped token in the question; the done-record filter below makes over-matching
        // harmless, since a word that is not a tracked ticket is never a done record.
        const refs = [...new Set((r.asked_you.question.match(/\b[A-Z][A-Z0-9]*-[A-Za-z0-9-]+\b/g) ?? []))]
          .filter((k) => k !== r.ticket);
        const cleared = refs.filter((k) => stateByTicket.get(k) === "done");
        if (cleared.length && firstTime(r.ticket, `blocker-done:${cleared.join(",")}`, r.since ?? ""))
          flag += `  BLOCKER DONE: ${cleared.join(", ")} merged -- ${r.ticket} may no longer be blocked`;
      }
      const pr = recPrs(r).map((p) => `${p.repo ?? ""}#${p.number ?? ""}`).join(",");
      out.push(`  ${r.ticket.padEnd(12)} ${s.padEnd(17)} ${(age === null ? "?" : `${Math.floor(age / 60)}m`).padStart(6)} ` +
        `agent=${(r.agent || "-").padEnd(8)} tracker=${(isLocal(r.ticket) ? "none" : r.jira || "?").padEnd(12)} pr=${pr}${flag}`);
    }
  }, (l) => {
    // The ticket and each fresh flag on its own: the rest of the line moves every round.
    const ticket = l.trim().split(/\s+/)[0];
    return l.split(/ {2,}/).filter((p) => STORE_FLAG.test(p)).map((p) => `${ticket}: ${p}`);
  });

  section("gates: PRs on GitHub against the store", () => {
    if (!recs.length) return void out.push("  nothing open");
    // Mikael, 2026-10-16: a PR is a draft in every column but colleague review, and open there. Once
    // an item has been with colleagues its PR stays open through the fix rounds after (2026-10-15:
    // "they can be open, don't put to draft").
    const withColleagues = new Set((readTail(ws.events) as Record<string, unknown>[])
      .filter((e) => e.to === "colleague-review").map((e) => e.ticket));
    for (const repo of Object.values(ws.config.repos)) {
      const fields = "number,title,headRefName,state,isDraft,mergedAt,headRefOid,baseRefName";
      const r = watcherGh(["pr", "list", "-R", repo.remote, "--state", "all", "--limit", "40", "--json", fields]);
      const prs = json<GhPr[]>(r);
      if (!Array.isArray(prs)) {
        out.push(`  ${repo.remote}: CANNOT read PRs (${r.stderr.trim().slice(0, 80)})`);
        continue;
      }
      for (const pr of withRecorded(repo.remote, recs, prs, fields))
        for (const rec of recs) {
          const { known, match } = belongs(rec, repo.remote, pr);
          if (!match) continue;
          const st = rec.state ?? "?";
          const rp = recPrs(rec).find((p) => p.repo === repo.remote && p.number === pr.number);
          const where = `${rec.ticket}: ${repo.remote}#${pr.number}`;
          // A record that moved after the merge is the judgement already made: the ticket had more to do.
          const judged = !!pr.mergedAt && !!rec.since && Date.parse(rec.since) >= Date.parse(pr.mergedAt);
          if (pr.state === "MERGED") { if (!judged) out.push(`  ${where} is MERGED but the store says ${st} -- done judgement owed`); }
          else if (pr.state === "OPEN" && (st === "queued" || st === "building") && !known)
            out.push(`  ${where} is OPEN (draft=${pr.isDraft}) but the store says ${st} -- unreported PR?`);
          else if (pr.state === "OPEN" && rp?.head && pr.headRefOid && !pr.headRefOid.startsWith(rp.head.slice(0, 7)) && ["gate", "your-review", "colleague-review"].includes(st))
            out.push(`  ${where} head moved to ${pr.headRefOid.slice(0, 7)} while ${st} (recorded ${rp.head.slice(0, 7)}) -- frozen PR pushed?`);
          // A PR stacked on another branch waits on that one and keeps its own draft state.
          else if (pr.baseRefName !== undefined && pr.baseRefName !== repo.base) continue;
          else if (pr.state === "OPEN" && pr.isDraft === false && st !== "colleague-review" && !withColleagues.has(rec.ticket))
            out.push(`  ${where} is open while ${st} -- should be a draft until colleague review`);
          else if (pr.state === "OPEN" && pr.isDraft === true && st === "colleague-review")
            out.push(`  ${where} is a draft while colleague-review -- should be open: factory pr-open-for-review ${rec.ticket}`);
        }
    }
  }, (l) => l !== "  nothing open");

  section("branches: commits nobody reported (last 3h)", () => {
    for (const r of recs) {
      if (!r.worktree || !existsSync(r.worktree)) continue;
      const g = git(r.worktree, "log", "-1", "--format=%H %ct %s", "HEAD");
      const [sha, ct, ...msg] = g.stdout.trim().split(" ");
      if (g.status !== 0 || !sha || !ct) continue;
      const age = at / 1000 - Number(ct);
      const head = r.pr?.head;
      const reported = !!head && sha.startsWith(head.slice(0, 7));
      if (age < UNREPORTED_COMMIT_S && !reported && ["building", "fixing", "pr-open"].includes(r.state ?? ""))
        out.push(`  ${r.ticket}: ${sha.slice(0, 7)} ${Math.floor(age / 60)}m ago '${msg.join(" ").slice(0, 50)}' on ${r.agent}'s branch, not the recorded head`);
      // Tools rewrite some tracked files just by running, and [worktree] tool_written names them,
      // so a served worktree is not an hourly false alarm.
      const dirty = worktreeDirty(r.worktree, ws.config.worktree.toolWritten);
      if (dirty.length && !BUSY.has(r.state ?? ""))
        out.push(`  ${r.ticket}: worktree has uncommitted changes while ${r.state}: ${dirty.slice(0, 4).join(", ")}`);
    }
  }, () => true);

  let failuresTotal: number | null = null;
  const seenFile = join(ws.logsDir, ".watcher-failures.seen");
  section("watcher failures since the last round", () => {
    if (!existsSync(failuresLog(ws))) return void out.push("  none");
    const lines = readFileSync(failuresLog(ws), "utf8").split("\n").filter(Boolean);
    let seen = Number.parseInt(existsSync(seenFile) ? readFileSync(seenFile, "utf8") : "0", 10) || 0;
    if (lines.length < seen) seen = 0; // the log was rotated or cut
    failuresTotal = lines.length;
    if (lines.length > seen) out.push(...lines.slice(seen).map((l) => `  ${l}`));
    else out.push("  none");
  }, (l) => l !== "  none");

  section("plumbing", () => {
    const tracker = trackerOf(ws);
    if (tracker.reads) {
      const a = heartbeatAge(ws, "queue");
      out.push(a === null ? "  queue heartbeat MISSING -- has it ever read the tracker?"
        : `  queue heartbeat ${a}s ago${a > queueStaleS(ws) ? `  STALE (over ${Math.floor(queueStaleS(ws) / 60)} min: longer than a sleeping laptop explains)` : ""}`);
      // A stale heartbeat alone cannot say whether the job is not running or is running and cannot
      // reach the tracker, since an unavailable run deliberately skips the write. This separates them.
      const o = loadQueueState(ws).outcomes;
      if (o.length) {
        const down = o.filter((x) => x === "unavailable").length;
        out.push(`  queue last=${o[o.length - 1]} tracker-unavailable in last ${o.length}=${down}${down >= 4 ? "  -- the connector is failing, not the schedule" : ""}`);
      }
    }
    const a = heartbeatAge(ws, "round");
    out.push(a === null ? "  round heartbeat MISSING -- first run, or the round has never completed"
      : `  previous round heartbeat ${a}s ago${a > ROUND_STALE_S ? "  STALE (over 130 min: a round was missed or could not tell the lead)" : ""}`);
    out.push(...loaded(ws));
  });

  // Files written by something outside the factory, each a section of its own. A missing or stale
  // file is an escalation: what it would have said is unknown.
  for (const ff of ws.config.watchers.facts) {
    let title = "";
    section(`facts ${basename(ff.file)}`, () => {
      if (!existsSync(ff.file)) return void out.push("  MISSING -- whatever writes it has not run");
      const ageMin = Math.floor((at - statSync(ff.file).mtimeMs) / 60000);
      if (ff.maxAgeMinutes !== undefined && ageMin > ff.maxAgeMinutes)
        out.push(`  STALE -- written ${ageMin} min ago, over ${ff.maxAgeMinutes}`);
      for (const l of readFileSync(ff.file, "utf8").split("\n").filter((x) => x.trim()))
        out.push(`  ${l}`);
    }, (l) => {
      const t = l.trim();
      const head = /^-- (.*) --$/.exec(t);
      if (head) {
        title = head[1]!;
        return false;
      }
      if (/^(MISSING|STALE) --/.test(t)) return true;
      if (ff.escalate.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t))) return true;
      return ff.everyLineIn.some((p) => title.startsWith(p)) && !t.startsWith("(");
    });
  }

  return {
    text: out.join("\n") + "\n",
    complete,
    escalations,
    commit: () => {
      if (markers.length) mkdirSync(reportedDir, { recursive: true });
      for (const p of markers) writeFileSync(p, "");
      if (failuresTotal !== null) writeFileSync(seenFile, String(failuresTotal));
    },
  };
}

// Plumbing and the sessions: what says something is down.
const ALARM = (l: string) => /CANNOT|MISSING|STALE|FAILED|NOT (LOADED|RUNNING|SCHEDULED|INSTALLED)|connector is failing/.test(l);
// The store's own flags, each already said-once by its marker.
const STORE_FLAG = /OVER 90 MIN|QUEUED -- not dispatched|over a working day|over 2 h --|NO SESSION:|UNKNOWN:|BLOCKER DONE:/;
const REMIND_MS = 24 * 3600 * 1000;

// What the lead was told, by the line with its times and durations taken out, so a line that only
// ages is the same line. A line that leaves the facts is forgotten, so its return is news.
function toldFile(ws: Workspace) { return join(ws.logsDir, "round-told.json"); }
const keyOf = (l: string) => l.replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, "T").replace(/\d+(\.\d+)?\s?(ms|s|m|h|d|min)\b/g, "N").replace(/\s+/g, " ");

export function news(ws: Workspace, lines: string[], at = Date.now()): { lines: string[]; commit: () => void } {
  let told: Record<string, number> = {};
  try { told = JSON.parse(readFileSync(toldFile(ws), "utf8")) as Record<string, number>; } catch { /* first round, or unreadable: tell all */ }
  const next: Record<string, number> = {};
  const fresh: string[] = [];
  for (const l of lines) {
    const k = keyOf(l);
    if (k in next) continue;
    const last = told[k];
    if (last === undefined || at - last >= REMIND_MS) { fresh.push(l); next[k] = at; } else next[k] = last;
  }
  return { lines: fresh, commit: () => { mkdirSync(ws.logsDir, { recursive: true }); writeFileSync(toldFile(ws), JSON.stringify(next)); } };
}

export function runRound(ws: Workspace, opts: { factsOnly?: boolean } = {}, out: (line: string) => void = console.log): number {
  const facts = gatherFacts(ws);
  if (opts.factsOnly) {
    out(facts.text.trimEnd());
    return facts.complete ? 0 : 1;
  }
  const log = openLog(ws, "round");
  const n = news(ws, facts.escalations);
  const told = !n.lines.length || deliver(ws, `[round]\n${n.lines.join("\n")}`);
  // A note that could not be written moves nothing, so the next round tells the same lines.
  if (told) { facts.commit(); n.commit(); }
  const said = `facts=${facts.complete ? "complete" : "partial"} escalations=${facts.escalations.length} told=${told ? n.lines.length : "FAILED"}`;
  logTo(log, said);
  for (const l of n.lines) logTo(log, `  ${l}`);
  if (told && facts.complete) beat(ws, "round");
  if (!facts.complete) failure(ws, "round: the facts were partial");
  out(`round: ${said}`);
  return told && facts.complete ? 0 : 1;
}
