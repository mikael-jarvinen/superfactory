// `factory watch round`: once an hour, facts gathered here and a disposable session that decides
// whether any of them needs the lead. Fresh context by construction.
//
// The facts compare three views, the state store, GitHub and the live sessions, and flag what is
// out of line. The session reads them and the tracker, and it executes nothing: its settings are
// read-only. "Report once" cannot be an instruction to it, since it has no memory of the last run,
// so the facts carry that: a flag that was already escalated says so. Markers and the failures
// cursor move only once a round has run, so a failed round shows the same lines again.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fleetLines, type Session } from "../fleet.js";
import { gh, json } from "../gate/github.js";
import { loaded } from "../scheduler/launchd.js";
import { allRecs, BUSY, isLocal, recPrs, WAITING_ON_YOU } from "../state.js";
import { parseRead, trackerOf } from "../tracker/read.js";
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import { git, worktreeDirty } from "../worktree.js";
import { beat, failure, failuresLog, heartbeatAge, loadPrompt, logTo, openLog, runClaude } from "./job.js";
import { belongs, type GhPr, loadQueueState } from "./queue.js";
import { deliver } from "./relay.js";

export interface Facts {
  text: string;
  // false when a section could not be read, so the facts are partial
  complete: boolean;
  // records what this round escalated and how far it read the failures log
  commit: () => void;
}

const WORKING_S = 90 * 60;
const WAITING_S = 8 * 3600;
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
  // A read that fails is a CANNOT line in its section, which the session escalates. A section that
  // throws is a bug here, and makes the facts partial.
  const section = (title: string, body: () => void) => {
    out.push(`-- ${title} --`);
    try {
      body();
    } catch (e) {
      complete = false;
      out.push(`  CANNOT read: ${(e as Error).message.split("\n")[0]}`);
    }
  };

  let live: Map<string, Session> | null = null;
  section("sessions", () => {
    try {
      const f = fleetLines(ws);
      live = f.live;
      out.push(...f.lines);
    } catch (e) {
      if (!(e instanceof FactoryError)) throw e;
      out.push(`  CANNOT read sessions: ${e.message}`);
    }
  });

  const recs = allRecs(ws).filter((r) => r.state !== "done");
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
      const sessions = live as Map<string, Session> | null;
      if (BUSY.has(s) && r.agent && sessions && !sessions.has(r.agent)) flag += `  NO SESSION: ${r.agent} has no live session while ${s}`;
      const pr = recPrs(r).map((p) => `${p.repo ?? ""}#${p.number ?? ""}`).join(",");
      out.push(`  ${r.ticket.padEnd(12)} ${s.padEnd(17)} ${(age === null ? "?" : `${Math.floor(age / 60)}m`).padStart(6)} ` +
        `agent=${(r.agent || "-").padEnd(8)} tracker=${(isLocal(r.ticket) ? "none" : r.jira || "?").padEnd(12)} pr=${pr}${flag}`);
    }
  });

  section("gates: PRs on GitHub against the store", () => {
    if (!recs.length) return void out.push("  nothing open");
    for (const repo of Object.values(ws.config.repos)) {
      const r = gh("pr", "list", "-R", repo.remote, "--state", "all", "--limit", "40", "--json", "number,title,headRefName,state,isDraft,mergedAt,headRefOid");
      const prs = json<GhPr[]>(r);
      if (!Array.isArray(prs)) {
        out.push(`  ${repo.remote}: CANNOT read PRs (${r.stderr.trim().slice(0, 80)})`);
        continue;
      }
      for (const pr of prs)
        for (const rec of recs) {
          const { known, match } = belongs(rec, repo.remote, pr);
          if (!match) continue;
          const st = rec.state ?? "?";
          const rp = recPrs(rec).find((p) => p.repo === repo.remote && p.number === pr.number);
          const where = `${rec.ticket}: ${repo.remote}#${pr.number}`;
          if (pr.state === "MERGED") out.push(`  ${where} is MERGED but the store says ${st} -- done judgement owed`);
          else if (pr.state === "OPEN" && (st === "queued" || st === "building") && !known)
            out.push(`  ${where} is OPEN (draft=${pr.isDraft}) but the store says ${st} -- unreported PR?`);
          else if (pr.state === "OPEN" && rp?.head && pr.headRefOid && !pr.headRefOid.startsWith(rp.head.slice(0, 7)) && ["gate", "your-review", "colleague-review"].includes(st))
            out.push(`  ${where} head moved to ${pr.headRefOid.slice(0, 7)} while ${st} (recorded ${rp.head.slice(0, 7)}) -- frozen PR pushed?`);
          else if (pr.state === "OPEN" && pr.isDraft === false && ["pr-open", "agent-review", "fixing", "gate"].includes(st))
            out.push(`  ${where} is NOT a draft while ${st} -- undrafted early?`);
        }
    }
  });

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
  });

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
  });

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
      : `  previous round heartbeat ${a}s ago${a > ROUND_STALE_S ? "  STALE (over 130 min: a round was missed or could not read the tracker)" : ""}`);
    out.push(...loaded(ws));
  });

  return {
    text: out.join("\n") + "\n",
    complete,
    commit: () => {
      if (markers.length) mkdirSync(reportedDir, { recursive: true });
      for (const p of markers) writeFileSync(p, "");
      if (failuresTotal !== null) writeFileSync(seenFile, String(failuresTotal));
    },
  };
}

