// Board analytics: for every work item, how long it spent in each state, how many times it entered
// each, and the tokens its sessions spent there, per item; and per UTC week (Monday start), calendar
// month and all time, the average per ticket and its median, p80 and p95, so the page can show how
// long a piece of work spends in each state and how that changes from one period to the next.
//
// Time and entries are folded from state/events.jsonl, which every transition already appends to
// with its time, so nothing new is stored. Tokens are read from the Claude Code transcripts of the
// workspace's own sessions, under claude's projects/ by cwd, the same place transport.ts looks:
// each assistant entry carries its API call's usage. A call is attributed to the item and state its
// session was working on at the call's time:
//
// - A transcript in a builder's worktree, <checkout>/.claude/worktrees/<item>, is that item's.
// - A transcript in an agent's own cwd, or a builder's checkout, is the agent's, by the name the
//   session was launched with.
//   Its calls go to the item that agent was on at the time: an item whose record named the agent and
//   was not done. Of several, one in a working state (designing, building, fixing) first, then the
//   one that entered its state last. pr-open, agent-review and gate count as the agent's, as the
//   fixes a review asks for are often made while the item sits there. Off the board (not started, or
//   put aside; queued in older events), and
//   blocked, design-review, your-review and colleague-review (waiting on a human, the agent free
//   for other work) do not: an agent with only such items is doing something else, and its calls are
//   counted as no item's. A worktree's transcripts are its item's in any state.
//
// Every agent counts, wherever it runs. The lead's and the reviewers' sessions are never an item's
// agent, so their calls are counted as theirs with no item, as is any call of an agent with no item
// at the time (unattributed). An agent on another host, and a builder's worktrees in a repo checked
// out on one, write their transcripts there: the board reads them over ssh (remote-transcripts.ts),
// in the background, and a report counts what was read by then. Until a host's first read, or when
// it fails, that host's agents are left out, and the report says why (hosts).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { roleOf } from "../launch.js";
import { allRecs, BUSY, eachEvent, OFF, STATES } from "../state.js";
import { claudeConfigDir } from "../transport.js";
import { realpathLoose } from "../util.js";
import type { Workspace } from "../workspace.js";
import { worktreePath } from "../worktree.js";
import { parseReply, probeFor, type RemoteRead, type Runner, sshRunner } from "./remote-transcripts.js";

export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

const noTokens = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
const addTokens = (a: Tokens, b: Tokens) => {
  a.input += b.input;
  a.output += b.output;
  a.cache_read += b.cache_read;
  a.cache_write += b.cache_write;
};

// One state an item entered: when, and the agent its record named after the change.
export interface Step {
  state: string;
  at: number;
  agent: string | null;
}

// An item's steps in time order, and whether its record still exists. A record that is gone was
// taken off the board, so its last state ends at its last change rather than now.
export interface Timeline {
  ticket: string;
  title: string | null;
  steps: Step[];
  live: boolean;
}

const time = (s: unknown): number => (typeof s === "string" ? Date.parse(s) : NaN);

export function timelines(ws: Workspace): Timeline[] {
  const by = new Map<string, Step[]>();
  let text = "";
  try {
    text = readFileSync(ws.events, "utf8");
  } catch {
    // no events yet
  }
  eachEvent(text, (e) => {
    const at = time(e.t);
    if (typeof e.ticket !== "string" || typeof e.to !== "string" || Number.isNaN(at)) return;
    const steps = by.get(e.ticket) ?? [];
    steps.push({ state: e.to, at, agent: typeof e.agent === "string" ? e.agent : null });
    by.set(e.ticket, steps);
  });
  const recs = new Map(allRecs(ws).map((r) => [r.ticket, r]));
  // A record with no events, written before the log or by hand, counts from its own `since`.
  for (const r of recs.values()) {
    const at = time(r.since);
    if (!by.has(r.ticket) && r.state && !Number.isNaN(at)) by.set(r.ticket, [{ state: r.state, at, agent: r.agent }]);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ticket, steps]) => {
    const rec = recs.get(ticket);
    return { ticket, title: rec?.title ?? null, steps: steps.sort((a, b) => a.at - b.at), live: !!rec };
  });
}

