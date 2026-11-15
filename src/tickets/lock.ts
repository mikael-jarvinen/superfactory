// One writer at a time for a ticket's log or a wiki page: a check and the write it allows run under
// one lock, so two writers can never both pass the same check. The lock is a flock on a lock file,
// taken without waiting and retried. The kernel drops it when its holder's descriptor closes,
// however the process ends, so there is no stale rule: a lock is never broken by anyone else.
// Nothing slow runs under it (no network: GitHub is asked before it is taken), so a wait is short.
//
// Node has no flock(2). macOS's open(2) takes the same lock atomically with O_EXLOCK. Linux has
// no such flag and would ignore the bit, a lock that always succeeds, so there it is util-linux's
// flock(1) on this descriptor as its fd 3. A flock belongs to the open file description, so it
// outlives flock(1) and goes when this descriptor closes.
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { FactoryError, run, sleep } from "../util.js";

const O_EXLOCK = 0x20;
const HELD = 75;
const WAIT_MS = 10_000;

function tryFlock(path: string): number | null {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o644);
  // -E sets "held by someone else" apart from flock's own failures; -n never waits, so the
  // timeout only catches a flock(1) that hangs
  const r = run(process.env.FLOCK_BIN || "flock", ["-n", "-x", "-E", String(HELD), "3"], { stdio: ["ignore", "ignore", "pipe", fd], timeout: 2000 });
  if (r.status === 0) return fd;
  closeSync(fd);
  if (r.status === HELD) return null;
  throw new FactoryError(`the lock ${path}: flock(1) failed (exit ${r.status}: ${r.stderr.trim()}); it needs util-linux's flock`);
}

// The descriptor holding the lock, or null when someone else holds it. Close the descriptor to
// release it.
export function tryLock(path: string): number | null {
  mkdirSync(dirname(path), { recursive: true });
  if (process.platform === "linux") return tryFlock(path);
  if (process.platform !== "darwin") throw new FactoryError("the file lock is built for macOS and Linux only");
  try {
    return openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
    throw e;
  }
}

export function withLock<T>(lock: string, fn: () => T, waitMs = WAIT_MS): T {
  const start = Date.now();
  let fd: number | null;
  while ((fd = tryLock(lock)) === null) {
    if (Date.now() - start > waitMs) throw new FactoryError(`another writer holds ${lock}; nothing was written, try again`);
    sleep(10);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
  }
}
