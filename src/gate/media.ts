// `factory pr-media <repo> <n> (--dir <media dir> | --no-visual-change) [--dry-run]`
//
// Puts a demo's screenshots and video into the PR body. Files are uploaded as GitHub attachments
// through the endpoint the web UI uses for drag and drop, with the gh token as a bearer credential,
// then a section between the two markers below is spliced into the body. Nothing is committed to
// the repo.
//
// Provenance: the media dir must hold pr-media.json, written by `factory demo` on a passing run,
// and its sha must be the PR head, or the PR's base for a "before" recording (`factory demo
// --before`): the merge-base with the base branch, or that branch's head. Media from any other
// commit is refused. A before set sits in its own block inside the Demo section, so either upload
// keeps the other's media; with no before set the section is what it always was.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Repo } from "../config.js";
import { FactoryError } from "../util.js";
import { api, gh, headOf, prView, type PrView } from "./github.js";

export const MEDIA_BEGIN = "<!-- pr-media:begin -->";
export const MEDIA_END = "<!-- pr-media:end -->";
export const BEFORE_BEGIN = "<!-- pr-media:before:begin -->";
export const BEFORE_END = "<!-- pr-media:before:end -->";
export const STAMP = "pr-media.json";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webm": "video/webm", ".mp4": "video/mp4", ".mov": "video/quicktime",
};

const typeOf = (f: string) => TYPES[extname(f).toLowerCase()];

export const caption = (file: string) => basename(file, extname(file)).replace(/^\d+[-_]/, "").replace(/[-_]+/g, " ");

export function splice(body: string, section: string): string {
  const s = body.indexOf(MEDIA_BEGIN);
  const e = body.indexOf(MEDIA_END);
  if (s === -1 || e === -1) return `${body.trimEnd()}\n\n${section}\n`;
  return `${body.slice(0, s)}${section}${body.slice(e + MEDIA_END.length)}`;
}

