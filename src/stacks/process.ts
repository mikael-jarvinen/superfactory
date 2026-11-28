import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { connect } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { die, run, sleep } from "../util.js";

// Detached processes for stack scripts: a dev server started from a Claude session's Bash call
// dies with that call's process group when the session stops, so it runs as the leader of a
// session of its own, with a pid file to find it by.

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  age: number;
  // exited and not yet reaped: ps's state Z
  zombie: boolean;
}

// ps's etime: [[dd-]hh:]mm:ss
function seconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? (etime.split("-") as [string, string]) : ["0", etime];
  return Number(days) * 86400 + clock.split(":").reduce((s, p) => s * 60 + Number(p), 0);
}

// Every process but the ps that lists them, which is the caller's child and in its group, so it
// would otherwise be counted in the caller's own tree at every poll.
function processes(): Proc[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,etime=,stat="], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) die(`ps failed: ${r.error?.message ?? r.stderr.trim()}`);
  return r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 5 && Number(f[0]) !== r.pid)
    .map(([pid, ppid, pgid, etime, stat]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), age: seconds(etime as string), zombie: (stat as string).startsWith("Z") }));
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The pid a pid file names, while that process is still the one the file was written for. A pid is
// reused once its process is gone, and a process that started after the file was written is
// someone else's: killing it would take down whatever the machine gave the number to next.
export function pidFromFile(file: string): number | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const p = processes().find((x) => x.pid === pid);
  if (!p) return null;
  // etime counts whole seconds, so allow the rounding
  return Date.now() - p.age * 1000 <= statSync(file).mtimeMs + 2000 ? pid : null;
}

export interface ProcStat {
  comm: string;
  // R, S, D, Z (zombie: exited, not yet reaped) and so on
  state: string;
  ppid: number;
  pgid: number;
  // the clock tick it started at
  ticks: string;
}

// /proc/<pid>/stat, Linux only. null when there is no such process; a read that fails otherwise
// throws.
export function procStat(pid: number): ProcStat | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
    throw e;
  }
  // the command name in field 2 is in parentheses and may hold spaces; the fields after it are
  // split by single spaces, and starttime is field 22
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = f[19];
  if (!ticks) die(`/proc/${pid}/stat has no start time`);
  return { comm: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")), state: f[0] ?? "", ppid: Number(f[1]), pgid: Number(f[2]), ticks };
}

// Each pid that is still there gets sig.
export function signalAll(pids: Iterable<number>, sig: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {
      // already gone
    }
  }
}

