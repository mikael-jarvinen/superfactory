// The local tracker's tickets, off unless `[tracker] kind = "local"`. A ticket is an append-only
// log of JSON events at <dir>/tickets/<PROJECT>/<KEY>.jsonl, and what it says now is their fold. A
// number is taken by creating its file with O_EXCL; `.floor` is the lowest a new one may take, so
// numbers of tickets deleted before an import are not handed out again.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { LABEL_RE, PROJECT_KEY_RE, type TrackerProject } from "../config.js";
import { type Actor, checkCreate, checkMove, checkMoveNow, type MoveProof, type SpentOk, spendsOk } from "./guard.js";
import { withLock } from "./lock.js";
import { between, isClosed, isRank, ordered, spread } from "./rank.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, now } from "../util.js";

export const TICKET_STATES = ["Backlog", "Todo", "In Design", "In Progress", "In Review", "In Testing", "Done", "Cancelled"] as const;
export type TicketState = (typeof TICKET_STATES)[number];
export const RELATION_KINDS = ["blocked_by", "blocks", "relates_to", "duplicate_of"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const MAX_TITLE = 300;
export const MAX_BODY = 2_000_000;

export interface Comment {
  id: string;
  by: string;
  t: string;
  body: string;
}

export interface Relation {
  kind: RelationKind;
  to: string;
}

export interface Link {
  url: string;
  title: string | null;
}

export interface Ticket {
  key: string;
  project: string;
  number: number;
  title: string;
  body: string;
  state: TicketState;
  labels: string[];
  relations: Relation[];
  links: Link[];
  comments: Comment[];
  created: string;
  updated: string;
  by: string;
  // set by an import: where the ticket came from
  source?: Record<string, unknown>;
  // its place in the human's order (rank.ts); a ticket never dragged has none
  rank?: string;
}

// Every event carries when and who. `by` is the human's name for a write from the board, else the
// agent the CLI ran as.
export type Event = { t: string; by: string } & (
  | { op: "create"; title: string; body: string; state: TicketState; labels: string[]; source?: Record<string, unknown> }
  | { op: "move"; from: TicketState; to: TicketState; asked?: string; ok?: string; merged?: string }
  | { op: "label"; add?: string; rm?: string }
  | { op: "title"; title: string }
  | { op: "describe"; append: string }
  | { op: "body"; body: string }
  | { op: "comment"; id: string; body: string }
  | { op: "relate"; kind: RelationKind; to: string }
  | { op: "unrelate"; kind: RelationKind; to: string }
  | { op: "link"; url: string; title: string | null }
  | { op: "rank"; rank: string }
);

export const enabled = (ws: Workspace) => ws.config.tracker.kind === "local";

export function requireEnabled(ws: Workspace): void {
  if (!enabled(ws)) throw new FactoryError(`this workspace has no local tracker: [tracker] kind is ${JSON.stringify(ws.config.tracker.kind)}. ` +
    `Set kind = "local" and at least one [[tracker.projects]] to turn it on.`);
}

export const trackerDir = (ws: Workspace) => ws.config.tracker.dir ?? join(ws.stateDir, "tracker");
export const projectDir = (ws: Workspace, project: string) => join(trackerDir(ws), "tickets", project);
const ticketFile = (ws: Workspace, key: string) => join(projectDir(ws, parseKey(key).project), `${key}.jsonl`);
const floorFile = (ws: Workspace, project: string) => join(projectDir(ws, project), ".floor");

const PK = PROJECT_KEY_RE.source.slice(1, -1);
const KEY_RE = new RegExp(`^(${PK})-([1-9][0-9]{0,6})$`);
const FILE_RE = new RegExp(`^(${PK})-([1-9][0-9]*)\\.jsonl$`);
const lockOf = (ws: Workspace, key: string) => join(projectDir(ws, parseKey(key).project), ".locks", `${key}.lock`);
// One for the workspace, as the oks a Done move checks are read from every project.
const okLockOf = (ws: Workspace) => join(trackerDir(ws), "tickets", ".locks", "done-ok.lock");
// One for the workspace, as a rank is placed among every project's.
const rankLockOf = (ws: Workspace) => join(trackerDir(ws), "tickets", ".locks", "rank.lock");

export function parseKey(key: string): { project: string; number: number } {
  const m = KEY_RE.exec(key);
  if (!m) throw new FactoryError(`${JSON.stringify(key)} is not a ticket key like RPE-12`);
  return { project: m[1] as string, number: Number(m[2]) };
}

export function projects(ws: Workspace): TrackerProject[] {
  return ws.config.tracker.projects;
}

export function projectOf(ws: Workspace, key: string): TrackerProject {
  const p = projects(ws).find((x) => x.key === key);
  if (!p) throw new FactoryError(`no project ${JSON.stringify(key)}; projects: ${projects(ws).map((x) => x.key).join(", ") || "none"}`);
  return p;
}

// A bare number means the only project's ticket, so `factory ticket show 12` works with one project.
export function resolveKey(ws: Workspace, ref: string): string {
  if (/^[1-9][0-9]*$/.test(ref)) {
    const ps = projects(ws);
    if (ps.length !== 1) throw new FactoryError(`${ref}: name the project, as in ${ps[0]?.key ?? "RPE"}-${ref}; there are ${ps.length} projects`);
    return `${(ps[0] as TrackerProject).key}-${ref}`;
  }
  const { project } = parseKey(ref);
  projectOf(ws, project);
  return ref;
}

export function checkLabel(ws: Workspace, project: string, label: string): void {
  const p = projectOf(ws, project);
  if (p.labels ? !p.labels.includes(label) : !LABEL_RE.test(label))
    throw new FactoryError(`${JSON.stringify(label)} is not a label of ${project}` + (p.labels ? `; labels: ${p.labels.join(", ")}` : ": lower-case words, digits, ':' and '-'"));
}

export function checkState(s: string): TicketState {
  if (!(TICKET_STATES as readonly string[]).includes(s)) throw new FactoryError(`unknown state ${JSON.stringify(s)}; states: ${TICKET_STATES.join(", ")}`);
  return s as TicketState;
}

function checkText(what: string, s: string, max: number, empty = false): string {
  if (!empty && !s.trim()) throw new FactoryError(`${what} is empty`);
  if (s.length > max) throw new FactoryError(`${what} is ${s.length} characters, over ${max}`);
  return s;
}

export function fold(key: string, events: Event[]): Ticket {
  const first = events[0];
  if (!first || first.op !== "create") throw new FactoryError(`${key}: its log does not start with a create`);
  const { project, number } = parseKey(key);
  const tk: Ticket = {
    key, project, number, title: first.title, body: first.body, state: first.state, labels: [...first.labels],
    relations: [], links: [], comments: [], created: first.t, updated: first.t, by: first.by,
    ...(first.source ? { source: first.source } : {}),
  };
  for (const e of events.slice(1)) {
    // A new place in the order is not a change to the ticket, so it leaves its waiting time alone. A
    // closed ticket takes none, even from a drop that raced its move.
    if (e.op === "rank") {
      if (isRank(e.rank) && !isClosed(tk.state)) tk.rank = e.rank;
      continue;
    }
    tk.updated = e.t;
    switch (e.op) {
      case "move":
        tk.state = e.to;
        // a closed ticket leaves the order, so a reopened one comes back unranked, at the bottom
        if (isClosed(e.to)) delete tk.rank;
        break;
      case "label":
        if (e.add && !tk.labels.includes(e.add)) tk.labels.push(e.add);
        if (e.rm) tk.labels = tk.labels.filter((l) => l !== e.rm);
        break;
      case "title": tk.title = e.title; break;
      case "describe": tk.body = tk.body ? `${tk.body.replace(/\s+$/, "")}\n\n${e.append}` : e.append; break;
      case "body": tk.body = e.body; break;
      case "comment": tk.comments.push({ id: e.id, by: e.by, t: e.t, body: e.body }); break;
      case "relate":
        if (!tk.relations.some((r) => r.kind === e.kind && r.to === e.to)) tk.relations.push({ kind: e.kind, to: e.to });
        break;
      case "unrelate": tk.relations = tk.relations.filter((r) => !(r.kind === e.kind && r.to === e.to)); break;
      case "link": tk.links.push({ url: e.url, title: e.title }); break;
      case "create": break;
    }
  }
  return tk;
}

export function readEvents(ws: Workspace, key: string): Event[] {
  const f = ticketFile(ws, key);
  if (!existsSync(f)) throw new FactoryError(`no ticket ${key}`);
  // A line cut short by a crash is skipped and the rest still read: append() starts the next event
  // on a line of its own, so one torn write costs that event only.
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
    try {
      return [JSON.parse(l) as Event];
    } catch {
      return [];
    }
  });
}

