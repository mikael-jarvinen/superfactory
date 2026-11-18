import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
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
// so nothing can tell which question it answers. Questions asked before the queue was first read in
// a workspace are left out unless their ticket is blocked now (see queue()).

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

// The handled file: `start`, a day before the queue was first read in this workspace, and `handled`,
// id -> when. Questions asked before `start` are history, not a backlog: they are left out unless
// their ticket is blocked now. The day keeps what was asked just before the board was upgraded, or
// before logs/ was cleared and the start set again. "missing" is a workspace that has never shown the queue; "unreadable" is a
// file that exists and does not parse, which is never written over, so no mark is lost to it.
type Handled = { start: string | null; handled: Record<string, string> };
function readHandledFile(ws: Workspace): Handled | "missing" | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(handledFile(ws), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const d = JSON.parse(raw) as { start?: unknown; handled?: unknown };
    const h = d.handled;
    if (!h || typeof h !== "object" || Array.isArray(h)) return "unreadable";
    return { start: typeof d.start === "string" && Number.isFinite(time(d.start)) ? d.start : null, handled: h as Record<string, string> };
  } catch {
    return "unreadable";
  }
}

const GRACE = 24 * 3600_000;
const fresh = (): Handled => ({ start: new Date(Date.now() - GRACE).toISOString(), handled: {} });

// What the page says when the handled file is broken, and how to mend it; null when it is fine.
const brokenNote = (ws: Workspace) =>
  `${handledFile(ws)} does not parse, so every question shows and none can be marked handled. Fix it, or delete it to start the queue again from a day ago.`;
export function queueTrouble(ws: Workspace): string | null {
  return readHandledFile(ws) === "unreadable" ? brokenNote(ws) : null;
}

