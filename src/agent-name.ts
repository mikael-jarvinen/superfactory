// The agent a transcript's session runs under, from its agent-name lines: Claude writes one at the
// head of each session's transcript (`{"type":"agent-name","agentName":…,"sessionId":…}`), and so
// does the Antigravity supervisor (backends/agy-supervisor.ts). The first one names it. Shared by
// the board's analytics (board/analytics.ts), which reads transcripts line by line, and the wake
// hook (hooks/wake.ts), which reads only a transcript's head.
import { closeSync, openSync, readSync } from "node:fs";

// How much of a transcript's head is read for its name. Claude's agent-name line is within its
// first few lines, a few hundred bytes in.
export const NAME_HEAD_BYTES = 64 * 1024;

// The name one line gives, or undefined when it is not an agent-name line, names no one, or names
// another session than sessionId (when both say one).
export function agentNameOf(line: string | Buffer, sessionId?: unknown): string | undefined {
  if (!line.includes('"agent-name"')) return undefined;
  let d: { type?: unknown; agentName?: unknown; sessionId?: unknown };
  try {
    d = JSON.parse(line.toString());
  } catch {
    return undefined;
  }
  if (d?.type !== "agent-name" || typeof d.agentName !== "string" || !d.agentName) return undefined;
  if (sessionId !== undefined && d.sessionId !== undefined && d.sessionId !== sessionId) return undefined;
  return d.agentName;
}

// The first name in the head of a transcript file, or undefined when it cannot be read or names none.
export function firstAgentName(file: string, sessionId?: unknown): string | undefined {
  let fd: number | undefined;
  let head: Buffer;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(NAME_HEAD_BYTES);
    head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const lines = head.toString("utf8").split("\n");
  // a head cut short ends in part of a line, which is no line
  if (head.length === NAME_HEAD_BYTES) lines.pop();
  for (const l of lines) {
    const n = agentNameOf(l, sessionId);
    if (n !== undefined) return n;
  }
  return undefined;
}