export const exists = (ws: Workspace, key: string) => existsSync(ticketFile(ws, key));

export const load = (ws: Workspace, key: string): Ticket => fold(key, readEvents(ws, key));

function* keys(ws: Workspace, project?: string): Generator<string> {
  for (const p of project ? [projectOf(ws, project).key] : projects(ws).map((p) => p.key)) {
    const d = projectDir(ws, p);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const m = FILE_RE.exec(f);
      if (m) yield `${m[1]}-${m[2]}`;
    }
  }
}

export function list(ws: Workspace, project?: string): Ticket[] {
  const out: Ticket[] = [];
  for (const key of keys(ws, project)) {
    try {
      out.push(load(ws, key));
    } catch {
      // a ticket whose log cannot be folded is left out of the list, and `show` says why
    }
  }
  return out.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : a.number - b.number));
}

// One write of the whole row, on a line of its own even if the last write was torn short.
function append(ws: Workspace, key: string, e: Event): void {
  const fd = openSync(ticketFile(ws, key), "a+");
  try {
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const lead = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a ? "\n" : "";
    writeSync(fd, `${lead}${JSON.stringify(e)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function readFloor(ws: Workspace, project: string): number {
  try {
    const n = Number(readFileSync(floorFile(ws, project), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

export function setFloor(ws: Workspace, project: string, n: number): void {
  mkdirSync(projectDir(ws, project), { recursive: true });
  if (n > readFloor(ws, project)) writeFileSync(floorFile(ws, project), `${n}\n`);
}

function maxNumber(ws: Workspace, project: string): number {
  const d = projectDir(ws, project);
  if (!existsSync(d)) return 0;
  let max = 0;
  for (const f of readdirSync(d)) {
    const m = FILE_RE.exec(f);
    if (m && m[1] === project) max = Math.max(max, Number(m[2]));
  }
  return max;
}

export interface CreateInput {
  project: string;
  title: string;
  body?: string;
  state?: TicketState;
  labels?: string[];
  // An import keeps the old number and time; anything else takes the next number, now.
  number?: number;
  t?: string;
  source?: Record<string, unknown>;
}

// The guards are here, under every caller: guard.ts decides what the actor may do. Only an
// importer's actor may give a number, a time or a source.
export function create(ws: Workspace, c: CreateInput, actor: Actor): Ticket {
  const p = projectOf(ws, c.project);
  checkCreate(ws, c.state ?? "Backlog", actor);
  if ((c.number !== undefined || c.t !== undefined || c.source !== undefined) && (actor.human || !actor.importer))
    throw new FactoryError("only an import gives a ticket its number, time or source");
  const title = checkText("the title", c.title.trim(), MAX_TITLE);
  const body = checkText("the description", c.body ?? "", MAX_BODY, true);
  const labels = [...new Set(c.labels ?? [])];
  for (const l of labels) checkLabel(ws, p.key, l);
  const dir = projectDir(ws, p.key);
  mkdirSync(dir, { recursive: true });
  const e = (number: number): Event => ({
    t: c.t ?? now(), by: actor.name, op: "create", title, body, state: c.state ?? "Backlog", labels, ...(c.source ? { source: c.source } : {}),
  });
  if (c.number !== undefined) {
    const key = `${p.key}-${c.number}`;
    writeFileSync(join(dir, `${key}.jsonl`), JSON.stringify(e(c.number)) + "\n", { flag: "wx" });
    return load(ws, key);
  }
  for (let n = Math.max(maxNumber(ws, p.key) + 1, readFloor(ws, p.key)); ; n++) {
    const key = `${p.key}-${n}`;
    try {
      writeFileSync(join(dir, `${key}.jsonl`), JSON.stringify(e(n)) + "\n", { flag: "wx" });
      return load(ws, key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

// The oks other tickets' Done moves spent, from every project.
export function spentOks(ws: Workspace, except: string): SpentOk[] {
  const out: SpentOk[] = [];
  for (const key of keys(ws)) {
    if (key === except) continue;
    for (const e of readEvents(ws, key)) if (e.op === "move" && spendsOk(e)) out.push({ key, ok: e.ok as string });
  }
  return out;
}

// GitHub is asked first, without the lock: whether a PR merged does not depend on the ticket's
// state, and a network call never runs under a lock. Then the state is read, checked again and
// moved under the ticket's lock, so two moves cannot both start from the same state, and the
// quote out of Backlog is judged against the state the move really leaves. A move that spends an
// ok also holds the workspace's ok lock, so two tickets cannot spend one message.
export async function move(ws: Workspace, key: string, to: TicketState, actor: Actor, proof: MoveProof = {}): Promise<{ from: TicketState; ticket: Ticket }> {
  const before = load(ws, key);
  if (before.state === to) return { from: to, ticket: before };
  const spent = () => spentOks(ws, key);
  const ok = await checkMove(ws, before, to, actor, proof, spent);
  const write = () => {
    const tk = load(ws, key);
    if (tk.state === to) return { from: to, ticket: tk };
    const re = checkMoveNow(ws, tk, to, actor, proof, spent);
    append(ws, key, { t: now(), by: actor.name, op: "move", from: tk.state, to, ...(re.asked ? { asked: re.asked } : {}), ...(re.ok ? { ok: re.ok } : {}), ...(ok.merged ? { merged: ok.merged } : {}) });
    return { from: tk.state, ticket: load(ws, key) };
  };
  return withLock(lockOf(ws, key), () => (spendsOk({ op: "move", to, ...ok }) ? withLock(okLockOf(ws), write) : write()));
}

// Labels, comments, relations, links and titles are any agent's; a description is appended to by
// an agent and replaced only by the human (rewrite, below).

export function label(ws: Workspace, key: string, op: "add" | "rm", name: string, by: string): { changed: boolean; ticket: Ticket } {
  return withLock(lockOf(ws, key), () => labelLocked(ws, key, op, name, by));
}

function labelLocked(ws: Workspace, key: string, op: "add" | "rm", name: string, by: string): { changed: boolean; ticket: Ticket } {
  const tk = load(ws, key);
  if (op === "add") checkLabel(ws, tk.project, name);
  const has = tk.labels.includes(name);
  if ((op === "add") === has) return { changed: false, ticket: tk };
  append(ws, key, { t: now(), by, op: "label", ...(op === "add" ? { add: name } : { rm: name }) });
  return { changed: true, ticket: load(ws, key) };
}

export function retitle(ws: Workspace, key: string, title: string, by: string): Ticket {
  load(ws, key);
  append(ws, key, { t: now(), by, op: "title", title: checkText("the title", title.trim(), MAX_TITLE) });
  return load(ws, key);
}

// Appends to the description: an agent's addition never replaces what the human wrote.
export function describe(ws: Workspace, key: string, text: string, by: string): Ticket {
  load(ws, key);
  append(ws, key, { t: now(), by, op: "describe", append: checkText("the addition", text.trim(), MAX_BODY) });
  return load(ws, key);
}

// Replaces the description. Only the board offers it, to the human, whose words they are.
export function rewrite(ws: Workspace, key: string, body: string, actor: Actor): Ticket {
  if (!actor.human) throw new FactoryError(`REFUSED: only ${ws.config.human.name} replaces a description; an agent appends with describe.`);
  load(ws, key);
  append(ws, key, { t: now(), by: actor.name, op: "body", body: checkText("the description", body, MAX_BODY, true) });
  return load(ws, key);
}

export function comment(ws: Workspace, key: string, body: string, by: string, extra: { t?: string; id?: string } = {}): Comment {
  load(ws, key);
  const id = extra.id ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const e = { t: extra.t ?? now(), by, op: "comment" as const, id, body: checkText("the comment", body.trim(), MAX_BODY) };
  append(ws, key, e);
  return { id, by, t: e.t, body: e.body };
}

export function relate(ws: Workspace, key: string, kind: RelationKind, to: string, by: string, op: "relate" | "unrelate" = "relate", t?: string): Ticket {
  if (!(RELATION_KINDS as readonly string[]).includes(kind)) throw new FactoryError(`unknown relation ${JSON.stringify(kind)}; relations: ${RELATION_KINDS.join(", ")}`);
  if (to === key) throw new FactoryError(`${key} cannot relate to itself`);
  load(ws, key);
  parseKey(to);
  append(ws, key, { t: t ?? now(), by, op, kind, to });
  return load(ws, key);
}

export function link(ws: Workspace, key: string, url: string, title: string | null, by: string, t?: string): Ticket {
  if (!/^https?:\/\/\S+$/.test(url)) throw new FactoryError(`${JSON.stringify(url)} is not an http(s) link`);
  load(ws, key);
  append(ws, key, { t: t ?? now(), by, op: "link", url, title });
  return load(ws, key);
}

export interface Place {
  after?: string | null;
  before?: string | null;
}

// Puts the ticket right after `after` in the order, or right before `before` when `after` is null,
// as the human dropped it between two visible rows. Rows a filter hides keep their place. A ticket
// dropped among the unranked ones ranks those above it first, in the order they already show, so
// nothing else on the page moves. Only open tickets are placed or ranked.
export function rank(ws: Workspace, key: string, at: Place, by: string): Ticket {
  const anchor = at.after ?? at.before;
  if (!anchor) throw new FactoryError("rank: give the ticket to place it after or before");
  if (anchor === key) throw new FactoryError(`${key} cannot be placed next to itself`);
  if (!exists(ws, anchor)) throw new FactoryError(`no ticket ${anchor}`);
  return withLock(rankLockOf(ws), () => {
    for (const k of [key, anchor]) {
      const st = load(ws, k).state;
      if (isClosed(st)) throw new FactoryError(`${k} is ${st}; only open tickets have a place in the order`);
    }
    const all = ordered(list(ws)).filter((t) => t.key !== key && !isClosed(t.state));
    const i = all.findIndex((t) => t.key === anchor);
    // The anchor can close after the check above, as a move takes the ticket's lock and not this one,
    // and an anchor list() leaves out lands here too. A ticket that closes before its rank is
    // appended keeps none, since fold takes no rank while a ticket is closed.
    if (i < 0) throw new FactoryError(`${anchor} is not in the order (closed or not listed); place ${key} again`);
    let lo = at.after ? all[i] : all[i - 1];
    const hi = at.after ? all[i + 1] : all[i];
    if (lo && lo.rank === undefined) {
      const first = all.findIndex((t) => t.rank === undefined);
      const tail = all.slice(first, all.indexOf(lo) + 1);
      const ranks = spread(all[first - 1]?.rank ?? "", null, tail.length);
      tail.forEach((t, j) => {
        t.rank = ranks[j] as string;
        append(ws, t.key, { t: now(), by, op: "rank", rank: t.rank });
      });
      lo = tail[tail.length - 1];
    }
    append(ws, key, { t: now(), by, op: "rank", rank: between(lo?.rank ?? "", hi?.rank ?? null) });
    return load(ws, key);
  });
}

// Ranks the open, unranked tickets among `keys`, in that order, after every ticket ranked already.
// An import's order is seeded with this once; a ticket with a rank keeps it.
export function seedRanks(ws: Workspace, keys: string[], by: string): string[] {
  return withLock(rankLockOf(ws), () => {
    const tks = list(ws);
    const have = new Set(tks.filter((t) => t.rank === undefined && !isClosed(t.state)).map((t) => t.key));
    const todo = [...new Set(keys)].filter((k) => have.has(k));
    const top = tks.map((t) => t.rank).filter((r): r is string => r !== undefined).sort().pop() ?? "";
    const ranks = spread(top, null, todo.length);
    todo.forEach((k, j) => append(ws, k, { t: now(), by, op: "rank", rank: ranks[j] as string }));
    return todo;
  });
}
