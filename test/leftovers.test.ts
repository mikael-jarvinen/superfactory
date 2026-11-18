import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentsSlice, type ClaudeInstall, cgroupProcsFile, claudeInstall, cleanUp, isClaude } from "../src/scheduler/leftovers.js";
import { procStat } from "../src/stacks/process.js";
import { linuxOnly, noCleanup, runningNotZombie } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "leftovers-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a claude is known by the script node runs, wherever it comes among node's options", { skip: linuxOnly }, async () => {
  const script = join(dir, "cli.js");
  writeFileSync(script, "setInterval(() => {}, 1e6);\n");
  const c = claudeInstall(script) as ClaudeInstall;
  const npm = spawn(process.execPath, ["--max-old-space-size=100", "-r", "node:fs", script], { stdio: "ignore" });
  // preloaded as an --opt=value: the value is what names it
  const preloaded = spawn(process.execPath, [`--require=${script}`, "-e", ""], { stdio: "ignore" });
  const other = spawn("sleep", ["600"], { stdio: "ignore" });
  try {
    await settle(300);
    assert.notEqual(readFileSync(`/proc/${npm.pid}/comm`, "utf8").trim(), "claude", "its name is not claude");
    assert.equal(isClaude(npm.pid as number, c), true);
    assert.equal(isClaude(preloaded.pid as number, c), true);
    assert.equal(isClaude(other.pid as number, c), false);
  } finally {
    for (const p of [npm, preloaded, other]) p.kill("SIGKILL");
  }
});

test("a claude that renames itself, as the npm bundle does, is known by its name", { skip: linuxOnly }, async () => {
  const script = join(dir, "titled", "cli.js");
  mkdirSync(join(dir, "titled"), { recursive: true });
  writeFileSync(script, 'process.title = "claude";\nsetInterval(() => {}, 1e6);\n');
  const c = claudeInstall(script) as ClaudeInstall;
  const npm = spawn(process.execPath, [script], { stdio: "ignore" });
  const other = spawn("sleep", ["600"], { stdio: "ignore" });
  try {
    await settle(300);
    assert.equal(readFileSync(`/proc/${npm.pid}/comm`, "utf8").trim(), "claude");
    assert.ok(!readFileSync(`/proc/${npm.pid}/cmdline`, "utf8").includes("cli.js"), "nothing left to read the script from");
    assert.equal(isClaude(npm.pid as number, c), true);
    assert.equal(isClaude(other.pid as number, c), false);
  } finally {
    npm.kill("SIGKILL");
    other.kill("SIGKILL");
  }
});

// The stand-in for an older claude is a renamed copy of sh.
function shToCopy(): { sh: string } | { skip: string } {
  if (linuxOnly) return { skip: linuxOnly };
  let sh: string;
  try {
    sh = realpathSync("/bin/sh");
    accessSync(sh, constants.R_OK);
  } catch (e) {
    return { skip: `no readable /bin/sh to copy (${(e as Error).message})` };
  }
  if (/busybox/.test(sh)) return { skip: `/bin/sh is ${sh}, which a renamed copy cannot run as` };
  return { sh };
}
const shCopy = shToCopy();

test("an older claude version, since updated away and deleted, is still claude", { skip: "skip" in shCopy && shCopy.skip }, async () => {
  if ("skip" in shCopy) return;
  const versions = join(dir, "share", "claude", "versions");
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, "2.0.0"), "");
  // not sleep: a multicall sleep (uutils) decides what to run from its file name. A copy of sh,
  // waiting in its read builtin, stays the copy.
  copyFileSync(shCopy.sh, join(versions, "1.0.0"));
  chmodSync(join(versions, "1.0.0"), 0o755);
  const old = spawn(join(versions, "1.0.0"), ["-c", "read x"], { stdio: ["pipe", "ignore", "ignore"] });
  const other = spawn("sleep", ["600"], { stdio: "ignore" });
  // a file in the install is not claude's bin: reading one does not make a process claude
  mkdirSync(join(versions, "x"));
  writeFileSync(join(versions, "x", "log"), "");
  const tail = spawn("tail", ["-f", join(versions, "x", "log")], { stdio: "ignore" });
  try {
    await settle(300);
    unlinkSync(join(versions, "1.0.0"));
    const copy = `${join(realpathSync(versions), "1.0.0")} (deleted)`;
    assert.equal(readlinkSync(`/proc/${old.pid}/exe`), copy);
    assert.notEqual(readFileSync(`/proc/${old.pid}/comm`, "utf8").trim(), "claude");
    const c = claudeInstall(join(versions, "2.0.0")) as ClaudeInstall;
    assert.equal(c.dir, join(realpathSync(dir), "share", "claude"));
    assert.equal(isClaude(old.pid as number, c), true);
    assert.equal(isClaude(other.pid as number, c), false);
    assert.equal(isClaude(tail.pid as number, c), false);
    assert.equal(readlinkSync(`/proc/${old.pid}/exe`), copy, "still the copy, not something it ran");
  } finally {
    for (const p of [old, other, tail]) p.kill("SIGKILL");
  }
});

