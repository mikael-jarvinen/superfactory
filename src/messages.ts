import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { lead } from "./fleet.js";
import { notify } from "./notify.js";
import { validKey } from "./state.js";
import type { Workspace } from "./workspace.js";
import { chars, die, now, pyDumps, pyRepr, splitlines } from "./util.js";

export const KINDS = ["ready", "decision", "blocked", "answer", "note"] as const;
export type Kind = (typeof KINDS)[number];

// The human's side of the thread. A workspace whose log holds rows under an older kind names it as
// human.legacy_message_kind, and those rows read as the human's too.
export const HUMAN_KIND = "human";

export const MAX_CHARS = 1200;
const ROTATE_BYTES = 1_000_000;
const TAIL_BYTES = 256 * 1024;

export interface Message {
  t?: string;
  id?: string;
  text?: string;
  ticket?: string | null;
  kind?: string;
  link?: string | null;
  // File name (never a path) of a screenshot pasted on the page, stored under the attachments dir.
  image?: string | null;
}

export function isHuman(ws: Workspace, kind: string | undefined): boolean {
  return kind === HUMAN_KIND || (kind !== undefined && kind === ws.config.human.legacyMessageKind);
}

export function say(ws: Workspace, words: string[], opts: { ticket?: string; link?: string; kind?: Kind }, out = console.log): void {
  const text = words.join(" ").trim();
  if (!text) die("nothing to say");
  const n = chars(text).length;
  if (n > MAX_CHARS) die(`${n} characters. A message is short by construction; put the detail in the PR or the ticket and link it.`);
  if (opts.ticket && !validKey(ws, opts.ticket)) die(`${pyRepr(opts.ticket)} is neither a ticket key nor a local key`);
  mkdirSync(ws.stateDir, { recursive: true });
  // The log only grows and nothing else trims it, so it is rolled here. The page reads the tail
  // either way, and .1 keeps the older half recoverable.
  try {
    if (statSync(ws.messages).size > ROTATE_BYTES) renameSync(ws.messages, ws.messages + ".1");
  } catch {
    // no log yet
  }
  const row = { t: now(), text, ticket: opts.ticket ?? null, kind: opts.kind ?? "note", link: opts.link ?? null };
  appendFileSync(ws.messages, pyDumps(row) + "\n");
  const head = splitlines(text)[0] ?? "";
  notify("superfactory", row.ticket ?? row.kind, chars(head).slice(0, 160).join(""));
  const { host, port } = ws.config.board;
  out(`posted to http://${host}:${port}/messages`);
  // The desktop notification only reaches a machine the human is sitting at. The push reaches their
  // phone, and it is a separate tool call no script can make, so the line is printed here.
  const pre = opts.ticket ? `${opts.ticket} ` : "";
  out(`PUSH NOW: ${chars(pre + head).slice(0, 200).join("")}`);
}

// The tail of the log, never the whole of it: it is append-only and unbounded.
export function readTail(path: string): Message[] {
  let buf: Buffer;
  try {
    const size = statSync(path).size;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    buf = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1);
    }
  } catch {
    return [];
  }
  const rows: Message[] = [];
  for (const line of buf.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Message);
    } catch {
      // a torn or foreign line
    }
  }
  return rows;
}

export function messages(ws: Workspace, n: number, out = console.log): void {
  try {
    statSync(ws.messages);
  } catch {
    out("no messages yet");
    return;
  }
  const humanName = ws.config.human.name.toLowerCase();
  const leadName = lead(ws).name;
  const rows = readTail(ws.messages);
  for (const r of n === 0 ? rows : rows.slice(-n)) {
    const who = isHuman(ws, r.kind) ? humanName : leadName;
    out(`${(r.t ?? "").slice(0, 16)}  ${who.padEnd(9)} ${(r.kind ?? "").padEnd(8)} ${r.ticket ?? ""}`.trimEnd());
    for (const line of splitlines(r.text ?? "")) out(`    ${line}`);
    if (r.link) out(`    ${r.link}`);
  }
}