// When a step ends: the next change, now for the current state of a live item, and at once for
// done, which is where an item stops rather than a place it waits.
const stepEnd = (tl: Timeline, i: number, now: number): number => {
  const s = tl.steps[i] as Step;
  if (s.state === "done") return s.at; // even when it was forced back out later
  const next = tl.steps[i + 1];
  if (next) return next.at;
  return tl.live ? Math.max(s.at, now) : s.at;
};

// ---------------------------------------------------------------- transcripts

// One API call: its message id, model, and the part of its cache writes kept for an hour, which
// the weekly estimate (weekly.ts) prices apart from the rest.
export interface Call {
  at: number;
  id: string;
  model: string | null;
  tokens: Tokens;
  write_1h: number;
}

// A call the weekly limit refused: when, and the reset it named.
export interface Hit {
  at: number;
  resets: number;
}

// A transcript's calls, by the file they came from: `host:path` for another host's.
export interface Read {
  file: string;
  agent: string | null;
  calls: Call[];
  hits: Hit[];
}

interface FileRead {
  offset: number;
  agent: string | null;
  ids: Map<string, Call>;
  calls: Call[];
  hits: Hit[];
}

const blank = (): Omit<FileRead, "offset"> => ({ agent: null, ids: new Map(), calls: [], hits: [] });

const CHUNK = 4 * 1024 * 1024;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const fresh = (path: string, since: number) => {
  try {
    return statSync(path).mtimeMs >= since;
  } catch {
    return false;
  }
};