test("without a claude, a group with nothing left is forgotten, and one with something left waits", { skip: noCleanup() }, async () => {
  const bin = process.env.CLAUDE_BIN;
  const ended = async (cmd: string) => {
    const sh = spawn("sh", ["-c", cmd], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const out = await new Promise<string>((r) => sh.stdout.once("data", (b) => r(String(b))));
    if (sh.exitCode === null) await new Promise((r) => sh.once("exit", r));
    return { pgid: sh.pid as number, left: Number(out.trim()) };
  };
  const outcome = (pgid: number) => new Promise<boolean>((r) => cleanUp("t", pgid, new Set(), () => {}, r, 200));
  const empty = await ended("echo 0");
  const full = await ended("sleep 600 >/dev/null 2>&1 & echo $!");
  try {
    process.env.CLAUDE_BIN = join(dir, "no-such-claude");
    assert.equal(await outcome(empty.pgid), false, "nothing to judge, so no claude is needed");
    assert.equal(await outcome(full.pgid), true, "deferred");
    assert.ok(runningNotZombie(full.left), "left alone");
  } finally {
    if (bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = bin;
    process.kill(full.left, "SIGKILL");
  }
});

// A run's claude calls each run in a scope of their own, out of the scheduler's cgroup, and named
// after the run (scope.ts). The slice here is a stand-in directory, its cgroup.procs listing real
// processes. Everything is in a session of its own, so only the scope can tie it to the run.
test("what a run's claude calls left in their scopes is cleaned up, but a supervisor among it is not", { skip: noCleanup() }, async () => {
  const bin = process.env.CLAUDE_BIN;
  const at = join(dir, "scoped");
  mkdirSync(join(at, "bin"), { recursive: true });
  const claude = join(at, "bin", "claude");
  writeFileSync(claude, `#!/bin/sh\nsleep 600 &\necho $! > ${join(at, "child.pid")}\nwait\n`);
  chmodSync(claude, 0o755);
  const sh = spawn("sh", ["-c", `setsid ${claude} >/dev/null 2>&1 & echo $!; setsid sleep 600 >/dev/null 2>&1 & echo $!; setsid sleep 600 >/dev/null 2>&1 & echo $!`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  sh.stdout.on("data", (b) => (out += b));
  await new Promise((r) => sh.once("close", r)); // exited, and its output read
  const pgid = sh.pid as number; // its leader is gone, as an ended run's is
  const [supervisor, orphan, other] = out.trim().split("\n").map(Number) as [number, number, number];
  const pid = (f: string) => Number(readFileSync(join(at, f), "utf8"));
  const slice = join(at, "agents.slice");
  const scope = (name: string, pids: number[]) => {
    mkdirSync(join(slice, name), { recursive: true });
    writeFileSync(join(slice, name, "cgroup.procs"), pids.map((p) => `${p}\n`).join(""));
  };
  try {
    const t0 = Date.now();
    // until each has its own session and has exec'd past setsid: sh echoed the pid before either
    const comm = (p: number) => (existsSync(`/proc/${p}/comm`) ? readFileSync(`/proc/${p}/comm`, "utf8").trim() : "");
    const settledOut = () => existsSync(join(at, "child.pid")) && [supervisor, orphan, other].every((p) => procStat(p)?.pgid === p) &&
      comm(supervisor) === "claude" && comm(orphan) === "sleep" && comm(other) === "sleep";
    while (!settledOut() && Date.now() - t0 < 5000) await settle(20);
    const child = pid("child.pid");
    assert.equal(readFileSync(`/proc/${supervisor}/comm`, "utf8").trim(), "claude");
    assert.notEqual(procStat(orphan)?.pgid, pgid, "out of the run's group");
    scope(`factory-job-a.b_c-${pgid}-77-1.scope`, [supervisor, child, orphan]);
    scope(`factory-job-a.b_c-${pgid + 1}-77-1.scope`, [other]); // another run's
    process.env.CLAUDE_BIN = claude;
    const lines: string[] = [];
    const outcome = (s: string | null) => new Promise<boolean>((r) => cleanUp("a.b c", pgid, new Set(), (l) => lines.push(l), r, 200, s));
    assert.equal(await outcome(null), false, "no slice, nothing found");
    assert.deepEqual(lines, []);
    assert.equal(await outcome(slice), false);
    assert.deepEqual(lines, [`job a.b c: ended, leaving ${orphan} (sleep) in its process group or scopes; SIGTERM`]);
    const t1 = Date.now();
    while (runningNotZombie(orphan) && Date.now() - t1 < 5000) await settle(20);
    assert.ok(!runningNotZombie(orphan), "the orphan is gone");
    assert.ok(runningNotZombie(supervisor), "the supervisor is left alone");
    assert.ok(runningNotZombie(child), "and so is what runs under it");
    assert.ok(runningNotZombie(other), "and another run's scope is not this run's");
  } finally {
    if (bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = bin;
    for (const p of [supervisor, orphan, other, existsSync(join(at, "child.pid")) ? pid("child.pid") : 0]) {
      try {
        if (p) process.kill(p, "SIGKILL");
      } catch {}
    }
  }
});

// CodeRabbit on superfactory#128 (KJJs): the command line was read after the last stat, so a wrapper
// that exec'd claude between the two read as the wrapper by its name and as a process by its
// claude command line, and was killed. exec keeps the pid and start time, so nothing after caught it.
// The exec is staged through /proc reads: once its command line has been read (telling it from a
// claude), the stray's stat is read for the hop to its parent and then for the last look; right
// after that look, its name, stat and command line are claude's.
test("a stray that execs claude between the reads is not killed, the group waits", { skip: noCleanup() }, async () => {
  const bin = process.env.CLAUDE_BIN;
  const at = join(dir, "exec-race");
  mkdirSync(join(at, "bin"), { recursive: true });
  const claude = join(at, "bin", "claude");
  writeFileSync(claude, "#!/bin/sh\nexec sleep 600\n");
  chmodSync(claude, 0o755);
  const sh = spawn("sh", ["-c", "setsid sleep 600 >/dev/null 2>&1 & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  sh.stdout.on("data", (b) => (out += b));
  await new Promise((r) => sh.once("close", r));
  const pgid = sh.pid as number;
  const stray = Number(out.trim());
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const orig = fs.readFileSync;
  try {
    const t0 = Date.now();
    while (!(procStat(stray)?.pgid === stray && readFileSync(`/proc/${stray}/comm`, "utf8").trim() === "sleep") && Date.now() - t0 < 5000) await settle(20);
    const slice = join(at, "agents.slice");
    mkdirSync(join(slice, `factory-job-t-${pgid}-1-1.scope`), { recursive: true });
    writeFileSync(join(slice, `factory-job-t-${pgid}-1-1.scope`, "cgroup.procs"), `${stray}\n`);
    process.env.CLAUDE_BIN = claude;
    let argvRead = false;
    let stats = 0; // reads of its stat since its command line was first read
    const execd = () => stats >= 2;
    (fs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...a: Parameters<typeof orig>) {
      const p = String(a[0]);
      if (p === `/proc/${stray}/stat`) {
        const real = orig.apply(this, a) as string;
        const was = execd();
        if (argvRead) stats++;
        return was ? real.replace("(sleep)", "(claude)") : real;
      }
      if (execd() && p === `/proc/${stray}/comm`) return "claude\n";
      if (p === `/proc/${stray}/cmdline`) {
        argvRead = true;
        if (execd()) return `${claude}\0`;
      }
      return orig.apply(this, a);
    };
    syncBuiltinESMExports();
    const lines: string[] = [];
    const outcome = await new Promise<[boolean, number | undefined]>((r) => cleanUp("t", pgid, new Set(), (l) => lines.push(l), (d, u) => r([d, u]), 200, slice));
    fs.readFileSync = orig;
    syncBuiltinESMExports();
    assert.ok(execd(), `the stray's stat was read ${stats} times after its command line`);
    assert.deepEqual(lines, [], "nothing signalled");
    assert.deepEqual(outcome, [true, stray], "deferred on the stray");
    await settle(300);
    assert.ok(runningNotZombie(stray), "left alone");
  } finally {
    fs.readFileSync = orig;
    syncBuiltinESMExports();
    if (bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = bin;
    try {
      process.kill(stray, "SIGKILL");
    } catch {}
  }
});

test("agents.slice is under the user's manager, at the cgroup v2 mount", () => {
  assert.equal(agentsSlice(pureV2, 1000), "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice");
  assert.equal(agentsSlice(hybrid, 1000), "/sys/fs/cgroup/unified/user.slice/user-1000.slice/user@1000.service/agents.slice");
  assert.equal(agentsSlice(hybrid.split("\n")[2] as string, 1000), null, "no cgroup2 mount");
});

const pureV2 = "29 1 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:4 - cgroup2 cgroup2 rw,nsdelegate\n";
const hybrid = [
  "24 1 0:21 / /sys/fs/cgroup ro,nosuid,nodev,noexec shared:9 - tmpfs tmpfs ro,mode=755",
  "25 24 0:22 / /sys/fs/cgroup/unified rw,nosuid,nodev,noexec,relatime shared:10 - cgroup2 cgroup2 rw,nsdelegate",
  "26 24 0:23 / /sys/fs/cgroup/systemd rw,nosuid,nodev,noexec,relatime shared:11 - cgroup cgroup rw,xattr,name=systemd",
].join("\n");
const unit = "/user.slice/user-1000.slice/user@1000.service/app.slice/factory-scheduler.service";

test("the cgroup v2 mount comes from mountinfo", () => {
  assert.equal(cgroupProcsFile(`0::${unit}\n`, pureV2), `/sys/fs/cgroup${unit}/cgroup.procs`);
  assert.equal(cgroupProcsFile(`12:name=systemd:${unit}\n0::${unit}\n`, hybrid), `/sys/fs/cgroup/unified${unit}/cgroup.procs`);
  assert.equal(cgroupProcsFile(`12:name=systemd:${unit}\n`, hybrid), null, "no v2 line");
  assert.equal(cgroupProcsFile(`0::${unit}\n`, hybrid.split("\n")[2] as string), null, "no cgroup2 mount");
});
