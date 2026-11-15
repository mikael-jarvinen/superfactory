// Who may move a ticket where. Backlog is the human's queue and leaving In Review onward is the
// human's merge, so an agent can do neither on its own word. The checks sit here, under every
// writer (the CLI and the board's API alike), so no caller can forget them.
//
// The human writes from the board and is never refused. Nothing authenticates the board: it is
// tailnet-only, and these guards stop an agent's mistake, not someone who means harm.
import { existsSync, readFileSync } from "node:fs";
import { isHuman } from "../messages.js";
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import type { Ticket, TicketState } from "./store.js";

export type Actor = { human: true; name: string } | { human: false; name: string };

export const MIN_QUOTE = 12;
// Moving back from In Review claims nothing about a merge: it says the ticket is not with the human yet.
export const BACK_TO_WORK: ReadonlySet<TicketState> = new Set(["Todo", "In Progress", "In Design"]);

const squashWs = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

// The human's own messages: the message page's rows, then each asked_from file's "### <name> ..."
// sections (the lead's conversation log, where Telegram messages land).
export function humanWords(ws: Workspace): string[] {
  const out: string[] = [];
  if (existsSync(ws.messages))
    for (const l of readFileSync(ws.messages, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const row = JSON.parse(l) as { kind?: string; text?: unknown };
        if (isHuman(ws, row.kind) && typeof row.text === "string") out.push(squashWs(row.text));
      } catch {
        // a torn line is not a message
      }
    }
  const name = ws.config.human.name;
  for (const f of ws.config.tracker.askedFrom) {
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, "utf8").split(/^### /m))
      if (m.startsWith(`${name} `) || m.startsWith(`${name}\n`)) out.push(squashWs(m.split("\n").slice(1).join("\n")));
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
        `  If ${name} HAS merged it, check the change is on the base branch and pass the PR: --merged '#<pr>'\n` +
        `  If it should never have been In Review, move it back to In Progress instead.`);
    // The documented form only, so the override cannot be satisfied by noise.
    if (!/^#\d+$/.test(proof.merged)) throw new FactoryError(`--merged must be a PR number like '#95', not ${JSON.stringify(proof.merged)}. It exists so the caller has looked.`);
    out.merged = proof.merged;
  }
  return out;
}

// An agent files into Backlog only, the human's queue; the human moves it on.
export function checkCreate(ws: Workspace, state: TicketState, actor: Actor): void {
  if (!actor.human && state !== "Backlog")
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
