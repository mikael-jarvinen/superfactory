import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHuman, tryReadTail } from "../messages.js";
import type { Workspace } from "../workspace.js";

// How far the human has read the lead's side of the thread. The message page, while it is visible,
// posts the `t` of the newest lead message it has drawn, and this keeps the latest one. Lead rows have
// no id, so `t` is the mark: every lead row with a `t` at or before it has been on the human's screen.
// Something outside the board (a reminder) reads it to tell what still waits for the human.

export const seenFile = (ws: Workspace) => join(ws.logsDir, "messages-seen.json");

const time = (t: unknown) => (typeof t === "string" ? Date.parse(t) : NaN);

// The `t` last marked seen, or null when the page has never marked one.
export function readSeen(ws: Workspace): string | null {
  try {
    const t = (JSON.parse(readFileSync(seenFile(ws), "utf8")) as { t?: unknown }).t;
    return Number.isFinite(time(t)) ? (t as string) : null;
  } catch {
    return null;
  }
}

// Mark `t` seen. It must be the `t` of a lead message in the log's tail, so a post can only name a
// message that exists. The mark only moves forward: a tab left open on an older page, or two tabs,
// never move it back. A log that cannot be read right now (gone for a moment while it is rolled) is
// `retry`, which the board answers with a 5xx so the page posts the same `t` again; a refusal it
// would not.
export function markSeen(ws: Workspace, t: unknown): { ok: true; seen: string } | { ok: false; error: string; retry?: true } {
  const at = time(t);
  if (!Number.isFinite(at)) return { ok: false, error: "t is not a time" };
  const rows = tryReadTail(ws.messages);
  if (rows === null) return { ok: false, error: "the message log could not be read", retry: true };
  if (!rows.some((r) => r.t === t && !isHuman(ws, r.kind))) return { ok: false, error: "no lead message has that t" };
  const prev = readSeen(ws);
  if (prev !== null && time(prev) >= at) return { ok: true, seen: prev };
  mkdirSync(ws.logsDir, { recursive: true });
  const tmp = `${seenFile(ws)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ t, at: new Date().toISOString() }) + "\n");
  renameSync(tmp, seenFile(ws));
  return { ok: true, seen: t as string };
}