// The Demo section's two halves in a body: the before block, markers and all, and the rest.
export function demoParts(body: string): { before?: string; after: string } {
  const s = body.indexOf(MEDIA_BEGIN);
  const e = body.indexOf(MEDIA_END);
  if (s === -1 || e === -1) return { after: "" };
  let inner = body.slice(s + MEDIA_BEGIN.length, e);
  let before: string | undefined;
  const bs = inner.indexOf(BEFORE_BEGIN);
  const be = inner.indexOf(BEFORE_END);
  if (bs !== -1 && be !== -1) {
    before = inner.slice(bs, be + BEFORE_END.length);
    inner = inner.slice(0, bs) + inner.slice(be + BEFORE_END.length);
  }
  const after = inner.trim().replace(/^## Demo\s*/, "").replace(/^### After\s*/, "").trim();
  return { before, after };
}

// The Demo section. Without a before block it is the heading and the after lines, as it always was.
export function demoSection(after: string[], before?: string): string {
  if (before === undefined) return [MEDIA_BEGIN, "## Demo", ...after, MEDIA_END].join("\n");
  const rest = after.join("\n").trim();
  return [MEDIA_BEGIN, "## Demo", before, ...(rest ? ["### After", rest] : []), MEDIA_END].join("\n");
}

const beforeBlock = (lines: string[]) => [BEFORE_BEGIN, "### Before", ...lines, BEFORE_END].join("\n");

async function upload(file: string, repoId: string, token: string): Promise<string> {
  const type = typeOf(file) as string;
  const q = new URLSearchParams({ name: basename(file), content_type: type, repository_id: repoId });
  const res = await fetch(`https://uploads.github.com/user-attachments/assets?${q}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": type },
    body: readFileSync(file),
  });
  if (res.status !== 201) throw new FactoryError(`pr-media: ${basename(file)}: upload failed HTTP ${res.status} ${await res.text()}`);
  const { url } = (await res.json()) as { url?: string };
  if (!url) throw new FactoryError(`pr-media: ${basename(file)}: upload returned no url`);
  return url;
}

export interface MediaArgs {
  dir?: string;
  noVisualChange: boolean;
  dryRun: boolean;
}

export async function media(repo: Repo, n: number, a: MediaArgs, out: (line: string) => void = console.log): Promise<void> {
  const no = (msg: string) => new FactoryError(`pr-media: ${msg}`);
  const head = headOf(repo, n);
  if (!head) throw no(`cannot read the head of ${repo.remote}#${n}`);
  let lines: string[];
  let isBefore = false;
  let pr: PrView | undefined;
  if (a.noVisualChange) {
    lines = ["No visual change."];
  } else {
    const dir = a.dir;
    if (!dir || !existsSync(dir)) throw no("--dir <media dir> is required and must exist, or pass --no-visual-change");
    const stampPath = join(dir, STAMP);
    if (!existsSync(stampPath)) throw no(`${dir} has no ${STAMP}: the demo did not pass, or was not run with \`factory demo\``);
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { sha?: string };
    if (stamp.sha !== head) {
      // Not the head: the before set, if the stamp is the PR's base.
      pr = prView(repo, n);
      if (!pr) throw no(`cannot read ${repo.remote}#${n}`);
      const cmp = api<{ merge_base_commit?: { sha?: string }; base_commit?: { sha?: string } }>(
        `repos/${repo.remote}/compare/${pr.baseRefName}...${head}`);
      const bases = [cmp?.merge_base_commit?.sha, cmp?.base_commit?.sha].filter((x): x is string => !!x);
      if (!bases.length) throw no(`cannot read the base of ${repo.remote}#${n}`);
      if (!stamp.sha || !bases.includes(stamp.sha))
        throw no(`the demo captured ${String(stamp.sha).slice(0, 7)} but the PR head is ${head.slice(0, 7)} and its base ` +
          `(${pr.baseRefName}) is ${[...new Set(bases.map((b) => b.slice(0, 7)))].join(" or ")}. ` +
          "Re-run the demo on the current commit, or `factory demo --before` on the base.");
      isBefore = true;
    }
    const files = readdirSync(dir).filter((f) => !f.startsWith(".") && typeOf(f)).sort();
    if (!files.length) throw no(`${dir} holds no images or videos`);
    const isVideo = (f: string) => (typeOf(f) as string).startsWith("video/");
    const shots = files.filter((f) => !isVideo(f));
    const ordered = [...shots.filter((f) => /^end/i.test(f)), ...shots.filter((f) => !/^end/i.test(f)), ...files.filter(isVideo)];
    let repoId = "0";
    let token = "";
    if (!a.dryRun) {
      const id = api<{ id?: number }>(`repos/${repo.remote}`)?.id;
      if (id === undefined) throw no(`cannot read the id of ${repo.remote}`);
      repoId = String(id);
      token = gh("auth", "token").stdout.trim();
      if (!token) throw no("gh auth token printed nothing; is gh logged in?");
    }
    // Nothing about how the demo was captured: the body is for colleagues, who don't know the factory.
    lines = [];
    for (const f of ordered) {
      const url = a.dryRun ? `<upload:${f}>` : await upload(join(dir, f), repoId, token);
      lines.push(isVideo(f) ? `**${caption(f)}**\n\n${url}\n` : `**${caption(f)}**\n\n![${caption(f)}](${url})\n`);
    }
  }
  // An after upload's dry run reads no body, as it never did; a before set has read it already.
  if (!pr && !a.dryRun) {
    pr = prView(repo, n);
    if (!pr) throw no(`cannot read the body of ${repo.remote}#${n}`);
  }
  const kept = demoParts(pr?.body ?? "");
  const section = isBefore ? demoSection(kept.after ? [kept.after] : [], beforeBlock(lines)) : demoSection(lines, kept.before);
  if (a.dryRun) {
    out(section);
    return;
  }
  const file = join(tmpdir(), `pr-body-${process.pid}.md`);
  writeFileSync(file, splice(pr?.body ?? "", section));
  try {
    const r = gh("pr", "edit", String(n), "--repo", repo.remote, "--body-file", file);
    if (r.status !== 0) throw no(`gh pr edit failed: ${r.stderr.trim()}`);
  } finally {
    rmSync(file, { force: true });
  }
  out(`PR ${repo.remote}#${n} body updated with ${lines.length} ${isBefore ? "before " : ""}media lines.`);
}