// The lead hears about a tracker outage once, when a round first cannot read it, and once more when
// a round reads it again. An outage can last a day, and a message every hour about something the
// lead cannot fix is noise. Said by the courier from here, not by the session, which has no memory
// of whether it said it last hour. A message that was not delivered leaves the marker as it was, so
// the next round says it again.
function outage(ws: Workspace, read: string): void {
  const told = join(ws.logsDir, ".tracker-outage.told");
  if (read === "unavailable" && !existsSync(told)) {
    if (deliver(ws, "[round]\ntracker UNAVAILABLE: the round could not read the tracker. Said once per outage; the round says so again when it is back."))
      writeFileSync(told, "");
  } else if (read === "read" && existsSync(told)) {
    if (deliver(ws, "[round]\ntracker back: the round read the tracker again.")) rmSync(told, { force: true });
  }
}

export function runRound(ws: Workspace, opts: { factsOnly?: boolean } = {}, out: (line: string) => void = console.log): number {
  const facts = gatherFacts(ws);
  if (opts.factsOnly) {
    out(facts.text.trimEnd());
    return facts.complete ? 0 : 1;
  }
  const tracker = trackerOf(ws);
  const prompt = [
    loadPrompt(ws, "round"),
    "---- TRACKER ----",
    tracker.instructions(ws),
    `---- FACTS${facts.complete ? "" : " (partial: a section could not be read)"} ----`,
    facts.text.trimEnd(),
    "---- END FACTS ----",
  ].join("\n\n") + "\n";
  const log = openLog(ws, "round");
  const r = runClaude(ws, "round", prompt, ["Read", "ListAgents", "ToolSearch", "SendMessage", ...tracker.tools], log);
  const read = tracker.reads && r.status === 0 ? parseRead(ws, r.stdout).outcome : "none";
  logTo(log, `facts=${facts.complete ? "complete" : "partial"} tracker=${read}`);
  // The round ran and saw these facts, whatever the tracker did, so what it saw is not news again.
  if (r.status === 0) facts.commit();
  outage(ws, read);
  // "Ran, read the facts, and read the tracker": each is required, and the read needs its evidence.
  if (r.status === 0 && facts.complete && (read === "none" || read === "read")) beat(ws, "round");
  if (r.status !== 0) failure(ws, `round FAILED exit=${r.status}`);
  if (!facts.complete) failure(ws, "round: the facts were partial");
  out(`round: exit=${r.status} facts=${facts.complete ? "complete" : "partial"} tracker=${read}`);
  return r.status === 0 && facts.complete ? 0 : 1;
}
