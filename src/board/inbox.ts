import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { HUMAN_KIND, isHuman, type Message } from "../messages.js";
import type { Workspace } from "../workspace.js";
import { chars, die, now, pyDumps, sleep } from "../util.js";

// What the human can type on the page; `factory say` keeps its own 1200 for the lead.
export const MAX_CHARS = 4000;

// Carries one message to the lead when no inbox is held. It must return at once: the courier runs
// inside the board, and a sweep that waits on a model call is a page that hangs after Send.
export type Relay = (ws: Workspace, text: string) => void;

export const inboxLock = (ws: Workspace) => join(ws.runDir, "inbox.lock");
const cursorFile = (ws: Workspace) => join(ws.runDir, "inbox.cursor");

// The human's side of the thread. Appended here rather than through `say`, which is the lead's
// voice; the kind keeps the two apart on the page and in the log.
export function postMessage(ws: Workspace, text: unknown, image: string | null = null): { ok: boolean; error: string | null } {
  const t = typeof text === "string" ? text.trim() : "";
  const img = typeof image === "string" && image !== "" ? image : null;
  // A pasted screenshot is a message on its own; a caption is optional.
  if (!t && !img) return { ok: false, error: "nothing to send" };
  const n = chars(t).length;
  if (n > MAX_CHARS) return { ok: false, error: `${n} characters, over the ${MAX_CHARS} the page takes` };
  mkdirSync(ws.stateDir, { recursive: true });
  const row = { t: now(), id: randomBytes(3).toString("hex"), text: t, ticket: null, kind: HUMAN_KIND, link: null, image: img };
  appendFileSync(ws.messages, pyDumps(row) + "\n");
  return { ok: true, error: null };
}

// Pasted screenshots are written here, beside the message log, and served at /attachments/<name>.
export const attachmentsDir = (ws: Workspace): string => join(ws.stateDir, "attachments");

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
// pasted screenshot is named by its on-disk path on a second line, so the session can open it.
export const pageText = (ws: Workspace, row: Message): string => {
  const base = `[from the message page] [m:${row.id}] ${row.text ?? ""}`.trimEnd();
  return row.image ? `${base}\n[image saved at: ${join(attachmentsDir(ws), row.image)}]` : base;
};

// The inbox has one owner at a time, and the owner holds the lock: `factory board --inbox`, run as
// a monitor in the lead's session, or failing that the board's courier sweep. The lock dies with its
// holder, so a monitor that expires hands the inbox back to the sweep with no gap. Only the owner
// moves the cursor, so a message is printed or relayed, never both.
//
// Node has no flock(2). macOS's open(2) takes the same lock atomically with O_EXLOCK, and it is
// released when the descriptor closes, however the process ends. Linux has no such flag and would
// ignore the bit, which is a lock that always succeeds, so other platforms are refused.
const O_EXLOCK = 0x20;

export function tryLock(path: string): number | null {
  if (process.platform !== "darwin") die("the inbox lock uses macOS's O_EXLOCK; other platforms are not built yet");
  mkdirSync(dirname(path), { recursive: true });
  try {
    return openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
    throw e;
  }
}

// For the lead's Stop hook: is a monitor listening? Taking the lock is the only way to ask, so a
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

// Where the inbox has got to in the message log, as the log's inode and a byte offset. The inode
// is what notices `say` rotating the log: an offset alone is only caught while the new file is
// still shorter than it, and without a relay the cursor can sit still for days.
export interface Cursor {
  ino: number;
  offset: number;
}

export function readCursor(ws: Workspace): Cursor | null {
  try {
    const [ino, offset] = readFileSync(cursorFile(ws), "utf8").trim().split(" ").map(Number);
    return Number.isInteger(ino) && Number.isInteger(offset) ? { ino: ino as number, offset: offset as number } : null;
  } catch {
    return null;
  }
}

export function writeCursor(ws: Workspace, c: Cursor): void {
  mkdirSync(ws.runDir, { recursive: true });
  const p = cursorFile(ws);
  writeFileSync(p + ".tmp", `${c.ino} ${c.offset}`);
  renameSync(p + ".tmp", p);
}

// Each complete line past the cursor, with the cursor after it; row is set only for the human's
// messages. With no cursor it starts at the end, because history is not news.
export function* unsent(ws: Workspace, cursor: Cursor | null): Generator<{ row: Message | null; cursor: Cursor }> {
  let ino = 0;
  let size = 0;
  try {
    const st = statSync(ws.messages);
    ino = st.ino;
    size = st.size;
  } catch {
    // no log yet
  }
  if (cursor === null) {
    yield { row: null, cursor: { ino, offset: size } };
    return;
  }
  let offset = cursor.ino === ino && cursor.offset <= size ? cursor.offset : 0;
  if (offset === size) {
    if (cursor.ino !== ino || cursor.offset !== offset) yield { row: null, cursor: { ino, offset } };
    return;
  }
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(ws.messages, "r");
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
    let r: Message | null = null;
    try {
      r = JSON.parse(line) as Message;
    } catch {
      // a torn or foreign line
    }
    yield { row: r && isHuman(ws, r.kind) && r.id ? r : null, cursor: { ino, offset } };
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

// `factory board --inbox`: each new message from the page as stdout, which a monitor in the lead's
// session turns into an event within a second. Printed before the cursor moves, so a kill in
// between repeats a message rather than losing it. Runs until killed.
export function followInbox(ws: Workspace, out: (line: string) => void = writeLine): void {
  let fd = tryLock(inboxLock(ws));
  for (const until = Date.now() + 3000; fd === null && Date.now() < until;) {
    sleep(100);
    fd = tryLock(inboxLock(ws));
  }
  if (fd === null) {
    out("the message page inbox is already armed in another monitor; this one stops");
    return;
  }
  let cursor = readCursor(ws);
  for (;;) {
    for (const u of unsent(ws, cursor)) {
      if (u.row) out(pageText(ws, u.row));
      writeCursor(ws, u.cursor);
      cursor = u.cursor;
    }
    sleep(250);
  }
}

// The board's half: while no monitor holds the inbox, take it for one pass and relay what is new.
// Returns whether it held the inbox.
export function sweep(ws: Workspace, relay: Relay): boolean {
  const fd = tryLock(inboxLock(ws));
  if (fd === null) return false;
  try {
    for (const u of unsent(ws, readCursor(ws))) {
      if (u.row) relay(ws, pageText(ws, u.row));
      writeCursor(ws, u.cursor);
    }
  } finally {
    closeSync(fd);
  }
  return true;
}

// What the lead's sessions did with each message, read from their transcripts. The harness writes
// a queue entry when a message reaches the session, a conversation entry when the model is handed
// it, mid-turn or at the start of one, and seen is the first assistant entry after that. Every
// transcript beside the current one is read, so a restarted session keeps its old receipts, and each
// is read incrementally because one runs to tens of megabytes.
const MARK = /\[m:([0-9a-f]{6})\]/g;
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
    const ids = (s: unknown) => [...String(s ?? "").matchAll(MARK)].map((m) => m[1] as string);
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
    if (kind === "user" && typeof d.message?.content === "string") text = d.message.content;
    else if (kind === "attachment" && d.attachment?.type === "queued_command") text = d.attachment.prompt;
    else return;
    for (const id of ids(text)) {
      this.delivered.add(id);
      if (!this.seen.has(id)) pending.add(id);
    }
  }
}