function writeHandled(ws: Workspace, h: Handled): void {
  mkdirSync(ws.logsDir, { recursive: true });
  const tmp = `${handledFile(ws)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(h, null, 1) + "\n");
  renameSync(tmp, handledFile(ws));
}

export function readHandled(ws: Workspace): Record<string, string> {
  const h = readHandledFile(ws);
  return typeof h === "string" ? {} : h.handled;
}

// The message log, the current file and the one rolled to .1, read again only when either changes.
// The page shows the newest sixty rows; a question can wait far longer than that. post() renames
// the log over .1 when it passes 1MB, so a question older than the two files (about 2MB of thread)
// drops out of the queue unanswered, as it drops out of the thread.
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

// When each ticket left blocked, from the state events log. That log is never rolled and grows for
// the life of the workspace, so it is read once from the top and then only what was appended since,
// and only the blocked exits are kept. A file replaced or cut short is read again from the top.
// Nothing rotates events.jsonl. A copytruncate that cut it and let it grow back past the offset
// before the next read would go unseen, since the inode stays the same.
const exits = new Map<string, { ino: number; offset: number; left: Map<string, number[]> }>();
const CHUNK = 1024 * 1024;
function unblocked(ws: Workspace): Map<string, number[]> {
  const path = ws.events;
  let st: { ino: number; size: number };
  try {
    const s = statSync(path);
    st = { ino: s.ino, size: s.size };
  } catch {
    return new Map(); // no events yet
  }
  let c = exits.get(path);
  if (!c || c.ino !== st.ino || st.size < c.offset) exits.set(path, (c = { ino: st.ino, offset: 0, left: new Map() }));
  if (st.size === c.offset) return c.left;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    while (c.offset < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - c.offset));
      const n = readSync(fd, buf, 0, buf.length, c.offset);
      const end = buf.lastIndexOf(0x0a, n - 1);
      if (end < 0) {
        if (n < CHUNK) break; // a torn last line: read again once it is whole
        c.offset += n; // a line longer than a chunk is no event of ours
        continue;
      }
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes('"blocked"')) continue;
        try {
          const e = JSON.parse(line) as { t?: string; ticket?: string; from?: string };
          if (e.from === "blocked" && e.ticket && Number.isFinite(time(e.t))) c.left.set(e.ticket, [...(c.left.get(e.ticket) ?? []), time(e.t)]);
        } catch {
          // a torn or foreign line
        }
      }
      c.offset += end + 1;
    }
  } catch {
    // read on from the same offset next time
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return c.left;
}

// How long before a ticket was blocked a row on it may be posted and still be the question the
// block records: the lead posts the question and records the block in either order, a few minutes apart.
const ASKED_WITH = 10 * 60_000;

// Every question still open, handled or not. `read` is false when the message log exists and could
// not be read: the records' questions are still there, the rows' are not. A workspace with no log
// yet has no rows. `covers` names the record a posted row is the question of, so a mark on the
// record holds once the row is posted.
function open(ws: Workspace, recs = records(ws)): { items: QueueItem[]; read: boolean; covers: Map<string, string> } {
  let rows = wholeLog(ws.messages);
  const read = rows !== null || !existsSync(ws.messages);
  rows ??= [];
  const left = unblocked(ws);
  const covers = new Map<string, string>();
  // A blocked row is answered once its ticket has left blocked since it was posted.
  const movedOn = (ticket: string, t: number) => (left.get(ticket) ?? []).some((u) => u >= t);
  const items: QueueItem[] = [];
  for (const r of rows) {
    if (isHuman(ws, r.kind) || !WAITING_KINDS.has(r.kind ?? "")) continue;
    if (r.kind === "blocked" && r.ticket && movedOn(r.ticket, time(r.t))) continue;
    items.push({ id: messageId(r), t: r.t ?? null, at: r.t ?? null, kind: r.kind!, ticket: r.ticket ?? null, text: r.text ?? "", link: r.link ?? null, from: "message" });
  }
  // A ticket blocked with a question that never reached the thread still waits on the human. A row
  // on the ticket posted around when it was blocked, and since it last left blocked, is that
  // question, so the record adds nothing. An older row is an earlier question.
  for (const r of recs.values()) {
    if (r.state !== "blocked" || !r.asked_you) continue;
    const from = Math.max(time(r.asked_you.at) - ASKED_WITH, ...(left.get(r.ticket) ?? []).map((u) => u + 1));
    const posted = items.filter((i) => i.ticket === r.ticket && time(i.t) >= from);
    for (const i of posted) covers.set(i.id, recordId(r));
    if (posted.length) continue;
    items.push({ id: recordId(r), t: null, at: r.asked_you.at, kind: "blocked", ticket: r.ticket, text: r.asked_you.question ?? "blocked, with no question recorded", link: null, from: "board" });
  }
  items.sort((a, b) => (time(a.at) || 0) - (time(b.at) || 0));
  return { items, read, covers };
}

// What waits on the human: open, not marked handled, and not history from before the queue's start,
// oldest first. The first read in a workspace sets the start a day back, so turning the queue on
// does not put every decision ever posted on it.
export function queue(ws: Workspace): QueueItem[] {
  let h = readHandledFile(ws);
  if (h === "missing") {
    h = fresh();
    try {
      writeHandled(ws, h);
    } catch {
      // logs/ not writable: the start holds for this read and is set again on the next
    }
  }
  const recs = records(ws);
  const { items, covers } = open(ws, recs);
  if (h === "unreadable") return items; // everything, rather than hide a question behind a broken file
  const { start, handled } = h;
  const blockedNow = (i: QueueItem) => !!i.ticket && recs.get(i.ticket)?.state === "blocked";
  // Rows carry whole seconds, so a row posted in the second the start was set is after it.
  const from = start === null ? -Infinity : Math.floor(time(start) / 1000) * 1000;
  const done = (i: QueueItem) => i.id in handled || (covers.get(i.id) ?? "") in handled;
  return items.filter((i) => !done(i) && (time(i.at) >= from || blockedNow(i)));
}

// Mark an item handled. It must be one the queue holds now, so a post can only name a real question.
// Marking one already handled is a success that changes nothing.
export function markHandled(ws: Workspace, id: unknown): { ok: true } | { ok: false; error: string; retry?: true } {
  if (typeof id !== "string" || !/^[mr][0-9a-f]{12}$/.test(id)) return { ok: false, error: "id is not a queue id" };
  const h = readHandledFile(ws);
  if (h === "unreadable") return { ok: false, error: brokenNote(ws) };
  const cur: Handled = h === "missing" ? fresh() : h;
  if (id in cur.handled) return { ok: true };
  const { items, read } = open(ws);
  if (!items.some((i) => i.id === id)) {
    // A row's question cannot be checked while the log cannot be read; a record's can.
    if (!read && id.startsWith("m")) return { ok: false, error: "the message log could not be read", retry: true };
    return { ok: false, error: "nothing in the queue has that id" };
  }
  cur.handled[id] = new Date().toISOString();
  writeHandled(ws, cur);
  return { ok: true };
}