// Claude's projects/ directory name for a cwd, as transport.ts's transcriptAt builds it.
export const projectDirFor = (cwd: string) => join(claudeConfigDir(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

// Every transcript is read incrementally, as one runs to tens of megabytes, and only its assistant
// calls and its session name are kept. An API call's usage is repeated on every content block it
// returned, so a call is counted once by its message id, with the largest of each count seen for it:
// the blocks before the last can carry a partial output count. A resumed session copies a few calls
// of the old one into its new transcript, and those few are counted in both.
// What the board knows of a host's transcripts: the files in each cwd's dir at its last read, and when
// that read finished or why it failed.
export interface HostRead {
  read_at: number | null;
  error: string | null;
  files: number;
}

// The key of a host's listing that holds every projects/ dir there, rather than one cwd's.
export const ACCOUNT = "*";

export class TranscriptUsage {
  private files = new Map<string, FileRead>();
  private hosts = new Map<string, HostRead & { listing: RemoteRead["listing"]; busy: Promise<void> | null }>();

  // The calls in every transcript of a project dir, with the name of the session each came from.
  // A subagent's transcript, under <session>/subagents/, is its session's. A transcript last written
  // before `since` holds no call any item could own, and is not read at all.
  read(dir: string, since = -Infinity): Read[] {
    const out: Read[] = [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return out;
    }
    for (const f of names) {
      if (!f.endsWith(".jsonl") || !fresh(join(dir, f), since)) continue;
      const main = this.readOne(join(dir, f));
      out.push({ file: join(dir, f), agent: main.agent, calls: main.calls, hits: main.hits });
      const sub = join(dir, f.slice(0, -".jsonl".length), "subagents");
      let subs: string[] = [];
      try {
        subs = readdirSync(sub).filter((x) => x.endsWith(".jsonl"));
      } catch {
        // no subagents
      }
      for (const s of subs.filter((x) => fresh(join(sub, x), since))) {
        const one = this.readOne(join(sub, s));
        out.push({ file: join(sub, s), agent: main.agent, calls: one.calls, hits: one.hits });
      }
    }
    return out;
  }

  // The calls in a cwd's transcripts on a host, as of its last read: read() for another machine.
  readOn(host: string, cwd: string): Read[] {
    const out: Read[] = [];
    for (const f of this.hosts.get(host)?.listing[cwd] ?? []) {
      const main = this.state(`${host}:${f.p}`);
      out.push({ file: `${host}:${f.p}`, agent: main.agent, calls: main.calls, hits: main.hits });
      for (const s of f.subs) {
        const one = this.state(`${host}:${s}`);
        out.push({ file: `${host}:${s}`, agent: main.agent, calls: one.calls, hits: one.hits });
      }
    }
    return out;
  }

  // Every transcript of the account, for the weekly usage (weekly.ts): each projects/ dir here,
  // whoever's sessions wrote it, and on each host, as of its last read with `all` (refresh).
  account(since: number): Read[] {
    const base = join(claudeConfigDir(), "projects");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(base);
    } catch {
      // no transcripts here
    }
    const out = dirs.flatMap((d) => this.read(join(base, d), since));
    for (const host of this.hosts.keys()) out.push(...this.readOn(host, ACCOUNT));
    return out;
  }

  hostRead(host: string): HostRead | null {
    const h = this.hosts.get(host);
    return h ? { read_at: h.read_at, error: h.error, files: h.files } : null;
  }

  // Reads what a host's transcripts in these cwds gained since the last read, one read at a time:
  // asked while one is running, it waits for that one. It never rejects; a failure is the host's error.
  // With `all`, it also reads every projects/ dir there last written since then, for account().
  refresh(host: string, cwds: string[], since: number, run: Runner, all?: number): Promise<void> {
    const h = this.hosts.get(host) ?? { read_at: null, error: null, files: 0, listing: {}, busy: null };
    this.hosts.set(host, h);
    if (h.busy) return h.busy;
    const prefix = `${host}:`;
    const offsets: Record<string, number> = {};
    for (const [k, st] of this.files) if (k.startsWith(prefix)) offsets[k.slice(prefix.length)] = st.offset;
    h.busy = run(probeFor({ cwds, since, offsets, ...(all === undefined ? {} : { all }) }))
      .then((out) => {
        const r = parseReply(out);
        for (const [p, d] of Object.entries(r.data)) {
          const st = this.state(prefix + p);
          if (d.reset || d.off < st.offset) Object.assign(st, { offset: 0, ...blank() });
          for (const line of d.lines) this.take(Buffer.from(line, "utf8"), st);
          st.offset = d.off;
        }
        Object.assign(h, { listing: r.listing, read_at: Date.now(), error: null });
        h.files = new Set(Object.values(r.listing).flatMap((fs) => fs.flatMap((f) => [f.p, ...f.subs]))).size;
      })
      .catch((e: unknown) => {
        h.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        h.busy = null;
      });
    return h.busy;
  }

  private state(key: string): FileRead {
    let st = this.files.get(key);
    if (!st) this.files.set(key, (st = { offset: 0, ...blank() }));
    return st;
  }

  private readOne(path: string): FileRead {
    const st = this.state(path);
    let fd: number | undefined;
    try {
      const size = statSync(path).size;
      if (size < st.offset) Object.assign(st, { offset: 0, ...blank() });
      fd = openSync(path, "r");
      let pos = st.offset;
      let carry = Buffer.alloc(0);
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let start = 0;
        for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, start)) {
          this.take(data.subarray(start, nl), st);
          start = nl + 1;
        }
        st.offset += start;
        carry = data.subarray(start);
      }
    } catch {
      // a transcript that vanished or cannot be read keeps what it had
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return st;
  }

  private take(line: Buffer, st: FileRead): void {
    const named = st.agent === null && line.includes('"agent-name"');
    if (!named && !(line.includes('"usage"') && line.includes('"assistant"'))) return;
    let d: Record<string, any>;
    try {
      d = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    if (d.type === "agent-name" && typeof d.agentName === "string") {
      st.agent ??= d.agentName;
      return;
    }
    const u = d.message?.usage;
    const at = time(d.timestamp);
    if (d.type !== "assistant" || !u || Number.isNaN(at)) return;
    const id = String(d.message?.id ?? d.requestId ?? d.uuid ?? "");
    const q = d.quotaLimits;
    if (q?.rateLimitType === "seven_day" && q.status === "rejected" && num(q.resetsAt) > 0) st.hits.push({ at, resets: num(q.resetsAt) * 1000 });
    const tokens = { input: num(u.input_tokens), output: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens), cache_write: num(u.cache_creation_input_tokens) };
    const write_1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
    const model = typeof d.message?.model === "string" ? d.message.model : null;
    const seen = id ? st.ids.get(id) : undefined;
    if (seen) {
      for (const k of Object.keys(tokens) as (keyof Tokens)[]) seen.tokens[k] = Math.max(seen.tokens[k], tokens[k]);
      seen.write_1h = Math.max(seen.write_1h, write_1h);
      seen.model ??= model;
      return;
    }
    const c = { at, id, model, tokens, write_1h };
    if (id) st.ids.set(id, c);
    st.calls.push(c);
  }
}

