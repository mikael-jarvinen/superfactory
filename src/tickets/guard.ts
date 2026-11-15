// Who may move a ticket where. Backlog is the human's queue and leaving In Review onward is the
// human's merge, so an agent can do neither on its own word. store.ts calls these inside create()
// and move(), so the CLI, the board and any other caller of the store meet the same checks.
//
// The board writes as the human and is never refused. Nothing authenticates the board: it is
// tailnet-only, and these guards stop an agent's mistake, not someone who means harm.
import { existsSync, readFileSync } from "node:fs";
import { ghBin } from "../gate/github.js";
import { isHuman } from "../messages.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, run } from "../util.js";
import type { Ticket, TicketState } from "./store.js";

// `importer` is a migration script's actor, which may give a ticket its old number and state. The
// CLI never makes one.
export type Actor = { human: true; name: string } | { human: false; name: string; importer?: boolean };

export const MIN_QUOTE = 20;
// Moving back from In Review claims nothing about a merge: it says the ticket is not with the human yet.
export const BACK_TO_WORK: ReadonlySet<TicketState> = new Set(["Todo", "In Progress", "In Design"]);

const squashWs = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

// The human's own rows in the message log, and in its rolled-over half. Only the board's
// /api/messages writes a human row (its composer, and Telegram through tg-forward); `factory say`
// cannot.
export function humanWords(ws: Workspace): string[] {
  const out: string[] = [];
  for (const f of [`${ws.messages}.1`, ws.messages]) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const row = JSON.parse(l) as { kind?: string; text?: unknown };
        if (isHuman(ws, row.kind) && typeof row.text === "string") out.push(squashWs(row.text));
      } catch {
        // a torn line is not a message
      }
    }
  }
  return out;
}

export function checkAsked(ws: Workspace, quote: string | undefined, what: string): string {
  const name = ws.config.human.name;
  if (!quote) throw new FactoryError(`REFUSED: ${what}, which is ${name}'s. If ${name} asked for it, quote them: --asked "<their words>"`);
  const q = squashWs(quote);
  if (q.length < MIN_QUOTE) throw new FactoryError(`REFUSED: quote at least ${MIN_QUOTE} characters of ${name}'s message.`);
  if (!humanWords(ws).some((m) => m.includes(q))) throw new FactoryError(`REFUSED: ${JSON.stringify(q)} is not in any of ${name}'s messages.`);
  return q;
}

// Asks GitHub whether the PR merged. Anything but a clear MERGED, including GitHub not answering,
// is a refusal.
export function checkMerged(ws: Workspace, tk: Ticket, merged: string): void {
  const m = /^#([1-9]\d*)$/.exec(merged);
  if (!m) throw new FactoryError(`--merged must be a PR number like '#95', not ${JSON.stringify(merged)}.`);
  const p = ws.config.tracker.projects.find((x) => x.key === tk.project);
  if (!p?.repo) throw new FactoryError(`REFUSED: ${tk.project} names no repo in [[tracker.projects]], so its merges cannot be checked.`);
  const remote = ws.config.repos[p.repo]?.remote ?? p.repo;
  const r = run(ghBin(), ["pr", "view", m[1] as string, "--repo", remote, "--json", "state,mergedAt"], { timeout: 30_000 });
  if (r.status !== 0) throw new FactoryError(`REFUSED: could not ask GitHub about ${remote}#${m[1]}: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.status}`}`);
  let state: unknown;
  try {
    state = (JSON.parse(r.stdout) as { state?: unknown }).state;
  } catch {
    throw new FactoryError(`REFUSED: GitHub's answer about ${remote}#${m[1]} was not JSON`);
  }
  if (state !== "MERGED") throw new FactoryError(`REFUSED: ${remote}#${m[1]} is ${String(state)}, not merged.`);
}

export interface MoveProof {
  asked?: string;
  merged?: string;
}

// Returns what to record with the move: the quote and the PR it was let through on.
export function checkMove(ws: Workspace, tk: Ticket, to: TicketState, actor: Actor, proof: MoveProof = {}): MoveProof {
  if (actor.human || tk.state === to) return {};
  const out: MoveProof = {};
  if (tk.state === "Backlog") out.asked = checkAsked(ws, proof.asked, `${tk.key} is in Backlog`);
  if (tk.state === "In Review" && !BACK_TO_WORK.has(to)) {
    const name = ws.config.human.name;
    if (proof.merged === undefined)
      throw new FactoryError(`REFUSED: ${tk.key} is In Review and ${to} is onward, which is ${name}'s merge.\n` +
        `  If ${name} HAS merged it, pass the PR, which is checked with GitHub: --merged '#<pr>'\n` +
        `  If it should never have been In Review, move it back to In Progress instead.`);
    checkMerged(ws, tk, proof.merged);
    out.merged = proof.merged;
  }
  return out;
}

// An agent files into Backlog only, the human's queue; the human moves it on. An importer keeps
// the state the ticket had.
export function checkCreate(ws: Workspace, state: TicketState, actor: Actor): void {
  if (!actor.human && !actor.importer && state !== "Backlog")
    throw new FactoryError(`REFUSED: an agent files into Backlog only; ${ws.config.human.name} moves a ticket on from there.`);
}

// The CLI runs as an agent. It may not claim to be the human: that is the board's alone.
export function cliActor(ws: Workspace, as: string | undefined): Actor {
  const human = ws.config.human.name;
  const lead = ws.config.agents.find((a) => a.role === "lead")?.name ?? "lead";
  const name = as ?? lead;
  if (name.toLowerCase() === human.toLowerCase()) throw new FactoryError(`--as ${name}: the CLI writes as an agent; ${human} writes from the board.`);
  if (!ws.config.agents.some((a) => a.name === name)) throw new FactoryError(`--as ${name}: no such agent; agents: ${ws.config.agents.map((a) => a.name).join(", ")}`);
  return { human: false, name };
}
