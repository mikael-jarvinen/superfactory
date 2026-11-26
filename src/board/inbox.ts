import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { HUMAN_KIND, isHuman, type Message, rowImages } from "../messages.js";
import { tryLock } from "../tickets/lock.js";
import type { Workspace } from "../workspace.js";
import { chars, FactoryError, now, pyDumps, sleep } from "../util.js";

// What the human can type on the page. `factory say` has no limit: the lead's instructions keep it short.
export const MAX_CHARS = 20_000;

export const inboxLock = (ws: Workspace) => join(ws.runDir, "inbox.lock");
const cursorFile = (ws: Workspace) => join(ws.runDir, "inbox.cursor");

// What the watchers have for the lead: one JSON row a line, printed by the inbox holder after the
// human's messages. It is not the message log, so none of it shows on the page.
export const notesLog = (ws: Workspace) => join(ws.stateDir, "lead-notes.jsonl");
const notesCursorFile = (ws: Workspace) => join(ws.runDir, "notes.cursor");

// For a watcher: leaves the text for the lead's inbox holder. Nothing is lost while no holder is
// armed; the next one prints it, and the lead's Stop hook and the watchdog say it is not armed.
export function leaveNote(ws: Workspace, text: string): void {
  mkdirSync(ws.stateDir, { recursive: true });
  appendFileSync(notesLog(ws), JSON.stringify({ t: now(), id: randomBytes(3).toString("hex"), text }) + "\n");
}

// The human's side of the thread. Appended here rather than through `say`, which is the lead's
// voice; the kind keeps the two apart on the page and in the log.
export function postMessage(ws: Workspace, text: unknown, images: string[] = []): { ok: boolean; error: string | null } {
  const t = typeof text === "string" ? text.trim() : "";
  // A pasted screenshot is a message on its own; a caption is optional.
  if (!t && images.length === 0) return { ok: false, error: "nothing to send" };
  const n = chars(t).length;
  if (n > MAX_CHARS) return { ok: false, error: `${n} characters, over the ${MAX_CHARS} the page takes` };
  mkdirSync(ws.stateDir, { recursive: true });
  const row = { t: now(), id: randomBytes(3).toString("hex"), text: t, ticket: null, kind: HUMAN_KIND, link: null, images };
  appendFileSync(ws.messages, pyDumps(row) + "\n");
  return { ok: true, error: null };
}

// Pasted screenshots are written here, beside the message log, and served at /attachments/<name>.
export const attachmentsDir = (ws: Workspace): string => join(ws.stateDir, "attachments");

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 10;

// Decode a `data:image/...;base64,...` payload from the page and store it, returning the file name
// to record on the row, or null when it is not an image we accept. The name is random and never
// taken from the client, so a posted name cannot escape the attachments dir.
export function saveAttachment(ws: Workspace, dataUrl: unknown): string | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[2]!, "base64");
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  const dir = attachmentsDir(ws);
  mkdirSync(dir, { recursive: true });
  const name = `m-${randomBytes(6).toString("hex")}.${IMAGE_EXT[m[1]!]}`;
  writeFileSync(join(dir, name), buf);
  return name;
}

// What reaches the session. The id tag is how the receipts find it again in the transcript. A
// pasted screenshot is named by its on-disk path on a line of its own, in the order pasted, so the
// session can open each one.
export const pageText = (ws: Workspace, row: Message): string =>
  [`[from the message page] [m:${row.id}] ${row.text ?? ""}`.trimEnd(),
    ...rowImages(row).map((f) => `[image saved at: ${join(attachmentsDir(ws), f)}]`)].join("\n");

// The inbox has one holder at a time, and the holder has the lock: `factory board --inbox`, run in
// the lead's session, with --once as a background command. The lock dies with its holder, and the
// next holder carries on from the cursor, so a message is printed once.
//
// The lock is src/tickets/lock.ts's tryLock: a flock that goes when its descriptor closes.

