import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { killTree, living, procStat, spawnDetached, stopDetached, writePidFile } from "../src/stacks/process.js";
import { until } from "./helpers.js";

// A leader (its own session and group) whose child starts a grandchild in a group of its own that
// ignores SIGTERM. The TERM ends the leader and the child, so the grandchild is reparented: it is in
// neither the tree nor the leader's group from then on, and must still get the KILL.
async function stubbornGrandchild(dir: string): Promise<{ leader: number; grandchild: number }> {
  const gpid = join(dir, "g.pid");
  writeFileSync(join(dir, "g.sh"), `trap '' TERM; echo $$ > "$1"; while :; do sleep 0.2; done\n`);
  writeFileSync(join(dir, "m.sh"), `setsid sh "${join(dir, "g.sh")}" "$1" & wait\n`);
  const leader = spawnDetached(["sh", "-c", `sh "${join(dir, "m.sh")}" "$1" & wait`, "sh", gpid], { log: join(dir, "log") });
  await until("the grandchild", () => existsSync(gpid) && readFileSync(gpid, "utf8").trim() !== "");
  const grandchild = Number(readFileSync(gpid, "utf8").trim());
  assert.equal(procStat(grandchild)?.pgid, grandchild, "the grandchild leads a group of its own");
  assert.notEqual(procStat(grandchild)?.pgid, leader);
  return { leader, grandchild };
}

const cleanup = (dir: string, pids: number[]) => {
  for (const p of pids)
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // gone
    }
  rmSync(dir, { recursive: true, force: true });
};

test("killTree kills a TERM-ignoring grandchild in its own group whose parent exits on the TERM", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-kill-"));
  const { leader, grandchild } = await stubbornGrandchild(dir);
  try {
    assert.equal(killTree(leader, 1000), true);
    assert.equal(living(grandchild), false, "the reparented grandchild outlived killTree");
    assert.equal(living(leader), false);
  } finally {
    cleanup(dir, [leader, grandchild]);
  }
});

test("stopDetached kills it too", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-kill-"));
  const { leader, grandchild } = await stubbornGrandchild(dir);
  try {
    const pidFile = join(dir, "server.pid");
    writePidFile(pidFile, leader);
    assert.equal(stopDetached(pidFile, 1000), `stopped ${leader} and its children`);
    assert.equal(living(grandchild), false, "the reparented grandchild outlived stopDetached");
  } finally {
    cleanup(dir, [leader, grandchild]);
  }
});