// Where this workspace's sessions write their transcripts: every agent's own cwd, the lead's and the
// reviewers' too, and each builder's worktree of every item and the checkouts they hang off (a
// session started there is the builder's, on whatever item it was on), each on the machine it runs on. A local
// cwd is given as its projects/ dir, and one on a host as the cwd itself, which that host turns into
// its own dir. A cwd shared by several agents is read once: its sessions carry their agent's name.
// A dir that is both an item's worktree and some agent's cwd is the item's, as the worktree's
// sessions are all that item's; report() also counts each file once, for dirs that are the same only
// on the host (a symlink, or two cwds the dir name spells alike), with the items' sources first.
interface Source {
  host: string | null;
  dir: string;
  item: string | null;
}

function sources(ws: Workspace, items: string[]): Source[] {
  const out = new Map<string, Source>();
  const add = (host: string | null, cwd: string, item: string | null) => {
    const put = (key: string, dir: string) => {
      const had = out.get(key);
      if (!had || (had.item === null && item !== null)) out.set(key, { host, dir, item });
    };
    if (host) return put(`${host}:${cwd}`, cwd);
    for (const p of new Set([cwd, realpathLoose(cwd)])) put(projectDirFor(p), projectDirFor(p));
  };
  for (const a of ws.config.agents) {
    if (a.role === "builder") {
      for (const key of a.repos) {
        const repo = ws.config.repos[key];
        if (!repo || !repo.path) continue;
        for (const it of items) add(repo.host ?? null, worktreePath(repo.path, it), it);
        add(repo.host ?? null, repo.path, null);
      }
      continue;
    }
    const cwd = roleOf(ws, a).cwd;
    if (cwd) add(a.host ?? null, cwd, null);
  }
  return [...out.values()].filter((s) => s.host || existsSync(s.dir)).sort((a, b) => Number(a.item === null) - Number(b.item === null));
}

