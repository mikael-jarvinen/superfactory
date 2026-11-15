// The board's JSON for the local tracker: /api/tickets and /api/wiki. Every write here is the
// human's, from the board, so the agent guards in guard.ts let it through; a write still goes
// through the store's own checks (states, labels, sizes, the wiki's sha). None of this is routed
// unless the workspace has `[tracker] kind = "local"`.
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import { type Actor, checkMove } from "./guard.js";
import * as T from "./store.js";
import * as W from "../wiki/store.js";

export interface Reply {
  code: number;
  body: unknown;
}

const ok = (body: unknown): Reply => ({ code: 200, body });
const bad = (error: string, code = 400): Reply => ({ code, body: { ok: false, error } });
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new FactoryError(`${what} is missing`);
  return v;
};

export const isTrackerApi = (path: string) => path === "/api/tickets" || path.startsWith("/api/tickets/") || path === "/api/wiki" || path.startsWith("/api/wiki/");

// The board's header: how many tickets wait in Backlog, or null without a local tracker.
export function trackerSummary(ws: Workspace): { backlog: number } | null {
  if (!T.enabled(ws)) return null;
  try {
    return { backlog: T.list(ws).filter((t) => t.state === "Backlog").length };
  } catch {
    return { backlog: 0 };
  }
}

function summary(t: T.Ticket) {
  return {
    key: t.key, project: t.project, number: t.number, title: t.title, state: t.state, labels: t.labels,
    relations: t.relations, comments: t.comments.length, created: t.created, updated: t.updated, by: t.by,
  };
}

function ticketsGet(ws: Workspace, rest: string, q: URLSearchParams): Reply {
  if (!rest && q.has("summary")) return ok(trackerSummary(ws));
  if (!rest) {
    const project = q.get("project") || undefined;
    return ok({
      human: ws.config.human.name,
      projects: T.projects(ws),
      states: T.TICKET_STATES,
      relations: T.RELATION_KINDS,
      tickets: T.list(ws, project).map(summary),
    });
  }
  const key = T.resolveKey(ws, decodeURIComponent(rest));
  if (!T.exists(ws, key)) return bad(`no ticket ${key}`, 404);
  return ok(T.load(ws, key));
}

function ticketsPost(ws: Workspace, rest: string, b: Record<string, unknown>): Reply {
  const human: Actor = { human: true, name: ws.config.human.name };
  if (!rest) {
    const labels = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === "string") : [];
    const state = b.state === undefined ? "Backlog" : T.checkState(str(b.state, "state"));
    const tk = T.create(ws, { project: str(b.project, "project"), title: str(b.title, "title"), body: typeof b.body === "string" ? b.body : "", labels, state, by: human.name });
    return ok({ ok: true, ticket: tk });
  }
  const key = T.resolveKey(ws, decodeURIComponent(rest));
  if (!T.exists(ws, key)) return bad(`no ticket ${key}`, 404);
  let tk: T.Ticket;
  switch (b.op) {
    case "move": {
      const to = T.checkState(str(b.to, "to"));
      checkMove(ws, T.load(ws, key), to, human);
      tk = T.move(ws, key, to, human.name).ticket;
      break;
    }
    case "label": {
      const op = b.add === true ? "add" : "rm";
      tk = T.label(ws, key, op, str(b.name, "name"), human.name).ticket;
      break;
    }
    case "comment":
      T.comment(ws, key, str(b.body, "body"), human.name);
      tk = T.load(ws, key);
      break;
    case "body":
      tk = T.rewrite(ws, key, str(b.body, "body"), human.name);
      break;
    case "title":
      tk = T.retitle(ws, key, str(b.title, "title"), human.name);
      break;
    case "relate": {
      const to = T.resolveKey(ws, str(b.to, "to"));
      if (!T.exists(ws, to)) return bad(`no ticket ${to}`, 404);
      tk = T.relate(ws, key, str(b.kind, "kind") as T.RelationKind, to, human.name, b.remove === true ? "unrelate" : "relate");
      break;
    }
    case "link":
      tk = T.link(ws, key, str(b.url, "url"), typeof b.title === "string" && b.title.trim() ? b.title.trim() : null, human.name);
      break;
    default:
      return bad(`unknown op ${JSON.stringify(b.op)}`);
  }
  return ok({ ok: true, ticket: tk });
}

// /api/wiki/<PROJECT>/<path>
function wikiRef(rest: string): { project: string; path: string } {
  const m = /^([A-Z][A-Z0-9]{1,9})\/(.+)$/.exec(decodeURIComponent(rest));
  if (!m) throw new FactoryError(`${JSON.stringify(rest)} is not PROJECT/page`);
  return { project: m[1] as string, path: W.checkPath(m[2] as string) };
}

function wikiGet(ws: Workspace, rest: string, q: URLSearchParams): Reply {
  if (!rest) {
    const project = q.get("project");
    const ps = project ? [T.projectOf(ws, project)] : T.projects(ws);
    return ok({ projects: T.projects(ws), pages: ps.flatMap((p) => W.list(ws, p.key)) });
  }
  const r = wikiRef(rest);
  if (!W.pageExists(ws, r.project, r.path)) return bad(`no page ${r.project}/${r.path}`, 404);
  return ok({ ...W.read(ws, r.project, r.path), history: W.history(ws, r.project, r.path).slice(-50) });
}

function wikiPost(ws: Workspace, rest: string, b: Record<string, unknown>): Reply {
  const r = wikiRef(rest);
  const base = b.base === null || b.base === undefined ? null : str(b.base, "base");
  try {
    const pg = W.save(ws, { project: r.project, path: r.path, title: str(b.title, "title"), body: str(b.body, "body"), by: ws.config.human.name, base });
    return ok({ ok: true, page: pg });
  } catch (e) {
    if (e instanceof W.Conflict) return { code: 409, body: { ok: false, error: e.message, current: e.current } };
    throw e;
  }
}

// null when the path is not the tracker's, or the workspace has none: the caller answers 404.
export function trackerApi(ws: Workspace, method: string, rawUrl: string, body?: Record<string, unknown>): Reply | null {
  if (!T.enabled(ws)) return null;
  const u = new URL(rawUrl, "http://board");
  const path = u.pathname;
  if (!isTrackerApi(path)) return null;
  const tickets = path.startsWith("/api/tickets");
  const rest = path.slice(tickets ? "/api/tickets".length : "/api/wiki".length).replace(/^\//, "");
  try {
    if (method === "POST") return tickets ? ticketsPost(ws, rest, body ?? {}) : wikiPost(ws, rest, body ?? {});
    return tickets ? ticketsGet(ws, rest, u.searchParams) : wikiGet(ws, rest, u.searchParams);
  } catch (e) {
    if (e instanceof FactoryError) return bad(e.message);
    throw e;
  }
}
