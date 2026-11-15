// One writer at a time for a ticket's log or a wiki page: a check and the write it allows run under
// one lock, so two writers can never both pass the same check. The lock is a directory, which
// mkdir makes atomically or not at all. A lock older than STALE_MS is a writer that died holding
// it, and is broken.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { FactoryError } from "../util.js";

const STALE_MS = 120_000;
const WAIT_MS = 30_000;
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLock<T>(lock: string, fn: () => T): T {
  mkdirSync(dirname(lock), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
    } catch {
      // gone between the mkdir and the stat: try again
    }
    if (Date.now() - start > WAIT_MS) throw new FactoryError(`another writer holds ${lock}; nothing was written, try again`);
    nap(20);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
