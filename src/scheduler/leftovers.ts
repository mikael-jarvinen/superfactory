// On Linux, kills what an ended run left in its process group, as launchd does on macOS. The unit's
// KillMode=process keeps a run alive across a scheduler restart, so nothing else would. A group is
// touched only while its leader's pid is free, since a live pid means the group belongs to a
// running run or to an unrelated process.
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { claudeBin } from "../fleet.js";
import { procStat, signalAll, startStamp } from "../stacks/process.js";

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

export interface ClaudeInstall {
  bin: string;
  // dir is the directory holding versions/ when bin is in one (a native install).
  dir: string | null;
}

export function claudeInstall(path: string): ClaudeInstall | null {
  const bin = real(path);
  if (!bin) return null;
  return { bin, dir: basename(dirname(bin)) === "versions" ? dirname(dirname(bin)) : null };
}

const ofClaude = (p: string, c: ClaudeInstall) => p === c.bin || (!!c.dir && p.startsWith(c.dir + sep));

// Whether pid is a claude: named claude, or running an executable of the install (an older version
// after an update, or one replaced and since deleted, counts), or with an argument naming claude's
// bin, such as the cli.js node runs, after any of node's options.
export function isClaude(pid: number, c: ClaudeInstall): boolean {
  try {
    if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "claude") return true;
  } catch {
    return false;
  }
  try {
    if (ofClaude(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ""), c)) return true;
  } catch {
    // another user's process, or gone: its cmdline may still say
  }
  let argv: string[];
  try {
    argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return false;
  }
  return argv.some((arg, i) => {
    const a = i > 0 && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg; // --opt=value: the value
    if (!isAbsolute(a) && !a.includes("/")) return false;
    const p = isAbsolute(a) ? a : resolve(real(`/proc/${pid}/cwd`) ?? "/", a);
    return (real(p) ?? p) === c.bin;
  });
}

// Whether pid is a claude or runs under one. A process whose claude has died and that was
// reparented is no longer under it.
function underClaude(pid: number, c: ClaudeInstall): boolean {
  for (let p = pid, hops = 0; p > 1 && hops < 64; hops++) {
    if (isClaude(p, c)) return true;
    const st = procStat(p);
    if (!st) return false;
    p = st.ppid;
  }
  return false;
}

// cgroup.procs of the cgroup v2 that /proc/self/cgroup names, found by where mountinfo has cgroup2
// mounted (/sys/fs/cgroup, or /sys/fs/cgroup/unified on a hybrid host). null when there is none.
export function cgroupProcsFile(cgroup: string, mountinfo: string): string | null {
  const rel = cgroup.split("\n").find((l) => l.startsWith("0::"))?.slice(3);
  if (rel === undefined) return null;
  for (const line of mountinfo.split("\n")) {
    const [pre, post] = line.split(" - ");
    if (!pre || post?.split(" ")[0] !== "cgroup2") continue;
    const [, , , root, mount] = pre.split(" ");
    if (!root || !mount) continue;
    if (root !== "/" && rel !== root && !rel.startsWith(`${root}/`)) continue; // the mount shows another part of the tree
    return `${mount}${root === "/" ? rel : rel.slice(root.length)}/cgroup.procs`.replace(/\/{2,}/g, "/");
  }
  return null;
}

interface Leftover {
  pid: number;
  comm: string;
  stamp: string | null;
}

let noClaudeSaid = false;

const readProcs = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);

// This process's own cgroup.procs, or why it cannot be read.
export function ownCgroupProcs(): { file: string; pids: number[] } | { none: string } {
  try {
    const file = cgroupProcsFile(readFileSync("/proc/self/cgroup", "utf8"), readFileSync("/proc/self/mountinfo", "utf8"));
    if (!file) return { none: "none mounted, or none named for this process" };
    return { file, pids: readProcs(file) };
  } catch (e) {
    return { none: (e as Error).message };
  }
}

// this process's cgroup.procs, or null once it is known there is none to go by
let cgroupProcs: string | null | undefined;
const noCgroup = (why: string, log: (line: string) => void) => {
  cgroupProcs = null;
  log(`no cgroup v2 for the scheduler (${why}): leftovers are not killed and will not be retried`);
};

// The processes left in group pgid, an ended run's; null when one is left and there is no claude to
// tell a session from a leftover. live holds the pids of runs still recorded as going, whose groups
// are not to be touched.
function leftovers(pgid: number, live: Set<number>, log: (line: string) => void): Leftover[] | null {
  if (process.platform !== "linux" || !pgid || procStat(pgid) || live.has(pgid)) return [];
  let pids: number[];
  if (cgroupProcs === undefined) {
    const own = ownCgroupProcs();
    if (!("file" in own)) {
      noCgroup(own.none, log);
      return [];
    }
    cgroupProcs = own.file;
    pids = own.pids;
  } else if (!cgroupProcs) {
    return [];
  } else {
    try {
      pids = readProcs(cgroupProcs);
    } catch (e) {
      noCgroup((e as Error).message, log);
      return [];
    }
  }
  const inGroup = pids.filter((pid) => pid !== process.pid && procStat(pid)?.pgid === pgid);
  if (!inGroup.length) return [];
  const c = claudeInstall(claudeBin());
  if (!c) {
    if (!noClaudeSaid) log(`no claude at ${claudeBin()}: leftovers are not killed until one is found, since a claude session among them could not be told apart`);
    noClaudeSaid = true;
    return null;
  }
  noClaudeSaid = false;
  const found: Leftover[] = [];
  for (const pid of inGroup) {
    const st = procStat(pid);
    if (st && !underClaude(pid, c)) found.push({ pid, comm: st.comm, stamp: startStamp(pid) });
  }
  return found;
}

// SIGTERM, then SIGKILL after graceMs. settled runs once, after this returns if anything was signalled; when
// deferred, keep the group and call again, otherwise forget it.
export function cleanUp(label: string, pgid: number, live: Set<number>, log: (line: string) => void, settled: (deferred: boolean) => void, graceMs = 10_000): void {
  let found: Leftover[] | null;
  try {
    found = leftovers(pgid, live, log);
  } catch (e) {
    log(`job ${label}: leftovers of process group ${pgid} not cleaned up: ${(e as Error).message}`);
    settled(false);
    return;
  }
  if (!found) {
    settled(true);
    return;
  }
  if (!found.length) {
    settled(false);
    return;
  }
  log(`job ${label}: ended, leaving ${found.map((p) => `${p.pid} (${p.comm})`).join(", ")} in its process group; SIGTERM`);
  // only what is still the same process: its pid may have gone to another since
  const same = (ps: Leftover[]) =>
    ps.filter((p) => {
      try {
        return p.stamp !== null && startStamp(p.pid) === p.stamp;
      } catch {
        return false;
      }
    });
  signalAll(same(found).map((p) => p.pid), "SIGTERM");
  setTimeout(() => {
    const still = same(found);
    if (still.length) {
      log(`job ${label}: ${still.map((p) => p.pid).join(", ")} outlived SIGTERM; SIGKILL`);
      signalAll(still.map((p) => p.pid), "SIGKILL");
    }
    settled(false);
  }, graceMs).unref();
}
