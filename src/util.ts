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
}

export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) return { status: 127, stdout: "", stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
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

// JSON as Python's json.dumps writes it (ensure_ascii, its separators, optional sort_keys), so a
// file written here is byte-identical to one the old writer would produce.
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
