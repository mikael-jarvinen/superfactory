// On Linux, kills what an ended run left in its process group, as launchd does on macOS, and what
// its claude calls left in their scopes: each runs in factory-job-<label>-<group>-….scope under
// agents.slice (scope.ts), out of the scheduler's cgroup. The unit's
// KillMode=process keeps a run alive across a scheduler restart, so nothing else would. A group is
// touched only while its leader's pid is free, since a live pid means the group belongs to a
// running run or to an unrelated process.
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { claudeBin } from "../fleet.js";
import { jobUnitPrefix } from "../scope.js";
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

// pid's arguments, none when its command line reads empty (a process in exec, or exiting) or cannot be read.
function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
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

// What group pgid left in the scheduler's own cgroup.
function inOwnCgroup(pgid: number, log: (line: string) => void): number[] {
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
  return pids.filter((pid) => pid !== process.pid && procStat(pid)?.pgid === pgid);
}

// This user's agents.slice in the cgroup v2 tree, where every claude call's scope is.
export function agentsSlice(mountinfo = readFileSync("/proc/self/mountinfo", "utf8"), uid = process.getuid?.() ?? 0): string | null {
  for (const line of mountinfo.split("\n")) {
    const [pre, post] = line.split(" - ");
    if (!pre || post?.split(" ")[0] !== "cgroup2") continue;
    const [, , , root, mount] = pre.split(" ");
    if (root === "/" && mount) return `${mount}/user.slice/user-${uid}.slice/user@${uid}.service/agents.slice`.replace(/\/{2,}/g, "/");
  }
  return null;
}

// Everything in the scopes the run's claude calls were given, whatever its process group: the
// scope is the run's by its name. None when there is no such slice or scope.
export function inJobScopes(label: string, pgid: number, slice: string | null): number[] {
  if (!slice) return [];
  const prefix = jobUnitPrefix(label, pgid);
  let names: string[];
  try {
    names = readdirSync(slice).filter((n) => n.startsWith(prefix) && n.endsWith(".scope"));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      return readProcs(`${slice}/${n}/cgroup.procs`);
    } catch {
      return []; // emptied and collected since
    }
  });
}

// The processes left by run pgid of job label, an ended one: in its group in the scheduler's
// cgroup, and in its claude calls' scopes. null, to wait for the next check, when one is left that
// cannot be told from a claude session: there is no claude to tell it by, or its reading is unsure,
// which is the unsure process's pid.
// live holds the pids of runs still recorded as going, whose groups are not to be touched.
interface Wait { unsure: number | null }
function leftovers(label: string, pgid: number, live: Set<number>, log: (line: string) => void, slice: string | null): Leftover[] | Wait {
  if (process.platform !== "linux" || !pgid || procStat(pgid) || live.has(pgid)) return [];
  const inGroup = [...new Set([...inOwnCgroup(pgid, log), ...inJobScopes(label, pgid, slice)])].filter((pid) => pid !== process.pid);
  if (!inGroup.length) return [];
  const c = claudeInstall(claudeBin());
  if (!c) {
    if (!noClaudeSaid) log(`no claude at ${claudeBin()}: leftovers are not killed until one is found, since a claude session among them could not be told apart`);
    noClaudeSaid = true;
    return { unsure: null };
  }
  noClaudeSaid = false;
  const found: Leftover[] = [];
  for (const pid of inGroup) {
    const st = procStat(pid);
    if (!st || st.state === "Z") continue; // gone, or dead already: nothing to kill
    if (underClaude(pid, c)) continue;
    // A process caught in exec, such as a systemd-run becoming the claude it runs, can read with an
    // empty cmdline and so not as a claude, then be one by the time it is signalled. When the reading
    // is unsure (an empty cmdline, or a name that changed under it), the group waits for the next check.
    // The command line is read before the last stat, so an exec after it shows there as a new name
    // (read after it, an exec between the two read as the wrapper's
    // name with claude's command line). And it is told from a claude again after that stat: an exec
    // that keeps the name, as a node wrapper running claude's cli.js does, is a claude by then.
    const argv = cmdline(pid);
    const after = procStat(pid);
    if (!after) continue; // gone
    if (after.comm !== st.comm || (after.state !== "Z" && !argv.length) || underClaude(pid, c)) return { unsure: pid };
    found.push({ pid, comm: st.comm, stamp: startStamp(pid) });
  }
  return found;
}

// SIGTERM, then SIGKILL after graceMs. settled runs once, after this returns if anything was signalled; when
// deferred, keep the group and call again, otherwise forget it. unsure is the pid it deferred on, when
// one read unsure.
// slice is where the run's claude calls' scopes are, agentsSlice() unless a test says otherwise.
export function cleanUp(label: string, pgid: number, live: Set<number>, log: (line: string) => void, settled: (deferred: boolean, unsure?: number) => void, graceMs = 10_000, slice?: string | null): void {
  let found: Leftover[] | Wait;
  try {
    found = leftovers(label, pgid, live, log, slice === undefined ? agentsSlice() : slice);
  } catch (e) {
    log(`job ${label}: leftovers of process group ${pgid} not cleaned up: ${(e as Error).message}`);
    settled(false);
    return;
  }
  if (!Array.isArray(found)) {
    if (found.unsure === null) settled(true);
    else settled(true, found.unsure);
    return;
  }
  if (!found.length) {
    settled(false);
    return;
  }
  log(`job ${label}: ended, leaving ${found.map((p) => `${p.pid} (${p.comm})`).join(", ")} in its process group or scopes; SIGTERM`);
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
