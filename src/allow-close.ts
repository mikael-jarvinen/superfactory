// The product-repo PRs the human has named for the lead to close. `factory allow-close` appends one
// line per naming to state/allow-close.jsonl, with the human's own words; the guard reads it before
// it lets `gh pr close` through on a product repo. Mikael, 2026-11-12: "I allow you to close the PR".
// Not a .json file: state/*.json are ticket records.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";
import { now, pyDumps } from "./util.js";

export interface AllowClose {
  repo: string;
  number: number;
  words: string;
  at: string;
}

export const allowClosePath = (stateDir: string) => join(stateDir, "allow-close.jsonl");

export function recordAllowClose(ws: Workspace, repo: string, number: number, words: string): AllowClose {
  const rec: AllowClose = { repo, number, words, at: now() };
  mkdirSync(ws.stateDir, { recursive: true });
  appendFileSync(allowClosePath(ws.stateDir), pyDumps(rec, { sortKeys: true }) + "\n");
  return rec;
}

// Whether owner/repo#number is on the list. A missing or unreadable file, or a line that does not
// parse, names nothing.
export function closable(file: string, repo: string, number: number): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => {
    try {
      const r = JSON.parse(line) as Partial<AllowClose>;
      return typeof r.repo === "string" && r.repo.toLowerCase() === repo.toLowerCase() && r.number === number && !!r.words;
    } catch {
      return false;
    }
  });
}
