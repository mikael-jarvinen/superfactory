import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { tryLock } from "../src/board/inbox.js";

const dir = mkdtempSync(join(tmpdir(), "inbox-lock-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const INBOX = new URL("../src/board/inbox.js", import.meta.url).href;

test("the inbox lock shuts out another process, and goes when its holder is killed", { skip: !["darwin", "linux"].includes(process.platform) && "the inbox lock is built for macOS and Linux only" }, async () => {
  const path = join(dir, "inbox.lock");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    const { tryLock } = await import(${JSON.stringify(INBOX)});
    console.log(tryLock(${JSON.stringify(path)}) === null ? "refused" : "held");
    setInterval(() => {}, 1e6);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    // settles on the child's exit too, so a holder that dies before it prints fails the test, not hangs it
    const said = await new Promise<string>((res) => {
      holder.stdout.once("data", (b) => res(String(b).trim()));
      holder.once("exit", (code, sig) => res(`exited ${code ?? sig}`));
    });
    assert.equal(said, "held");
    assert.equal(tryLock(path), null, "held by the other process");
  } finally {
    holder.kill("SIGKILL");
  }
  if (holder.exitCode === null && holder.signalCode === null) await new Promise((r) => holder.once("exit", r));
  const fd = tryLock(path);
  assert.notEqual(fd, null, "released when the holder died");
  assert.equal(tryLock(path), null, "a second descriptor in the same process is refused too");
  closeSync(fd as number);
  const again = tryLock(path);
  assert.notEqual(again, null, "released on close");
  closeSync(again as number);
});

test("the inbox lock without flock(1) throws, rather than reading as free", { skip: process.platform !== "linux" && "flock(1) is the Linux way" }, () => {
  const bin = process.env.FLOCK_BIN;
  process.env.FLOCK_BIN = "/nonexistent";
  try {
    assert.throws(() => tryLock(join(dir, "no-flock.lock")), /the inbox lock: flock\(1\) failed \(exit 127: .*ENOENT/);
  } finally {
    if (bin === undefined) delete process.env.FLOCK_BIN;
    else process.env.FLOCK_BIN = bin;
  }
});