// For the lead's Stop hook: is a holder listening? Taking the lock is the only way to ask, so a
// free lock is taken and dropped at once. Anything that stops the question being asked counts as
// held, so a broken probe never nags the session.
export function inboxHeld(ws: Workspace): boolean {
  let fd: number | null;
  try {
    fd = tryLock(inboxLock(ws));
  } catch {
    return true;
  }
  if (fd === null) return true;
  closeSync(fd);
  return false;
}

// Where the inbox has got to in a log, as the log's inode and a byte offset. The inode is what
// notices `say` rotating the message log: an offset alone is only caught while the new file is
// still shorter than it, and the cursor can sit still for days while no holder is armed. last is
// the id of the last row printed: a log replaced other than by rotation is read on past it, not
// printed again from the top.
export interface Cursor {
  ino: number;
  offset: number;
  last?: string;
}

export const sameCursor = (a: Cursor | undefined, b: Cursor): boolean => !!a && a.ino === b.ino && a.offset === b.offset;

function readCursorAt(path: string): Cursor | null {
  try {
    const [i, o, last] = readFileSync(path, "utf8").trim().split(" ");
    const ino = Number(i);
    const offset = Number(o);
    if (!Number.isInteger(ino) || !Number.isInteger(offset)) return null;
    return last ? { ino, offset, last } : { ino, offset };
  } catch {
    return null;
  }
}

function writeCursorAt(path: string, c: Cursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", `${c.ino} ${c.offset}${c.last ? ` ${c.last}` : ""}`);
  renameSync(path + ".tmp", path);
}

export const readCursor = (ws: Workspace): Cursor | null => readCursorAt(cursorFile(ws));
export const writeCursor = (ws: Workspace, c: Cursor): void => writeCursorAt(cursorFile(ws), c);

const stat = (path: string): { ino: number; size: number } => {
  try {
    const st = statSync(path);
    return { ino: st.ino, size: st.size };
  } catch {
    return { ino: 0, size: 0 }; // no log yet
  }
};

// The complete lines of a file from offset to size, each with the cursor after it.
function* linesOf(path: string, ino: number, offset: number, size: number): Generator<{ line: string | null; cursor: Cursor }> {
  if (offset >= size) return;
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  let start = 0;
  for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, start)) {
    const line = buf.subarray(start, nl).toString("utf8");
    offset += nl + 1 - start;
    start = nl + 1;
    yield { line, cursor: { ino, offset } };
  }
}

// Each complete line of the log past the cursor, with the cursor after it. With no cursor it starts
// at the end. A torn last line is not yielded, and the cursor never moves past it. A log rolled to
// .1 since the cursor was written is read to its end first: lines can wait there for hours while no
// holder is armed. A log replaced or cut short any other way, a cleanup's rewrite say, is read from
// past the row whose id is the cursor's last, or from the top if that row is not in it: a line
// repeated rather than lost.
function* linesAfter(path: string, cursor: Cursor | null, idOf: (line: string) => string | null): Generator<{ line: string | null; cursor: Cursor }> {
  const { ino, size } = stat(path);
  if (cursor === null) {
    yield { line: null, cursor: { ino, offset: size } };
    return;
  }
  let rolled = false;
  if (cursor.ino !== ino) {
    const old = stat(path + ".1");
    rolled = old.ino === cursor.ino && cursor.ino !== 0 && cursor.offset <= old.size;
    if (rolled) yield* linesOf(path + ".1", old.ino, cursor.offset, old.size);
  }
  const offset = cursor.ino === ino && cursor.offset <= size ? cursor.offset : 0;
  const last = cursor.last;
  if (offset === 0 && !rolled && last) {
    const all = [...linesOf(path, ino, 0, size)];
    const i = all.findLastIndex((l) => l.line !== null && l.line.includes(last) && idOf(l.line) === last);
    if (i >= 0) {
      yield { line: null, cursor: all[i]!.cursor };
      yield* all.slice(i + 1);
      return;
    }
  }
  if (offset === size) {
    if (!sameCursor(cursor, { ino, offset })) yield { line: null, cursor: { ino, offset } };
    return;
  }
  yield* linesOf(path, ino, offset, size);
}

