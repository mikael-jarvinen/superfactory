import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type ClaudeInstall, cgroupProcsFile, claudeInstall, cleanUp, isClaude } from "../src/scheduler/leftovers.js";
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
