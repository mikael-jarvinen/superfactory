import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHuman, type Message, tryReadTail } from "../messages.js";
import { allRecs, type Rec } from "../state.js";
import type { Workspace } from "../workspace.js";

// The questions and decisions waiting on the human, oldest first, for the panel on the message page.
// Nothing new holds the questions: they are the lead's `decision` and `blocked` rows in the message
// log, and the records sitting in `blocked` with the question they asked (asked_you). The only file
// this adds is which of them the human has marked handled, in logs/ beside the seen mark.
//
// An item leaves the queue when:
// - the human marks it handled on the panel, or sends a reply from it (the page marks it once the
//   reply is posted);
// - it is a `blocked` row or a blocked record, and the ticket has left `blocked` since (the state
//   events log says when): the lead moved the ticket on, so the question was answered.
// Reading it never does, and neither does a message typed in the thread: a message has no reply-to,
// so nothing can tell which question it answers.

export const WAITING_KINDS: ReadonlySet<string> = new Set(["decision", "blocked"]);

export const handledFile = (ws: Workspace) => join(ws.logsDir, "messages-handled.json");

export interface QueueItem {
  id: string;
  // The message's `t`, which is how the page finds it in the thread; null for a record with no message.
  t: string | null;
  // When it was asked: the row's `t`, or when the record was blocked.
  at: string | null;
  kind: string;
  ticket: string | null;
  text: string;
  link: string | null;
  // "message": a row of the log. "board": a blocked record whose question was never posted.
  from: "message" | "board";
}

const hash = (...parts: string[]) => createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);

// Lead rows have no id, and two can share a second, so a row is named by its time and its words.
export const messageId = (r: Message) => "m" + hash(r.t ?? "", r.kind ?? "", r.ticket ?? "", r.text ?? "");
// A record is asked again when it is blocked again, so its question is named by when it was asked.
const recordId = (r: Rec) => "r" + hash(r.ticket, r.asked_you?.at ?? "");

const time = (t: string | null | undefined) => (t ? Date.parse(t) : NaN);

export function readHandled(ws: Workspace): Record<string, string> {
  try {
    const h = (JSON.parse(readFileSync(handledFile(ws), "utf8")) as { handled?: unknown }).handled;
    return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// The whole log, the current file and the one rolled to .1, read again only when either changes.
// The page shows the newest sixty rows; a question can wait far longer than that.
const LOG_BYTES = 4 * 1024 * 1024;
const logCache = new Map<string, { key: string; rows: Message[] }>();
function wholeLog(path: string): Message[] | null {
  const key = [path + ".1", path].map((p) => {
    try {
      const s = statSync(p);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "-";
    }
  }).join("|");
  const hit = logCache.get(path);
  if (hit && hit.key === key) return hit.rows;
  const cur = tryReadTail(path, LOG_BYTES);
  if (cur === null) return null;
  const rows = [...(tryReadTail(path + ".1", LOG_BYTES) ?? []), ...cur];
  logCache.set(path, { key, rows });
  return rows;
}

function records(ws: Workspace): Map<string, Rec> {
  try {
    return new Map(allRecs(ws).map((r) => [r.ticket, r]));
  } catch {
    return new Map(); // a torn record: no record items this turn
  }
}

// When each ticket left blocked, from the state events log, oldest first.
function unblocked(ws: Workspace): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const e of (wholeLog(ws.events) ?? []) as { t?: string; ticket?: string; from?: string }[]) {
    if (e.from !== "blocked" || !e.ticket || !Number.isFinite(time(e.t))) continue;
    out.set(e.ticket, [...(out.get(e.ticket) ?? []), time(e.t)]);
  }
  return out;
}

// Every question still open, handled or not; null when the log cannot be read.
function open(ws: Workspace): QueueItem[] | null {
  const rows = wholeLog(ws.messages);
  if (rows === null) return null;
  const recs = records(ws);
  const left = unblocked(ws);
  // A blocked row is answered once its ticket has left blocked since it was posted.
  const movedOn = (ticket: string, t: number) => (left.get(ticket) ?? []).some((u) => u >= t);
  const items: QueueItem[] = [];
  for (const r of rows) {
    if (isHuman(ws, r.kind) || !WAITING_KINDS.has(r.kind ?? "")) continue;
    if (r.kind === "blocked" && r.ticket && movedOn(r.ticket, time(r.t))) continue;
    items.push({ id: messageId(r), t: r.t ?? null, at: r.t ?? null, kind: r.kind!, ticket: r.ticket ?? null, text: r.text ?? "", link: r.link ?? null, from: "message" });
  }
  // A ticket blocked with a question that never reached the thread still waits on the human. A row
  // on the ticket posted since it last left blocked is that question, so the record adds nothing.
  for (const r of recs.values()) {
    if (r.state !== "blocked" || !r.asked_you) continue;
    const since = Math.max(-Infinity, ...(left.get(r.ticket) ?? []));
    if (items.some((i) => i.ticket === r.ticket && time(i.t) > since)) continue;
    items.push({ id: recordId(r), t: null, at: r.asked_you.at, kind: "blocked", ticket: r.ticket, text: r.asked_you.question ?? "blocked, with no question recorded", link: null, from: "board" });
  }
  return items.sort((a, b) => (time(a.at) || 0) - (time(b.at) || 0));
}

// What waits on the human: open and not marked handled, oldest first.
export function queue(ws: Workspace): QueueItem[] {
  const handled = readHandled(ws);
  return (open(ws) ?? []).filter((i) => !(i.id in handled));
}

// Mark an item handled. It must be one the queue holds now, so a post can only name a real question.
// Marking one already handled is a success that changes nothing.
export function markHandled(ws: Workspace, id: unknown): { ok: true } | { ok: false; error: string; retry?: true } {
  if (typeof id !== "string" || !/^[mr][0-9a-f]{12}$/.test(id)) return { ok: false, error: "id is not a queue id" };
  const handled = readHandled(ws);
  if (id in handled) return { ok: true };
  const items = open(ws);
  if (items === null) return { ok: false, error: "the message log could not be read", retry: true };
  if (!items.some((i) => i.id === id)) return { ok: false, error: "nothing in the queue has that id" };
  handled[id] = new Date().toISOString();
  mkdirSync(ws.logsDir, { recursive: true });
  const tmp = `${handledFile(ws)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ handled }, null, 1) + "\n");
  renameSync(tmp, handledFile(ws));
  return { ok: true };
}
