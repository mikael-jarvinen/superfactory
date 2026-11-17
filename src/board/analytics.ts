// Board analytics: for every work item, how long it spent in each state, how many times it entered
// each, and the tokens its sessions spent there, per item and per week.
//
// Time and entries are folded from state/events.jsonl, which every transition already appends to
// with its time, so nothing new is stored. Tokens are read from the Claude Code transcripts of the
// workspace's own sessions, under claude's projects/ by cwd, the same place transport.ts looks:
// each assistant entry carries its API call's usage. A call is attributed to the item and state its
// session was working on at the call's time:
//
// - A transcript in a builder's worktree, <checkout>/.claude/worktrees/<item>, is that item's.
// - A transcript in an agent's own cwd is the agent's, by the name the session was launched with.
//   Its calls go to the item that agent was on at the time: an item whose record named the agent and
//   was not done. Of several, one in a working state (designing, building, fixing) first, then the
//   one that entered its state last. pr-open, agent-review and gate count as the agent's, as the
//   fixes a review asks for are often made while the item sits there. queued (not started), and
//   blocked, design-review, your-review and colleague-review (waiting on a human, the agent free
//   for other work) do not: an agent with only such items is doing something else, and its calls are
//   counted as no item's. A worktree's transcripts are its item's in any state.
//
// Left out: the lead and the reviewers, who are never an item's agent; agents on another host and
// repos checked out on one, whose transcripts are not on this machine; and calls with no item at the
// time, which are counted as unattributed.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { roleOf } from "../launch.js";
import { allRecs, BUSY, STATES } from "../state.js";
import { claudeConfigDir } from "../transport.js";
import { realpathLoose } from "../util.js";
import type { Workspace } from "../workspace.js";
import { worktreePath } from "../worktree.js";

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
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { t?: unknown; ticket?: unknown; to?: unknown; agent?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line torn by a crash costs that event only
    }
    const at = time(e.t);
    if (typeof e.ticket !== "string" || typeof e.to !== "string" || Number.isNaN(at)) continue;
    const steps = by.get(e.ticket) ?? [];
    steps.push({ state: e.to, at, agent: typeof e.agent === "string" ? e.agent : null });
    by.set(e.ticket, steps);
  }
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
  const next = tl.steps[i + 1];
  if (next) return next.at;
  const s = tl.steps[i] as Step;
  return s.state === "done" || !tl.live ? s.at : Math.max(s.at, now);
};

// ---------------------------------------------------------------- transcripts

interface Call {
  at: number;
  tokens: Tokens;
}

interface FileRead {
  offset: number;
  agent: string | null;
  ids: Map<string, Tokens>;
  calls: Call[];
}

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
export class TranscriptUsage {
  private files = new Map<string, FileRead>();

  // The calls in every transcript of a project dir, with the name of the session each came from.
  // A subagent's transcript, under <session>/subagents/, is its session's. A transcript last written
  // before `since` holds no call any item could own, and is not read at all.
  read(dir: string, since = -Infinity): { agent: string | null; calls: Call[] }[] {
    const out: { agent: string | null; calls: Call[] }[] = [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return out;
    }
    for (const f of names) {
      if (!f.endsWith(".jsonl") || !fresh(join(dir, f), since)) continue;
      const main = this.readOne(join(dir, f));
      out.push({ agent: main.agent, calls: main.calls });
      const sub = join(dir, f.slice(0, -".jsonl".length), "subagents");
      let subs: string[] = [];
      try {
        subs = readdirSync(sub).filter((x) => x.endsWith(".jsonl"));
      } catch {
        // no subagents
      }
      for (const s of subs.filter((x) => fresh(join(sub, x), since))) out.push({ agent: main.agent, calls: this.readOne(join(sub, s)).calls });
    }
    return out;
  }

  private readOne(path: string): FileRead {
    let st = this.files.get(path);
    if (!st) this.files.set(path, (st = { offset: 0, agent: null, ids: new Map(), calls: [] }));
    let fd: number | undefined;
    try {
      const size = statSync(path).size;
      if (size < st.offset) Object.assign(st, { offset: 0, agent: null, ids: new Map(), calls: [] });
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
    const tokens = { input: num(u.input_tokens), output: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens), cache_write: num(u.cache_creation_input_tokens) };
    const seen = id ? st.ids.get(id) : undefined;
    if (seen) {
      for (const k of Object.keys(tokens) as (keyof Tokens)[]) seen[k] = Math.max(seen[k], tokens[k]);
      return;
    }
    if (id) st.ids.set(id, tokens);
    st.calls.push({ at, tokens });
  }
}

// The transcripts this workspace's sessions write here: every local agent's own cwd but the lead's
// and the reviewers', and each local builder's worktree of every item.
function sources(ws: Workspace, items: string[]): { dir: string; item: string | null }[] {
  const out = new Map<string, string | null>();
  const add = (cwd: string, item: string | null) => {
    for (const p of new Set([cwd, realpathLoose(cwd)])) out.set(projectDirFor(p), item);
  };
  for (const a of ws.config.agents) {
    if (a.host || a.role === "lead" || a.role === "reviewer") continue;
    if (a.role === "builder") {
      for (const key of a.repos) {
        const repo = ws.config.repos[key];
        if (!repo || repo.host || !repo.path) continue;
        for (const it of items) add(worktreePath(repo.path, it), it);
      }
      continue;
    }
    const cwd = roleOf(ws, a).cwd;
    if (cwd && !out.has(projectDirFor(cwd))) add(cwd, null);
  }
  return [...out.entries()].filter(([d]) => existsSync(d)).map(([dir, item]) => ({ dir, item }));
}