// What tells a process apart from a later one given the same pid: on Linux the boot and the clock
// tick it started at, elsewhere ps's start time. Neither moves when the wall clock is stepped. null
// when there is no such process; a lookup that fails otherwise throws.
let bootId: string | undefined;
export function startStamp(pid: number): string | null {
  if (process.platform === "linux") {
    const st = procStat(pid);
    if (!st) return null;
    return `${currentBoot()}:${st.ticks}`;
  }
  // lstart is printed in local time and the locale's words: pin both, or a TZ change restamps it
  const r = run("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC0", LC_ALL: "C" } });
  if (r.status !== 0) {
    if (!r.stdout.trim() && !r.stderr.trim()) return null; // no such process
    die(`ps failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim() || null;
}

// Alive and not a zombie: an exited process its parent has not reaped yet still answers
// kill(pid, 0), and no signal can end it further, so it is not counted alive.
export function living(pid: number): boolean {
  if (!alive(pid)) return false;
  try {
    return procStat(pid)?.state !== "Z";
  } catch {
    return true;
  }
}

// The process, its descendants, and anything left in its process group, in one ps table: a child
// whose parent died first is reparented and only the group still ties it to the tree. Never the
// caller or its parent.
function treeOf(pid: number, table: Proc[]): number[] {
  const tree = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of table)
      if (!tree.has(p.pid) && (tree.has(p.ppid) || p.pgid === pid)) {
        tree.add(p.pid);
        grew = true;
      }
  }
  tree.delete(process.pid);
  tree.delete(process.ppid);
  return [...tree];
}

// The steps of a kill, written once: TERM to every process list() names, then KILL to what is still
// living after the grace. It yields each wait in ms, and killAll (sleep) or killAllAsync (await)
// runs them. One ps per poll: list() is read again from it, and what it names is added to every
// process seen so far, so a process started meanwhile is caught and one that drops out of the list
// (a descendant reparented when its parent exits, out of the tree but not dead) still gets KILL. A
// seen pid is dropped once ps lists it no more, as a zombie, or as a later start (the pid given out
// again). Returns the pids still living after the KILL.
function* killing(list: (table: Proc[]) => number[], graceMs: number): Generator<number, number[], void> {
  const seen = new Map<number, number>(); // pid → when it started, ms
  const left = () => {
    const now = Date.now();
    const table = processes();
    const byPid = new Map(table.map((p) => [p.pid, p]));
    for (const pid of list(table)) {
      const p = byPid.get(pid);
      if (p && !seen.has(pid)) seen.set(pid, now - p.age * 1000);
    }
    for (const [pid, started] of seen) {
      const p = byPid.get(pid);
      // etime counts whole seconds, so allow the rounding
      if (!p || p.zombie || now - p.age * 1000 > started + 2000) seen.delete(pid);
    }
    return [...seen.keys()];
  };
  signalAll(left(), "SIGTERM");
  for (const end = Date.now() + graceMs; Date.now() < end; yield 100) if (!left().length) return [];
  signalAll(left(), "SIGKILL");
  for (const end = Date.now() + 1000; Date.now() < end; yield 100) if (!left().length) return [];
  return left();
}

// killing, with a wait that blocks: for a caller that is not the parent of what it kills. A parent
// uses killAllAsync, which lets Node reap its children.
export function killAll(list: (table: Proc[]) => number[], graceMs: number): number[] {
  const g = killing(list, graceMs);
  for (let r = g.next(); ; r = g.next()) {
    if (r.done) return r.value;
    sleep(r.value);
  }
}

export async function killAllAsync(list: (table: Proc[]) => number[], graceMs: number): Promise<number[]> {
  const g = killing(list, graceMs);
  for (let r = g.next(); ; r = g.next()) {
    if (r.done) return r.value;
    await delay(r.value);
  }
}

// The tree of pid (treeOf), TERM first, KILL what is left. True when nothing of it is left living.
export function killTree(pid: number, graceMs = 10_000): boolean {
  return killAll((table) => treeOf(pid, table), graceMs).length === 0;
}

export async function killTreeAsync(pid: number, graceMs: number): Promise<number[]> {
  return killAllAsync((table) => treeOf(pid, table), graceMs);
}

// The cgroup v2 hierarchy and the path this process is in ("0::<path>" in /proc/self/cgroup), or
// null without one. SF_CGROUP_ROOT and SF_CGROUP_SELF stand in for them in tests, which may open no
// real scope (test/helpers.ts): a fake systemd-run sets them and writes the pids it puts in.
const cgroupRoot = () => process.env.SF_CGROUP_ROOT || "/sys/fs/cgroup";
export function ownCgroup(): string | null {
  if (process.env.SF_CGROUP_SELF) return process.env.SF_CGROUP_SELF;
  if (process.platform !== "linux") return null;
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
    return line ? line.slice(3).trim() || null : null;
  } catch {
    return null;
  }
}

// The pids in a cgroup v2 path but the caller, [] when there is no such cgroup (its unit has ended
// and been collected). Every process started in it stays in it, whatever its parent or session.
export function cgroupProcs(path: string): number[] {
  try {
    return readFileSync(`${cgroupRoot()}${path}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number).filter((p) => p > 0 && p !== process.pid);
  } catch (e) {
    if (["ENOENT", "ENODEV", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return [];
    throw e;
  }
}

// This boot's id on Linux (a start stamp's first part), null elsewhere.
// SF_BOOT_ID stands in for it in tests, empty for a platform with none.
export function currentBoot(): string | null {
  if (process.env.SF_BOOT_ID !== undefined) return process.env.SF_BOOT_ID || null;
  if (process.platform !== "linux") return null;
  bootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return bootId;
}

export function stopDetached(pidFile: string): string {
  const pid = pidFromFile(pidFile);
  if (pid === null) {
    rmSync(pidFile, { force: true });
    return "nothing was running";
  }
  const ok = killTree(pid);
  rmSync(pidFile, { force: true });
  if (!ok) die(`pid ${pid} or one of its children survived SIGKILL`);
  return `stopped ${pid} and its children`;
}

// Starts cmd detached, its stdout and stderr appended to log, and returns its pid: a session
// leader (setsid), so no caller's process group holds it, and unref'd, so the caller can exit.
export function spawnDetached(cmd: string[], o: { log: string; cwd?: string; env?: NodeJS.ProcessEnv; what?: string }): number {
  const [bin, ...rest] = cmd as [string, ...string[]];
  mkdirSync(dirname(o.log), { recursive: true });
  const fd = openSync(o.log, "a");
  try {
    const child = spawn(bin, rest, { cwd: o.cwd, detached: true, stdio: ["ignore", fd, fd], env: o.env ?? process.env });
    child.on("error", () => {});
    if (child.pid === undefined) die(`cannot start ${o.what ?? bin}${o.cwd ? ` in ${o.cwd}` : ""}`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

export function startDetached(cmd: string[], o: { pidFile: string; log: string; cwd?: string }): number {
  mkdirSync(dirname(o.pidFile), { recursive: true });
  const pid = spawnDetached(cmd, { log: o.log, ...(o.cwd ? { cwd: o.cwd } : {}) });
  writeFileSync(o.pidFile, `${pid}\n`);
  return pid;
}

// The last lines of a log, for an error that says a process it belongs to died; "" when unread.
export function logTail(file: string, lines = 15): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// Held means something accepts a connection. A dev server may listen on IPv4 or IPv6 alone.
function accepts(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    const done = (held: boolean) => {
      s.destroy();
      resolve(held);
    };
    s.setTimeout(1000, () => done(true));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function portHeld(port: number): Promise<boolean> {
  return (await Promise.all([accepts(port, "127.0.0.1"), accepts(port, "::1")])).some(Boolean);
}

// Until the old server lets go, a readiness probe gets its answer from the old server.
export async function waitPortFree(port: number, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; ; await delay(200)) {
    if (!(await portHeld(port))) return true;
    if (Date.now() > end) return false;
  }
}

function answer(target: URL, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const done = (r: IncomingMessage) => {
      r.resume();
      resolve(r.statusCode ?? null);
    };
    // local stacks serve self-signed certificates
    const req = target.protocol === "https:"
      ? httpsGet(target, { rejectUnauthorized: false, timeout: timeoutMs }, done)
      : httpGet(target, { timeout: timeoutMs }, done);
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// Ready is a status below 400, or with `any` a response at all: an app served under a base path
// answers its bare origin with a 404 by design, and waiting for a 2xx there never ends.
export async function waitHttp(url: string, o: { timeoutS: number; any: boolean }): Promise<{ ok: boolean; code: number | null }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return die(`wait-http: ${url} is not a URL`);
  }
  let code: number | null = null;
  for (const end = Date.now() + o.timeoutS * 1000; ; await delay(1000)) {
    code = await answer(target, 5000);
    if (code !== null && (o.any || code < 400)) return { ok: true, code };
    if (Date.now() > end) return { ok: false, code };
  }
}
