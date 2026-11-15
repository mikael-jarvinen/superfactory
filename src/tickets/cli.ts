// `factory ticket` and `factory wiki`: the local tracker from a shell. Both refuse at once in a
// workspace without `[tracker] kind = "local"`, which keeps working exactly as before.
import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import { checkCreate, checkMove, cliActor } from "./guard.js";
import * as T from "./store.js";
import * as W from "../wiki/store.js";

export const TICKET_USAGE = `  ticket ...                      the local tracker, when [tracker] kind = "local"; else refused.
                                  <ref> is PROJ-12, or 12 with one project.
    list [--project P] [--state S]... [--label L] [--all]
                                  open tickets (all states with --all), one line each
    show <ref> [--json]           the whole ticket: description, labels, relations, links, comments
    comments <ref>                its comments only
    create --project P --title T [--body B | --body-file F] [--label L]... [--as A]
                                  file into Backlog; an agent files nowhere else
    move <ref> <State> [--asked "<the human's words>"] [--merged '#<pr>'] [--as A]
                                  out of Backlog needs --asked, quoting the human; onward out of
                                  In Review needs the merged PR. Back to work from In Review is free.
    label <ref> add|rm <name> [--as A]
    describe <ref> (<text> | --file F) [--as A]
                                  append to the description; it is never replaced from here
    comment <ref> (<text> | --file F) [--as A]
    relate <ref> blocked_by|blocks|relates_to|duplicate_of <ref> [--remove] [--as A]
    link <ref> <url> [title] [--as A]
    title <ref> <new title> [--as A]
  wiki ...                        the wiki of the local tracker. <page> is PROJ/path, or path with one project.
    list [--project P]            every page, by path
    show <page> [--json]          the page as markdown, with its sha
    edit <page> --file F [--title T] [--base <sha>] [--as A]
                                  save the file as the page; an existing page needs --base, the
                                  sha \`show\` printed, and is refused if it changed since
    history <page>                who saved it when`;

type Options = NonNullable<ParseArgsConfig["options"]>;

function parse(cmd: string, argv: string[], options: Options, min: number, max: number) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new FactoryError(`${cmd}: ${(e as Error).message}`, 2);
  }
  if (parsed.positionals.length < min) throw new FactoryError(`${cmd}: missing arguments; see factory --help`, 2);
  if (parsed.positionals.length > max) throw new FactoryError(`${cmd}: unexpected ${parsed.positionals.slice(max).join(" ")}`, 2);
  return { v: parsed.values as Record<string, string | boolean | string[] | undefined>, p: parsed.positionals };
}

const s = (v: unknown) => (typeof v === "string" ? v : undefined);
const as = { as: { type: "string" } } as const;

function textArg(cmd: string, positional: string | undefined, file: unknown): string {
  if (positional !== undefined && file !== undefined) throw new FactoryError(`${cmd}: give the text or --file, not both`, 2);
  if (typeof file === "string") return readFileSync(file, "utf8");
  if (positional === undefined) throw new FactoryError(`${cmd}: missing the text; give it, or --file`, 2);
  return positional;
}