// Reads every host's transcripts that the workspace's sessions wrote there, all hosts at once.
// `run` is for tests; the board reads over ssh. Resolves when every read has finished or failed.
// What cannot even be asked (the events log, the config) is logged: report() reads the same
// records, so it fails with the same error, which /api/analytics answers and the page shows.
// Every host is read for the weekly usage, which counts every session of the account, back to
// `account` (weekly.ts's WEEKLY_SINCE before now), and for the fleet's cwds as well when it has items.
export function refreshHosts(ws: Workspace, usage: TranscriptUsage, run?: (host: string) => Runner, account?: number): Promise<void> {
  const byHost = new Map<string, string[]>();
  let since = 0;
  try {
    const tls = timelines(ws);
    if (!tls.length && account === undefined) return Promise.resolve();
    if (tls.length) since = Math.min(...tls.map((t) => (t.steps[0] as Step).at));
    if (account !== undefined) for (const h of Object.keys(ws.config.hosts)) byHost.set(h, []);
    for (const s of sources(ws, tls.map((t) => t.ticket))) if (s.host) byHost.set(s.host, [...(byHost.get(s.host) ?? []), s.dir]);
  } catch (e) {
    const why = `the board could not work out what to read: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`analytics: ${why}`);
    return Promise.resolve();
  }
  return Promise.all([...byHost].map(([host, cwds]) =>
    usage.refresh(host, cwds, since, run ? run(host) : sshRunner(ws.config.hosts[host]?.ssh ?? ""), account))).then(() => undefined);
}

// ---------------------------------------------------------------- the report

export interface Cell {
  seconds: number;
  entries: number;
  tokens: Tokens;
}

const noCell = (): Cell => ({ seconds: 0, entries: 0, tokens: noTokens() });
const cellOf = (m: Record<string, Cell>, s: string) => (m[s] ??= noCell());

// The measures a ticket's cell is read by.
export const MEASURES = {
  seconds: (c: Cell) => c.seconds,
  entries: (c: Cell) => c.entries,
  tokens: (c: Cell) => c.tokens.input + c.tokens.output + c.tokens.cache_read + c.tokens.cache_write,
  output: (c: Cell) => c.tokens.output,
};
export type Measure = keyof typeof MEASURES;

// How a measure is spread over n tickets: the mean, and the median, p80 and p95.
export interface Stat {
  n: number;
  mean: number;
  p50: number;
  p80: number;
  p95: number;
}

// The p quantile, 0 to 1, of values sorted ascending, by linear interpolation between the two
// nearest ranks (numpy's default, and Excel's PERCENTILE.INC): one value is every quantile of
// itself, and the median of an even count is the mean of the middle two. NaN for no values.
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = sorted[lo] as number;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] as number;
  return a + (h - lo) * (b - a);
}

// The spread of some tickets' values, or null for none, so no figure is made up for an empty period.
export function stat(values: number[]): Stat | null {
  if (!values.length) return null;
  const v = [...values].sort((x, y) => x - y);
  return { n: v.length, mean: v.reduce((a, x) => a + x, 0) / v.length, p50: quantile(v, 0.5), p80: quantile(v, 0.8), p95: quantile(v, 0.95) };
}

// A stay still open when the report was made: how many tickets are in a state, and the longest so far.
export interface Open {
  n: number;
  longest: number;
}

// One period, or all time, over the stays that ended in it: the totals per state, how many tickets
// ended one, and per state the spread over those tickets of what each spent there, a ticket's stays
// in one state summed so rework counts. `total` is the spread of each ticket's sum over every state.
// Stays still open are in none of it, but counted in `open`, in the period holding now.
export interface Bucket {
  states: Record<string, Cell>;
  tickets: number;
  stats: Record<string, Record<Measure, Stat>>;
  total: Record<Measure, Stat> | null;
  open: Record<string, Open>;
}

function bucket(byTicket: Iterable<Record<string, Cell>>, open: Record<string, Open> = {}): Bucket {
  const tickets = [...byTicket].filter((m) => Object.keys(m).length);
  const states: Record<string, Cell> = {};
  const per = new Map<string, Cell[]>();
  for (const m of tickets) {
    for (const [st, c] of Object.entries(m)) {
      const t = cellOf(states, st);
      t.seconds += c.seconds;
      t.entries += c.entries;
      addTokens(t.tokens, c.tokens);
      per.set(st, [...(per.get(st) ?? []), c]);
    }
  }
  const spread = (cells: Cell[]) => Object.fromEntries((Object.keys(MEASURES) as Measure[]).map((k) => [k, stat(cells.map(MEASURES[k]))])) as Record<Measure, Stat>;
  const stats: Record<string, Record<Measure, Stat>> = {};
  for (const [st, cells] of per) stats[st] = spread(cells);
  const sums = tickets.map((m) => {
    const c = noCell();
    for (const x of Object.values(m)) {
      c.seconds += x.seconds;
      c.entries += x.entries;
      addTokens(c.tokens, x.tokens);
    }
    return c;
  });
  return { states, tickets: tickets.length, stats, total: sums.length ? spread(sums) : null, open };
}

export interface Report {
  states: string[];
  now: number;
  all: Bucket;
  weeks: ({ week: string } & Bucket)[];
  months: ({ month: string } & Bucket)[];
  items: { ticket: string; title: string | null; state: string | null; live: boolean; states: Record<string, Cell> }[];
  unattributed: Record<string, Tokens>;
  // agents on a host whose transcripts the board has not read, and each host's last read
  left_out: string[];
  hosts: Record<string, HostRead>;
}

// States an item waits in while its agent is free: not started, or waiting on a human.
const NOT_ON = new Set(["queued", OFF, "blocked", "design-review", "your-review", "colleague-review"]);

const DAY = 86_400_000;
// The Monday, UTC, of the week holding t.
export const weekOf = (t: number): number => {
  const d = Math.floor(t / DAY) * DAY;
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
};
// The first of the calendar month, UTC, holding t.
export const monthOf = (t: number): number => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

// A period kind: where the period holding t starts, where one starting at `start` ends, and its key.
interface Kind {
  of: (t: number) => number;
  end: (start: number) => number;
  key: (start: number) => string;
}
const WEEK: Kind = { of: weekOf, end: (w) => w + 7 * DAY, key: (w) => new Date(w).toISOString().slice(0, 10) };
const MONTH: Kind = {
  of: monthOf,
  end: (m) => { const d = new Date(m); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); },
  key: (m) => new Date(m).toISOString().slice(0, 7),
};

// Each ticket's cells per state for each period of one kind, from the stays that ended in it. A stay
// counts whole in the period it ended, however far back it began, so a past period is final.
class Periods {
  private m = new Map<number, Map<string, Record<string, Cell>>>();
  constructor(private kind: Kind) {}

  // The cell of a ticket's stays in a state that ended at t.
  at(t: number, ticket: string, state: string): Cell {
    const p = this.kind.of(t);
    let m = this.m.get(p);
    if (!m) this.m.set(p, (m = new Map()));
    let c = m.get(ticket);
    if (!c) m.set(ticket, (c = {}));
    return cellOf(c, state);
  }

  // Every period from the one holding the first recorded change to the one holding now, oldest
  // first. A period with nothing in it is listed empty rather than left out, and with no history at
  // all the list is the current period alone. The stays open now are counted in the period holding now.
  list(now: number, first: number, open: Record<string, Open>): ({ key: string } & Bucket)[] {
    const have = [...this.m.keys()];
    const cur = this.kind.of(now);
    const last = Math.max(cur, ...have);
    const out: ({ key: string } & Bucket)[] = [];
    for (let p = Math.min(cur, Number.isFinite(first) ? this.kind.of(first) : cur, ...have); p <= last; p = this.kind.end(p)) out.push({ key: this.kind.key(p), ...bucket(this.m.get(p)?.values() ?? [], p === cur ? open : {}) });
    return out;
  }
}

// The item and state an agent was on at t: its record named the agent and was in a state the agent
// works in. A working state first, then the latest entered.
function onAt(byAgent: Map<string, { tl: Timeline; i: number; end: number }[]>, agent: string, t: number): { tl: Timeline; i: number } | null {
  let best: { tl: Timeline; i: number } | null = null;
  let bestKey = -Infinity;
  for (const r of byAgent.get(agent) ?? []) {
    const s = r.tl.steps[r.i] as Step;
    if (t < s.at || t >= r.end || NOT_ON.has(s.state)) continue;
    const key = (BUSY.has(s.state) ? 1e15 : 0) + s.at;
    if (key > bestKey) [best, bestKey] = [r, key];
  }
  return best;
}

// The step an item was in at t, or -1 before its first.
function stepAt(tl: Timeline, t: number): number {
  let i = -1;
  for (const st of tl.steps) {
    if (st.at > t) break;
    i++;
  }
  return i;
}

export function report(ws: Workspace, usage: TranscriptUsage, now = Date.now()): Report {
  const tls = timelines(ws);
  const periods = [new Periods(WEEK), new Periods(MONTH)];
  const [weeks, months] = periods as [Periods, Periods];
  const items = new Map<string, Record<string, Cell>>();
  // what each ticket spent in its closed stays, for the all-time averages
  const closed = new Map<string, Record<string, Cell>>();
  const open: Record<string, Open> = {};
  const isOpen = (tl: Timeline, i: number) => tl.live && i === tl.steps.length - 1 && (tl.steps[i] as Step).state !== "done";
  // a stay is counted in a period when it has a known end: any but an item's last, the last of a
  // live item once done, and done itself even after the item is taken off the board, as done ends
  // at its own time
  const ended = (tl: Timeline, i: number) =>
    !isOpen(tl, i) && (tl.live || i < tl.steps.length - 1 || (tl.steps[i] as Step).state === "done");
  const byAgent = new Map<string, { tl: Timeline; i: number; end: number }[]>();
  for (const tl of tls) {
    const m: Record<string, Cell> = {};
    items.set(tl.ticket, m);
    tl.steps.forEach((s, i) => {
      const end = stepEnd(tl, i, now);
      cellOf(m, s.state).entries++;
      cellOf(m, s.state).seconds += (end - s.at) / 1000;
      // the stay counts whole where it ended; one still open counts as open only, and the last
      // state of an item taken off the board has no known end, unless it is done, so it is in no period
      if (isOpen(tl, i)) {
        const o = (open[s.state] ??= { n: 0, longest: 0 });
        o.n++;
        o.longest = Math.max(o.longest, (end - s.at) / 1000);
      } else if (ended(tl, i)) {
        const all = closed.get(tl.ticket) ?? {};
        closed.set(tl.ticket, all);
        for (const c of [...periods.map((p) => p.at(end, tl.ticket, s.state)), cellOf(all, s.state)]) {
          c.entries++;
          c.seconds += (end - s.at) / 1000;
        }
      }
      if (s.agent && s.state !== "done") {
        const l = byAgent.get(s.agent) ?? [];
        // a done item's agent may still be named, but the agent has moved on
        l.push({ tl, i, end: tl.steps[i + 1] ? end : tl.live ? Infinity : end });
        byAgent.set(s.agent, l);
      }
    });
  }
  // Calls before the first recorded change could be no item's, so they are not counted, even as
  // unattributed; nor are sessions named for no agent in the fleet, a probe or a human's own.
  const since = Math.min(...tls.map((t) => (t.steps[0] as Step).at));
  const fleet = new Set(ws.config.agents.map((a) => a.name));
  const unattributed: Record<string, Tokens> = {};
  const byTicket = new Map(tls.map((t) => [t.ticket, t]));
  const srcs = tls.length ? sources(ws, tls.map((t) => t.ticket)) : [];
  const counted = new Set<string>();
  for (const { host, dir, item } of srcs) {
    for (const f of host ? usage.readOn(host, dir) : usage.read(dir, since)) {
      if (counted.has(f.file)) continue;
      counted.add(f.file);
      if (!item && !(f.agent && fleet.has(f.agent))) continue;
      for (const c of f.calls) {
        if (c.at < since) continue;
        let hit: { tl: Timeline; i: number } | null = null;
        if (item) {
          const tl = byTicket.get(item) as Timeline;
          const i = stepAt(tl, c.at);
          hit = i >= 0 ? { tl, i } : null;
        } else hit = onAt(byAgent, f.agent as string, c.at);
        if (!hit) {
          addTokens((unattributed[f.agent ?? item ?? "?"] ??= noTokens()), c.tokens);
          continue;
        }
        const st = hit.tl.steps[hit.i] as Step;
        addTokens(cellOf(items.get(hit.tl.ticket) as Record<string, Cell>, st.state).tokens, c.tokens);
        // a call is its stay's, so it counts where the stay ended, and not while the stay is open
        if (ended(hit.tl, hit.i)) {
          const end = stepEnd(hit.tl, hit.i, now);
          for (const p of periods) addTokens(p.at(end, hit.tl.ticket, st.state).tokens, c.tokens);
          addTokens(cellOf(closed.get(hit.tl.ticket) as Record<string, Cell>, st.state).tokens, c.tokens);
        }
      }
    }
  }
  const hosts: Record<string, HostRead> = {};
  // only hosts with something to read: one with none is never read, and is no one's reason
  for (const h of new Set(srcs.flatMap((x) => (x.host ? [x.host] : [])))) hosts[h] = usage.hostRead(h) ?? { read_at: null, error: null, files: 0 };
  // a host read once keeps counting what it read, though a later read failed
  const unread = (h: string | null | undefined) => !!h && hosts[h]?.read_at == null;
  const left_out = ws.config.agents
    .filter((a) => unread(a.host) || (a.role === "builder" && a.repos.some((k) => unread(ws.config.repos[k]?.host))))
    .map((a) => a.name);
  const recs = new Map(allRecs(ws).map((r) => [r.ticket, r]));
  return {
    // queued was once a state, and older events still name it.
    states: ["queued", OFF, ...STATES],
    now,
    all: bucket(closed.values(), open),
    weeks: weeks.list(now, since, open).map(({ key, ...b }) => ({ week: key, ...b })),
    months: months.list(now, since, open).map(({ key, ...b }) => ({ month: key, ...b })),
    items: tls.map((tl) => ({
      ticket: tl.ticket, title: tl.title, live: tl.live,
      state: recs.get(tl.ticket)?.state ?? (tl.steps[tl.steps.length - 1]?.state ?? null),
      states: items.get(tl.ticket) as Record<string, Cell>,
    })),
    unattributed,
    left_out,
    hosts,
  };
}
