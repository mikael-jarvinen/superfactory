// The local tracker's wiki: one markdown file a page, <dir>/wiki/<PROJECT>/<path>.md, which cat and
// grep read. Each save appends the whole page to .history/<path>.jsonl first. A save names the sha
// it started from and is refused if the page changed since; the check and the write share a lock.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Workspace } from "../workspace.js";
import { FactoryError, now } from "../util.js";
import { PROJECT_KEY_RE } from "../config.js";
import { withLock } from "../tickets/lock.js";
import { MAX_BODY, MAX_TITLE, projectOf, trackerDir } from "../tickets/store.js";

export interface Page {
  project: string;
  path: string;
  title: string;
  body: string;
  sha: string;
  updated: string;
}

export interface PageEntry {
  project: string;
  path: string;
  title: string;
  updated: string;
}

const PATH_RE = /^[a-z0-9][a-z0-9-]{0,79}(\/[a-z0-9][a-z0-9-]{0,79}){0,5}$/;
// PROJECT/path, as the CLI and the board name a page.
export const PAGE_REF_RE = new RegExp(`^(${PROJECT_KEY_RE.source.slice(1, -1)})\\/(.+)$`);

export function checkPath(path: string): string {
  if (!PATH_RE.test(path)) throw new FactoryError(`${JSON.stringify(path)} is not a page path: lower-case words and '-', with '/' for a child page`);
  return path;
}

export function slug(title: string): string {
  const s = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return s || "page";
}

export const wikiDir = (ws: Workspace, project: string) => join(trackerDir(ws), "wiki", projectOf(ws, project).key);
const pageFile = (ws: Workspace, project: string, path: string) => join(wikiDir(ws, project), `${checkPath(path)}.md`);
const historyFile = (ws: Workspace, project: string, path: string) => join(wikiDir(ws, project), ".history", `${checkPath(path)}.jsonl`);

export const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function render(title: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body.replace(/\s+$/, "")}\n`;
}

export function parse(text: string): { title: string | null; body: string } {
  const m = /^---\ntitle: (.*)\n---\n\n?/.exec(text);
  if (!m) return { title: null, body: text };
  let title: string | null;
  try {
    title = JSON.parse(m[1] as string) as string;
  } catch {
    title = (m[1] as string).trim();
  }
  return { title, body: text.slice(m[0].length) };
}

export function read(ws: Workspace, project: string, path: string): Page {
  const f = pageFile(ws, project, path);
  if (!existsSync(f)) throw new FactoryError(`no page ${project}/${path}`);
  const text = readFileSync(f, "utf8");
  const { title, body } = parse(text);
  return { project: projectOf(ws, project).key, path, title: title ?? path, body, sha: sha(text), updated: statSync(f).mtime.toISOString() };
}

export const pageExists = (ws: Workspace, project: string, path: string) => existsSync(pageFile(ws, project, path));

export function list(ws: Workspace, project: string): PageEntry[] {
  const root = wikiDir(ws, project);
  const out: PageEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      if (f.startsWith(".")) continue;
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${f}/`);
      else if (f.endsWith(".md")) {
        const path = `${prefix}${f.slice(0, -3)}`;
        if (!PATH_RE.test(path)) continue;
        const { title } = parse(readFileSync(full, "utf8"));
        out.push({ project: projectOf(ws, project).key, path, title: title ?? path, updated: statSync(full).mtime.toISOString() });
      }
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface SaveInput {
  project: string;
  path: string;
  title: string;
  body: string;
  by: string;
  // The sha the editor started from; null for a new page. A mismatch is refused.
  base: string | null;
  t?: string;
}

export class Conflict extends FactoryError {
  constructor(readonly current: Page) {
    super(`${current.project}/${current.path} changed since it was opened; nothing was saved`);
  }
}

export function save(ws: Workspace, s: SaveInput): Page {
  const title = s.title.trim();
  if (!title) throw new FactoryError("the title is empty");
  if (title.length > MAX_TITLE) throw new FactoryError(`the title is ${title.length} characters, over ${MAX_TITLE}`);
  if (s.body.length > MAX_BODY) throw new FactoryError(`the page is ${s.body.length} characters, over ${MAX_BODY}`);
  const f = pageFile(ws, s.project, s.path);
  const text = render(title, s.body);
  return withLock(join(wikiDir(ws, s.project), ".locks", s.path.replace(/\//g, "~")), () => {
    if (existsSync(f)) {
      const cur = read(ws, s.project, s.path);
      // A retry of a save that landed finds its own text: that is the save, not a conflict.
      if (cur.sha === sha(text)) return cur;
      if (s.base !== cur.sha) throw new Conflict(cur);
    } else if (s.base !== null) {
      throw new FactoryError(`no page ${s.project}/${s.path} to save over; it was moved or never made`);
    }
    // History first: a page is never on disk without its history line.
    const h = historyFile(ws, s.project, s.path);
    mkdirSync(dirname(h), { recursive: true });
    appendFileSync(h, JSON.stringify({ t: s.t ?? now(), by: s.by, sha: sha(text), title, body: s.body }) + "\n");
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, f);
    return read(ws, s.project, s.path);
  });
}

export function history(ws: Workspace, project: string, path: string): { t: string; by: string; sha: string }[] {
  const h = historyFile(ws, project, path);
  if (!existsSync(h)) return [];
  return readFileSync(h, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
    try {
      const r = JSON.parse(l) as { t: string; by: string; sha: string };
      return [{ t: r.t, by: r.by, sha: r.sha }];
    } catch {
      return [];
    }
  });
}