// ---------------------------------------------------------------- the report

export interface Cell {
  seconds: number;
  entries: number;
  tokens: Tokens;
}

const noCell = (): Cell => ({ seconds: 0, entries: 0, tokens: noTokens() });
const cellOf = (m: Record<string, Cell>, s: string) => (m[s] ??= noCell());

export interface Report {
  states: string[];
  now: number;
  weeks: { week: string; states: Record<string, Cell> }[];
  items: { ticket: string; title: string | null; state: string | null; live: boolean; states: Record<string, Cell> }[];
  unattributed: Record<string, Tokens>;
  left_out: string[];
}

// States an item waits in while its agent is free: not started, or waiting on a human.
const NOT_ON = new Set(["queued", "blocked", "design-review", "your-review", "colleague-review"]);

const DAY = 86_400_000;
// The Monday, UTC, of the week holding t.
export const weekOf = (t: number): number => {
  const d = Math.floor(t / DAY) * DAY;
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
};
const weekKey = (t: number) => new Date(t).toISOString().slice(0, 10);

// The item and state an agent was on at t: its record named the agent and was in a state the agent
// works in. A working state first, then the latest entered.
function onAt(byAgent: Map<string, { tl: Timeline; i: number; end: number }[]>, agent: string, t: number): { tl: Timeline; state: string } | null {
  let best: { tl: Timeline; i: number } | null = null;
  let bestKey = -Infinity;
  for (const r of byAgent.get(agent) ?? []) {
    const s = r.tl.steps[r.i] as Step;
    if (t < s.at || t >= r.end || NOT_ON.has(s.state)) continue;
    const key = (BUSY.has(s.state) ? 1e15 : 0) + s.at;
    if (key > bestKey) [best, bestKey] = [r, key];
  }
  return best ? { tl: best.tl, state: (best.tl.steps[best.i] as Step).state } : null;
}

// The state an item was in at t, or null before its first.
function stateAt(tl: Timeline, t: number): string | null {
  let s: string | null = null;
  for (const st of tl.steps) {
    if (st.at > t) break;
    s = st.state;
  }
  return s;
}

export function report(ws: Workspace, usage: TranscriptUsage, now = Date.now()): Report {
  const tls = timelines(ws);
  const weeks = new Map<number, Record<string, Cell>>();
  const week = (t: number) => {
    const w = weekOf(t);
    let m = weeks.get(w);
    if (!m) weeks.set(w, (m = {}));
    return m;
  };
  const items = new Map<string, Record<string, Cell>>();
  const byAgent = new Map<string, { tl: Timeline; i: number; end: number }[]>();
  for (const tl of tls) {
    const m: Record<string, Cell> = {};
    items.set(tl.ticket, m);
    tl.steps.forEach((s, i) => {
      const end = stepEnd(tl, i, now);
      cellOf(m, s.state).entries++;
      cellOf(week(s.at), s.state).entries++;
      cellOf(m, s.state).seconds += (end - s.at) / 1000;
      // the time is split at week boundaries, so a long wait shows in every week it spans
      for (let a = s.at; a < end;) {
        const b = Math.min(end, weekOf(a) + 7 * DAY);
        cellOf(week(a), s.state).seconds += (b - a) / 1000;
        a = b;
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
  for (const { dir, item } of tls.length ? sources(ws, tls.map((t) => t.ticket)) : []) {
    for (const f of usage.read(dir, since)) {
      if (!item && !(f.agent && fleet.has(f.agent))) continue;
      for (const c of f.calls) {
        if (c.at < since) continue;
        let hit: { tl: Timeline; state: string } | null = null;
        if (item) {
          const tl = byTicket.get(item) as Timeline;
          const s = stateAt(tl, c.at);
          hit = s ? { tl, state: s } : null;
        } else hit = onAt(byAgent, f.agent as string, c.at);
        if (!hit) {
          addTokens((unattributed[f.agent ?? item ?? "?"] ??= noTokens()), c.tokens);
          continue;
        }
        addTokens(cellOf(items.get(hit.tl.ticket) as Record<string, Cell>, hit.state).tokens, c.tokens);
        addTokens(cellOf(week(c.at), hit.state).tokens, c.tokens);
      }
    }
  }
  const left_out = ws.config.agents.filter((a) => a.role === "lead" || a.role === "reviewer" || a.host).map((a) => a.name);
  const recs = new Map(allRecs(ws).map((r) => [r.ticket, r]));
  return {
    states: [...STATES],
    now,
    weeks: [...weeks.entries()].sort(([a], [b]) => a - b).map(([w, states]) => ({ week: weekKey(w), states })),
    items: tls.map((tl) => ({
      ticket: tl.ticket, title: tl.title, live: tl.live,
      state: recs.get(tl.ticket)?.state ?? (tl.steps[tl.steps.length - 1]?.state ?? null),
      states: items.get(tl.ticket) as Record<string, Cell>,
    })),
    unattributed,
    left_out,
  };
}
