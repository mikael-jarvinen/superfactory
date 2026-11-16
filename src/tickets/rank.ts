// The order the human gives the tickets by dragging them on /tickets, which is also the order the
// round dispatches Todo in. A rank is a base-36 fraction written without its "0.", so ranks compare
// as strings and a ticket moved between two others takes a rank between theirs, and no other
// ticket's rank changes. A rank never ends in "0", so there is always room below it.
const D = "0123456789abcdefghijklmnopqrstuvwxyz";
const RANK_RE = /^[0-9a-z]*[1-9a-z]$/;

export const isRank = (r: unknown): r is string => typeof r === "string" && RANK_RE.test(r);

// A rank strictly between lo and hi: lo "" is the start, hi null the end. lo < hi.
export function between(lo: string, hi: string | null): string {
  if (hi !== null) {
    let n = 0;
    while ((lo[n] ?? "0") === hi[n]) n++;
    if (n > 0) return hi.slice(0, n) + between(lo.slice(n), hi.slice(n));
  }
  const a = lo ? D.indexOf(lo[0] as string) : 0;
  const b = hi !== null ? D.indexOf(hi[0] as string) : D.length;
  if (b - a > 1) return D[Math.round((a + b) / 2)] as string;
  if (hi !== null && hi.length > 1) return hi[0] as string;
  return (D[a] as string) + between(lo.slice(1), null);
}

// n ranks between lo and hi, in order and evenly spread, so seeding many keeps each one short.
export function spread(lo: string, hi: string | null, n: number): string[] {
  if (n <= 0) return [];
  const m = between(lo, hi);
  const left = spread(lo, m, Math.floor((n - 1) / 2));
  return [...left, m, ...spread(m, hi, n - 1 - left.length)];
}

interface Rankable {
  key: string;
  state: string;
  rank?: string;
  updated: string;
}

// Done and Cancelled are read as a history, so they keep no rank and list after the open tickets.
export const isClosed = (state: string) => state === "Done" || state === "Cancelled";

// The one order: open tickets ranked by rank, then the unranked ones, longest-waiting first, then
// the closed ones, newest first. /tickets and `factory ticket list` (so the round's queue) both list
// in it.
export function compare(a: Rankable, b: Rankable): number {
  const ca = isClosed(a.state), cb = isClosed(b.state);
  if (ca !== cb) return ca ? 1 : -1;
  if (ca) {
    if (a.updated !== b.updated) return a.updated > b.updated ? -1 : 1;
  } else if (a.rank !== undefined || b.rank !== undefined) {
    if (a.rank === undefined) return 1;
    if (b.rank === undefined) return -1;
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  } else if (a.updated !== b.updated) return a.updated < b.updated ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export const ordered = <T extends Rankable>(tks: T[]): T[] => [...tks].sort(compare);