const ago = (iso: string) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d` : `${h}h`;
};

export function showTicket(tk: T.Ticket): string[] {
  const out = [`${tk.key}  ${tk.state}  ${tk.title}`];
  out.push(`  labels: ${tk.labels.join(", ") || "-"}   created ${tk.created} by ${tk.by}   updated ${tk.updated}`);
  for (const r of tk.relations) out.push(`  ${r.kind} ${r.to}`);
  for (const l of tk.links) out.push(`  link: ${l.url}${l.title ? `  (${l.title})` : ""}`);
  out.push("", tk.body.trim() || "(no description)", "");
  out.push(`-- ${tk.comments.length} comment${tk.comments.length === 1 ? "" : "s"}${tk.comments.length ? `: factory ticket comments ${tk.key}` : ""}`);
  return out;
}

export function cmdTicket(ws: Workspace, argv: string[]): number {
  T.requireEnabled(ws);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list": {
      const { v } = parse("ticket list", rest, { project: { type: "string" }, state: { type: "string", multiple: true }, label: { type: "string" }, all: { type: "boolean" } }, 0, 0);
      const states = ((v.state as string[] | undefined) ?? []).map(T.checkState);
      let tks = T.list(ws, s(v.project));
      if (states.length) tks = tks.filter((t) => states.includes(t.state));
      else if (!v.all) tks = tks.filter((t) => t.state !== "Done" && t.state !== "Cancelled");
      if (s(v.label)) tks = tks.filter((t) => t.labels.includes(s(v.label) as string));
      if (!tks.length) console.log("  (none)");
      for (const t of tks)
        console.log(`  ${t.key.padEnd(9)} ${t.state.padEnd(11)} ${ago(t.updated).padStart(4)}  [${t.labels.join(",") || "-"}] ${t.title.slice(0, 70)}`);
      return 0;
    }
    case "show": {
      const { v, p } = parse("ticket show", rest, { json: { type: "boolean" } }, 1, 1);
      const tk = T.load(ws, T.resolveKey(ws, p[0] as string));
      if (v.json) console.log(JSON.stringify(tk, null, 2));
      else console.log(showTicket(tk).join("\n"));
      return 0;
    }
    case "comments": {
      const { p } = parse("ticket comments", rest, {}, 1, 1);
      const tk = T.load(ws, T.resolveKey(ws, p[0] as string));
      if (!tk.comments.length) console.log(`  ${tk.key} has no comments`);
      for (const c of tk.comments) console.log(`--- ${c.by}, ${c.t}\n${c.body.trim()}\n`);
      return 0;
    }
    case "create": {
      const { v } = parse("ticket create", rest, { project: { type: "string" }, title: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" }, label: { type: "string", multiple: true }, ...as }, 0, 0);
      const actor = cliActor(ws, s(v.as));
      const project = s(v.project) ?? (T.projects(ws).length === 1 ? (T.projects(ws)[0] as { key: string }).key : undefined);
      if (!project) throw new FactoryError("ticket create: --project is needed; there is more than one", 2);
      if (!s(v.title)) throw new FactoryError("ticket create: --title is needed", 2);
      if (v.body !== undefined && v["body-file"] !== undefined) throw new FactoryError("ticket create: --body or --body-file, not both", 2);
      checkCreate(ws, "Backlog", actor);
      const body = typeof v["body-file"] === "string" ? readFileSync(v["body-file"], "utf8") : (s(v.body) ?? "");
      const tk = T.create(ws, { project, title: s(v.title) as string, body, labels: (v.label as string[] | undefined) ?? [], by: actor.name });
      console.log(`  ${tk.key} filed in ${tk.state}: ${tk.title}`);
      return 0;
    }
    case "move": {
      const { v, p } = parse("ticket move", rest, { asked: { type: "string" }, merged: { type: "string" }, ...as }, 2, 2);
      const actor = cliActor(ws, s(v.as));
      const key = T.resolveKey(ws, p[0] as string);
      const to = T.checkState(p[1] as string);
      const tk = T.load(ws, key);
      if (tk.state === to) {
        console.log(`  ${key} already ${to}`);
        return 0;
      }
      const proof = checkMove(ws, tk, to, actor, { ...(s(v.asked) ? { asked: s(v.asked) } : {}), ...(s(v.merged) !== undefined ? { merged: s(v.merged) } : {}) });
      const r = T.move(ws, key, to, actor.name, proof);
      console.log(`  ${key}: ${r.from} -> ${to}`);
      return 0;
    }
    case "label": {
      const { v, p } = parse("ticket label", rest, { ...as }, 3, 3);
      const actor = cliActor(ws, s(v.as));
      const op = p[1];
      if (op !== "add" && op !== "rm") throw new FactoryError(`ticket label: add or rm, not ${JSON.stringify(op)}`, 2);
      const key = T.resolveKey(ws, p[0] as string);
      const r = T.label(ws, key, op, p[2] as string, actor.name);
      console.log(r.changed ? `  ${key}: ${op} ${p[2]}` : `  ${key} unchanged (${op} ${p[2]})`);
      return 0;
    }
    case "describe":
    case "comment": {
      const { v, p } = parse(`ticket ${sub}`, rest, { file: { type: "string" }, ...as }, 1, 2);
      const actor = cliActor(ws, s(v.as));
      const key = T.resolveKey(ws, p[0] as string);
      const text = textArg(`ticket ${sub}`, p[1], v.file);
      if (sub === "describe") {
        T.describe(ws, key, text, actor.name);
        console.log(`  ${key}: description appended to`);
      } else {
        const c = T.comment(ws, key, text, actor.name);
        console.log(`  ${key}: comment ${c.id} added`);
      }
      return 0;
    }
    case "relate": {
      const { v, p } = parse("ticket relate", rest, { remove: { type: "boolean" }, ...as }, 3, 3);
      const actor = cliActor(ws, s(v.as));
      const key = T.resolveKey(ws, p[0] as string);
      const to = T.resolveKey(ws, p[2] as string);
      if (!T.exists(ws, to)) throw new FactoryError(`no ticket ${to}`);
      T.relate(ws, key, p[1] as T.RelationKind, to, actor.name, v.remove ? "unrelate" : "relate");
      console.log(`  ${key}: ${v.remove ? "no longer " : ""}${p[1]} ${to}`);
      return 0;
    }
    case "link": {
      const { v, p } = parse("ticket link", rest, { ...as }, 2, 3);
      const actor = cliActor(ws, s(v.as));
      const key = T.resolveKey(ws, p[0] as string);
      T.link(ws, key, p[1] as string, p[2] ?? null, actor.name);
      console.log(`  ${key}: linked ${p[1]}`);
      return 0;
    }
    case "title": {
      const { v, p } = parse("ticket title", rest, { ...as }, 2, 2);
      const actor = cliActor(ws, s(v.as));
      const key = T.resolveKey(ws, p[0] as string);
      const tk = T.retitle(ws, key, p[1] as string, actor.name);
      console.log(`  ${key}: titled ${JSON.stringify(tk.title)}`);
      return 0;
    }
    default:
      throw new FactoryError(`ticket: ${sub ? `no subcommand ${JSON.stringify(sub)}` : "which subcommand?"}; see factory --help`, 2);
  }
}

export function pageRef(ws: Workspace, ref: string): { project: string; path: string } {
  const m = /^([A-Z][A-Z0-9]{1,9})\/(.+)$/.exec(ref);
  if (m) {
    T.projectOf(ws, m[1] as string);
    return { project: m[1] as string, path: W.checkPath(m[2] as string) };
  }
  const ps = T.projects(ws);
  if (ps.length !== 1) throw new FactoryError(`${ref}: name the project, as in ${ps[0]?.key ?? "RPE"}/${ref}`);
  return { project: (ps[0] as { key: string }).key, path: W.checkPath(ref) };
}

export function cmdWiki(ws: Workspace, argv: string[]): number {
  T.requireEnabled(ws);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list": {
      const { v } = parse("wiki list", rest, { project: { type: "string" } }, 0, 0);
      const ps = s(v.project) ? [T.projectOf(ws, s(v.project) as string)] : T.projects(ws);
      let n = 0;
      for (const p of ps)
        for (const e of W.list(ws, p.key)) {
          n++;
          console.log(`  ${`${e.project}/${e.path}`.padEnd(48)} ${e.title}`);
        }
      if (!n) console.log("  (no pages)");
      return 0;
    }
    case "show": {
      const { v, p } = parse("wiki show", rest, { json: { type: "boolean" } }, 1, 1);
      const r = pageRef(ws, p[0] as string);
      const pg = W.read(ws, r.project, r.path);
      if (v.json) console.log(JSON.stringify(pg, null, 2));
      else console.log(`# ${pg.title}\n(${pg.project}/${pg.path}, sha ${pg.sha}, updated ${pg.updated})\n\n${pg.body.trim()}`);
      return 0;
    }
    case "edit": {
      const { v, p } = parse("wiki edit", rest, { file: { type: "string" }, title: { type: "string" }, base: { type: "string" }, ...as }, 1, 1);
      const actor = cliActor(ws, s(v.as));
      const r = pageRef(ws, p[0] as string);
      if (!s(v.file)) throw new FactoryError("wiki edit: --file is needed", 2);
      const exists = W.pageExists(ws, r.project, r.path);
      if (exists && !s(v.base)) throw new FactoryError(`wiki edit: ${r.project}/${r.path} exists; pass --base <sha> from \`factory wiki show\``, 2);
      const raw = readFileSync(s(v.file) as string, "utf8");
      const parsed = W.parse(raw);
      const title = s(v.title) ?? parsed.title ?? (exists ? W.read(ws, r.project, r.path).title : undefined);
      if (!title) throw new FactoryError("wiki edit: a new page needs --title", 2);
      const pg = W.save(ws, { project: r.project, path: r.path, title, body: parsed.body, by: actor.name, base: exists ? (s(v.base) as string) : null });
      console.log(`  ${pg.project}/${pg.path} saved, sha ${pg.sha}`);
      return 0;
    }
    case "history": {
      const { p } = parse("wiki history", rest, {}, 1, 1);
      const r = pageRef(ws, p[0] as string);
      W.read(ws, r.project, r.path);
      for (const h of W.history(ws, r.project, r.path)) console.log(`  ${h.t}  ${h.sha}  ${h.by}`);
      return 0;
    }
    default:
      throw new FactoryError(`wiki: ${sub ? `no subcommand ${JSON.stringify(sub)}` : "which subcommand?"}; see factory --help`, 2);
  }
}
