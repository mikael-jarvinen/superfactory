// How a watcher reaches the lead: a note in the lead's notes log, which the inbox monitor in the
// lead's session prints within a second. No model carries it. While no monitor is armed the note
// waits for the next one; the lead's Stop hook asks for one to be armed.
import { leaveNote } from "../board/inbox.js";
import { tryFailure } from "../failures.js";
import type { Workspace } from "../workspace.js";

// True when the note is written. A note that cannot be written is a line in the failures log.
export function deliver(ws: Workspace, text: string): boolean {
  try {
    leaveNote(ws, text);
    return true;
  } catch (e) {
    tryFailure(ws, `relay FAILED: the lead's note could not be written: ${(e as Error).message}`);
    return false;
  }
}
