// The local tracker's tickets, off unless `[tracker] kind = "local"`. A ticket is an append-only
// log of JSON events at <dir>/tickets/<PROJECT>/<KEY>.jsonl, and what it says now is their fold. A
// number is taken by creating its file with O_EXCL; `.floor` is the lowest a new one may take, so
// numbers of tickets deleted before an import are not handed out again.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { LABEL_RE, PROJECT_KEY_RE, type TrackerProject } from "../config.js";
import { type Actor, checkCreate, checkMove, type MoveProof } from "./guard.js";
import { withLock } from "./lock.js";
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
}

// Every event carries when and who. `by` is the human's name for a write from the board, else the
// agent the CLI ran as.
export type Event = { t: string; by: string } & (
  | { op: "create"; title: string; body: string; state: TicketState; labels: string[]; source?: Record<string, unknown> }
  | { op: "move"; from: TicketState; to: TicketState; asked?: string; merged?: string }
  | { op: "label"; add?: string; rm?: string }
  | { op: "title"; title: string }
  | { op: "describe"; append: string }
  | { op: "body"; body: string }
  | { op: "comment"; id: string; body: string }
  | { op: "relate"; kind: RelationKind; to: string }
  | { op: "unrelate"; kind: RelationKind; to: string }
  | { op: "link"; url: string; title: string | null }
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
const lockOf = (ws: Workspace, key: string) => join(projectDir(ws, parseKey(key).project), ".locks", key);

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
    tk.updated = e.t;
    switch (e.op) {
      case "move": tk.state = e.to; break;
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

export function list(ws: Workspace, project?: string): Ticket[] {
  const keys = project ? [projectOf(ws, project).key] : projects(ws).map((p) => p.key);
  const out: Ticket[] = [];
  for (const p of keys) {
    const d = projectDir(ws, p);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const m = FILE_RE.exec(f);
      if (!m) continue;
      try {
        out.push(load(ws, `${m[1]}-${m[2]}`));
      } catch {
        // a ticket whose log cannot be folded is left out of the list, and `show` says why
      }
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

// The state is read, checked and moved under the ticket's lock, so two moves cannot both start
// from the same state, and the guard never judges a state that has already changed.
export function move(ws: Workspace, key: string, to: TicketState, actor: Actor, proof: MoveProof = {}): { from: TicketState; ticket: Ticket } {
  return withLock(lockOf(ws, key), () => {
    const tk = load(ws, key);
    if (tk.state === to) return { from: to, ticket: tk };
    const ok = checkMove(ws, tk, to, actor, proof);
    append(ws, key, { t: now(), by: actor.name, op: "move", from: tk.state, to, ...(ok.asked ? { asked: ok.asked } : {}), ...(ok.merged ? { merged: ok.merged } : {}) });
    return { from: tk.state, ticket: load(ws, key) };
  });
}

// The writes below change nothing guard.ts rules on; the CLI's actor is still one named agent.

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