const parse = <T>(line: string | null): T | null => {
  if (line === null) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null; // a torn or foreign line
  }
};

const idOf = (r: { id?: unknown } | null): string | null => (r && typeof r.id === "string" && /^[0-9a-f]+$/.test(r.id) ? r.id : null);
const withLast = (c: Cursor, last: string | undefined): Cursor => (last ? { ...c, last } : c);

// The message log past the cursor; row is set only for the human's messages. History is not news,
// so with no cursor it starts at the end.
export function* unsent(ws: Workspace, cursor: Cursor | null): Generator<{ row: Message | null; cursor: Cursor }> {
  let last = cursor?.last;
  for (const u of linesAfter(ws.messages, cursor, (l) => idOf(parse<Message>(l)))) {
    const r = parse<Message>(u.line);
    const row = r && isHuman(ws, r.kind) && r.id ? r : null;
    if (row) last = idOf(row) ?? last;
    yield { row, cursor: withLast(u.cursor, last) };
  }
}

// The notes past their cursor, as the text the lead reads. A note is for the lead whenever it was
// left, so with no cursor it starts at the beginning of the log: a note left before the first
// holder ever armed is still printed. The tag is what the receipts look for.
export function* unsentNotes(ws: Workspace, cursor: Cursor | null): Generator<{ text: string | null; cursor: Cursor }> {
  let last = cursor?.last;
  for (const u of linesAfter(notesLog(ws), cursor ?? { ino: -1, offset: 0 }, (l) => idOf(parse<{ id?: unknown }>(l)))) {
    const n = parse<{ id?: string; text?: string }>(u.line);
    const ok = n && typeof n.text === "string" && n.id;
    if (ok) last = idOf(n) ?? last;
    yield { text: ok ? `[m:${n.id}] ${n.text}` : null, cursor: withLast(u.cursor, last) };
  }
}

