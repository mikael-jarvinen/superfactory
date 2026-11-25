import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class FactoryError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

export function die(message: string, code = 1): never {
  throw new FactoryError(message, code);
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  // the signal that ended it, when one did
  signal?: NodeJS.Signals;
}

// How much of a command's output is read, on every path that reads one. spawnSync counts stdout
// and stderr together against it, execFile each on its own.
export const MAX_OUTPUT = 64 * 1024 * 1024;
const TAIL = 4096;

// `name` is who the output is from, when that is not cmd: a claude run through systemd-run.
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}, name = cmd): RunResult {
  const max = opts.maxBuffer ?? MAX_OUTPUT;
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts, maxBuffer: max });
  // ENOBUFS is a command that started and failed, not a missing one. The last TAIL characters of
  // each stream are kept, to show what was being written.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    const err = String(r.stderr ?? "").slice(-TAIL);
    return { status: 1, stdout: String(r.stdout ?? "").slice(-TAIL), stderr: `${name} wrote more than the ${max} bytes of output that are read${err ? `\n${err}` : ""}` };
  }
  // 127 for a command that could not start, as a shell says; 124 for one killed at its timeout, as
  // timeout(1) says, so a slow or sleeping run is not read as a missing binary.
  if (r.error) return { status: (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? 124 : 127, stdout: "", stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), ...(r.signal ? { signal: r.signal } : {}) };
}

export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function now(date = new Date()): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// realpath for a path that may not exist: resolve the part that does.
export function realpathLoose(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realpathLoose(parent), basename(abs));
  }
}

// How Python prints a value in an f-string, and with !r, for messages that must read the same.
export const pyStr = (v: unknown) => (v === null || v === undefined ? "None" : String(v));
export const pyRepr = (s: string) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/'/g, "\\'")}'`);

export function capitalize(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();
}

// Code points, as Python counts and slices a str.
export function chars(s: string): string[] {
  return Array.from(s);
}

// str.splitlines(): no trailing empty line, and the same line boundaries.
export function splitlines(s: string): string[] {
  const lines = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function squash(s: string, max: number): string {
  return chars(s.split(/\s+/).filter(Boolean).join(" ")).slice(0, max).join("");
}

// The first sentence of a message: its first line with words, markdown marks taken off, up to the
// first full stop, question or exclamation mark followed by a space. Longer than max, it ends at a
// whole word with an ellipsis, never mid-word.
export function firstSentence(s: string, max = Infinity): string {
  const line = (s.split("\n").find((l) => l.trim()) ?? "").replace(/^[#>*\s-]+/, "").replace(/\*\*|__|`/g, "").trim();
  const m = /^.*?[.?!](?=\s|$)/.exec(line);
  const sentence = (m ? m[0] : line).trim();
  if (chars(sentence).length <= max) return sentence;
  const cut = chars(sentence).slice(0, max).join("");
  const atWord = chars(sentence)[max] === " ";
  const word = cut.lastIndexOf(" ");
  return (atWord || word <= max / 2 ? cut : cut.slice(0, word)).replace(/[\s,;:]+$/, "") + "…";
}

// Words wrapped to lines no wider than width, each after the indent.
export function wrap(s: string, width: number, indent = ""): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (cur && chars(cur).length + 1 + chars(w).length > width) {
      lines.push(indent + cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(indent + cur);
  return lines;
}

// JSON as Python's json.dumps writes it (ensure_ascii, its separators, optional sort_keys), so a
// file written here is byte-identical to one Python writes.
export function pyDumps(value: unknown, opts: { indent?: number; sortKeys?: boolean } = {}): string {
  const { indent, sortKeys = false } = opts;
  const enc = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "Infinity" : v < 0 ? "-Infinity" : "NaN";
    if (typeof v === "string") return pyString(v);
    const inner = indent === undefined ? "" : "\n" + " ".repeat(indent * (level + 1));
    const outer = indent === undefined ? "" : "\n" + " ".repeat(indent * level);
    const sep = indent === undefined ? ", " : ",";
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return "[" + v.map((x) => inner + enc(x, level + 1)).join(sep) + outer + "]";
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (sortKeys) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return "{}";
    return "{" + entries.map(([k, x]) => inner + pyString(k) + ": " + enc(x, level + 1)).join(sep) + outer + "}";
  };
  return enc(value, 0);
}

const ESCAPES: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

function pyString(s: string): string {
  return '"' + s.replace(/[^\x20-\x7e]|["\\]/g, (c) => ESCAPES[c] ?? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + '"';
}
