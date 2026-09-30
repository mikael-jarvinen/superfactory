import { spawn } from "node:child_process";
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

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  age: number;
}

// ps's etime: [[dd-]hh:]mm:ss
function seconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? (etime.split("-") as [string, string]) : ["0", etime];
  return Number(days) * 86400 + clock.split(":").reduce((s, p) => s * 60 + Number(p), 0);
}

function processes(): Proc[] {
  const r = run("ps", ["-A", "-o", "pid=,ppid=,pgid=,etime="]);
  if (r.status !== 0) die(`ps failed: ${r.stderr.trim()}`);
  return r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 4)
    .map(([pid, ppid, pgid, etime]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), age: seconds(etime as string) }));
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

// The process, its descendants, and anything left in its process group: a child whose parent died
// first is reparented and only the group still ties it to the tree. TERM first, KILL what is left.
export function killTree(pid: number, graceMs = 10_000): boolean {
  const table = processes();
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
  const signal = (sig: NodeJS.Signals) => {
    for (const p of tree) {
      try {
        process.kill(p, sig);
      } catch {
        // already gone
      }
    }
  };
  const gone = () => ![...tree].some(alive);
  signal("SIGTERM");
  for (const end = Date.now() + graceMs; Date.now() < end; sleep(100)) if (gone()) return true;
  signal("SIGKILL");
  sleep(200);
  return gone();
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

export function startDetached(cmd: string[], o: { pidFile: string; log: string; cwd?: string }): number {
  const [bin, ...rest] = cmd as [string, ...string[]];
  mkdirSync(dirname(o.log), { recursive: true });
  mkdirSync(dirname(o.pidFile), { recursive: true });
  const fd = openSync(o.log, "a");
  try {
    // detached makes the child a session leader (setsid), so no caller's process group holds it
    const child = spawn(bin, rest, { cwd: o.cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.on("error", () => {});
    if (child.pid === undefined) die(`cannot start ${bin}${o.cwd ? ` in ${o.cwd}` : ""}`);
    child.unref();
    writeFileSync(o.pidFile, `${child.pid}\n`);
    return child.pid;
  } finally {
    closeSync(fd);
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