// A write to fd 1, not process.stdout: on macOS a pipe behind process.stdout is written
// asynchronously, and the cursor must not move past a line that is still in a buffer.
function writeLine(line: string): void {
  const b = Buffer.from(line + "\n");
  for (let off = 0; off < b.length;) {
    try {
      off += writeSync(1, b, off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      sleep(10);
    }
  }
}

// `factory board --inbox`: each new message from the page, and each note a watcher left, as
// stdout, which the lead's session reads as an event. Printed before the cursor moves, so a kill in
// between repeats a line rather than losing it. Runs until killed, or with once until the first
// pass that printed anything: a background command in the lead's session then wakes it only when
// there is something to read, and holds the inbox until then. With once, an inbox another holder
// has is an error (exit 3), so the lead is told not to start another, never invited to rerun.
export function followInbox(ws: Workspace, out: (line: string) => void = writeLine, once = false): void {
  let fd = tryLock(inboxLock(ws));
  for (const until = Date.now() + 3000; fd === null && Date.now() < until;) {
    sleep(100);
    fd = tryLock(inboxLock(ws));
  }
  if (fd === null) {
    const said = "the message page inbox is already held by another `board --inbox`; this one stops";
    if (once) throw new FactoryError(`${said}. Do not start another while that one runs.`, 3);
    out(said);
    return;
  }
  let cursor = readCursor(ws);
  let notes = readCursorAt(notesCursorFile(ws));
  for (;;) {
    let printed = false;
    for (const u of unsent(ws, cursor)) {
      if (u.row) { out(pageText(ws, u.row)); printed = true; }
      writeCursor(ws, u.cursor);
      cursor = u.cursor;
    }
    for (const u of unsentNotes(ws, notes)) {
      if (u.text) { out(u.text); printed = true; }
      writeCursorAt(notesCursorFile(ws), u.cursor);
      notes = u.cursor;
    }
    if (once && printed) {
      closeSync(fd);
      return;
    }
    sleep(250);
  }
}

// What the lead's sessions did with each message, read from their transcripts. The harness writes
// a queue entry when a message reaches the session, a conversation entry when the model is handed
// it, mid-turn or at the start of one, and seen is the first assistant entry after that. Every
// transcript beside the current one is read, so a restarted session keeps its old receipts, and each
// is read incrementally because one runs to tens of megabytes.
const MARK = /\[m:([0-9a-f]{6})\]/g;
// In a tool's output, only what `board --inbox` printed counts: an id that opens a line, alone (a
// note) or after pageText's prefix, as the command's stdout, BashOutput's <stdout> or a Read of its
// output file ("     1→") shows it. Anything else that names an id, the watchdog's own
// "ALERT, [m:id]" line in a log the lead reads, is not a message reaching it.
const PRINTED = /^(?:\s*\d+→)?(?:<stdout>)?(?:\[from the message page\] )?\[m:([0-9a-f]{6})\]/gm;
const CHUNK = 4 * 1024 * 1024;

export class Receipts {
  private files = new Map<string, { offset: number; pending: Set<string> }>();
  private delivered = new Set<string>();
  private seen = new Set<string>();

  receipt(id: string): "seen" | "delivered" | "sent" {
    return this.seen.has(id) ? "seen" : this.delivered.has(id) ? "delivered" : "sent";
  }

  read(current: string | undefined): void {
    if (!current) return;
    const dir = dirname(current);
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return;
    }
    for (const f of names) this.readOne(join(dir, f));
  }

  private readOne(path: string): void {
    let st = this.files.get(path);
    if (!st) this.files.set(path, (st = { offset: 0, pending: new Set() }));
    let fd: number | undefined;
    try {
      const size = statSync(path).size;
      if (size < st.offset) {
        st.offset = 0;
        st.pending.clear();
      }
      fd = openSync(path, "r");
      let pos = st.offset;
      let carry = Buffer.alloc(0);
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        pos += readSync(fd, buf, 0, buf.length, pos);
        const data = carry.length ? Buffer.concat([carry, buf]) : buf;
        let start = 0;
        for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, start)) {
          this.take(data.subarray(start, nl), st.pending);
          start = nl + 1;
        }
        st.offset += start;
        carry = data.subarray(start);
      }
    } catch {
      // a transcript that vanished or cannot be read keeps what it had
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private take(line: Buffer, pending: Set<string>): void {
    if (!line.includes("[m:") && !(pending.size && line.includes('"type":"assistant"'))) return;
    let d: Record<string, any>;
    try {
      d = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    const ids = (s: unknown, re = MARK) => [...String(s ?? "").matchAll(re)].map((m) => m[1] as string);
    const kind = d.type;
    if (kind === "assistant") {
      for (const id of pending) this.seen.add(id);
      pending.clear();
      return;
    }
    if (kind === "queue-operation" && d.operation === "enqueue") {
      for (const id of ids(d.content)) this.delivered.add(id);
      return;
    }
    let text: unknown;
    let re = MARK;
    if (kind === "user" && typeof d.message?.content === "string") text = d.message.content;
    // a message read by a tool, as `board --inbox --once` run with Bash hands it over: in the
    // tool_result's content, a string or text blocks, and only as PRINTED
    else if (kind === "user" && Array.isArray(d.message?.content))
      (re = PRINTED), (text = d.message.content
        .filter((c: any) => c?.type === "tool_result")
        .map((c: any) => (typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((b: any) => b?.text ?? "").join("\n") : ""))
        .join("\n"));
    else if (kind === "attachment" && d.attachment?.type === "queued_command") text = d.attachment.prompt;
    else return;
    for (const id of ids(text, re)) {
      this.delivered.add(id);
      if (!this.seen.has(id)) pending.add(id);
    }
  }
}
