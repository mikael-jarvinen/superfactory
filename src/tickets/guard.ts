// Who may move a ticket where. Backlog is the human's queue and Done is the human's merge, so an
// agent can do neither on its own word. store.ts calls these inside create() and move(), so the
// CLI, the board and any other caller of the store meet the same checks.
//
// The board writes as the human and is never refused. Nothing authenticates the board: it is
// tailnet-only, and these guards stop an agent's mistake, not someone who means harm.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ghBin } from "../gate/github.js";
import { HUMAN_KIND } from "../messages.js";
import type { Workspace } from "../workspace.js";
import { FactoryError } from "../util.js";
import type { Ticket, TicketState } from "./store.js";

// `importer` is a migration script's actor, which may give a ticket its old number and state. The
// CLI never makes one.
export type Actor = { human: true; name: string } | { human: false; name: string; importer?: boolean };

export const MIN_QUOTE = 20;
// Done says the human merged it, so an agent moving a ticket there names the merged PR, from any
// state. Every other move after Backlog is free: back to work claims nothing about a merge, and
// Cancelled says the work is not wanted.
export const NEEDS_MERGE: ReadonlySet<TicketState> = new Set(["Done"]);
const GH_TIMEOUT_MS = 30_000;

const squashWs = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

// The human's own rows in the message log, and in its rolled-over half: rows of kind "human"
// only. A legacy_message_kind row is shown as the human's on the page but is never quotable,
// since that kind may be one an agent can post. Only the board's /api/messages writes a human
// row (its composer, and Telegram through tg-forward); `factory say` cannot.
export function humanWords(ws: Workspace): string[] {
  const out: string[] = [];
  for (const f of [`${ws.messages}.1`, ws.messages]) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const row = JSON.parse(l) as { kind?: string; text?: unknown };
        if (row.kind === HUMAN_KIND && typeof row.text === "string") out.push(squashWs(row.text));
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

function gh(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    execFile(ghBin(), args, { timeout: GH_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout) });
      const why = String(stderr || stdout).trim().split("\n")[0] || ((err as { killed?: boolean }).killed ? `no answer in ${GH_TIMEOUT_MS / 1000}s` : err.message);
      resolve({ ok: false, why });
    });
  });
}

// The key as a whole word, any case: RPE-34 is in "drake/rpe-34-plan", not in "RPE-340".
export const mentions = (text: string, key: string) =>
  new RegExp(`(?<![A-Za-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(text);

// Asks GitHub whether the PR merged and is this ticket's: its title, body or branch must name the
// key. Anything else, including GitHub not answering, is a refusal. It is asked before the store
// takes the ticket's lock, and does not depend on the ticket's state, so it holds under the lock.
export async function checkMerged(ws: Workspace, tk: Ticket, merged: string): Promise<void> {
  const m = /^#([1-9]\d*)$/.exec(merged);
  if (!m) throw new FactoryError(`--merged must be a PR number like '#95', not ${JSON.stringify(merged)}.`);
  const p = ws.config.tracker.projects.find((x) => x.key === tk.project);
  if (!p?.repo) throw new FactoryError(`REFUSED: ${tk.project} names no repo in [[tracker.projects]], so its merges cannot be checked.`);
  const remote = ws.config.repos[p.repo]?.remote ?? p.repo;
  const pr = `${remote}#${m[1]}`;
  const r = await gh(["pr", "view", m[1] as string, "--repo", remote, "--json", "state,mergedAt,title,body,headRefName"]);
  if (!r.ok) throw new FactoryError(`REFUSED: could not ask GitHub about ${pr}: ${r.why}`);
  let v: { state?: unknown; title?: unknown; body?: unknown; headRefName?: unknown };
  try {
    v = JSON.parse(r.stdout) as typeof v;
  } catch {
    throw new FactoryError(`REFUSED: GitHub's answer about ${pr} was not JSON`);
  }
  if (v.state !== "MERGED") throw new FactoryError(`REFUSED: ${pr} is ${String(v.state)}, not merged.`);
  const where = { title: v.title, body: v.body, branch: v.headRefName };
  if (!Object.values(where).some((x) => typeof x === "string" && mentions(x, tk.key)))
    throw new FactoryError(`REFUSED: ${pr} is merged but is not ${tk.key}'s: its title, body and branch (${JSON.stringify(String(v.headRefName ?? ""))}) never name ${tk.key}.`);
}

export interface MoveProof {
  asked?: string;
  merged?: string;
}

// What a move needs that is checked here and now, against the ticket as it is: the quote out of
// Backlog, and that a merge was named for Done. The store runs it again under the lock. Returns
// the quote to record, and whether GitHub must be asked about proof.merged.
export function checkMoveNow(ws: Workspace, tk: Ticket, to: TicketState, actor: Actor, proof: MoveProof = {}): { asked?: string; askGitHub: boolean } {
  if (actor.human || tk.state === to) return { askGitHub: false };
  const out: { asked?: string; askGitHub: boolean } = { askGitHub: false };
  if (tk.state === "Backlog") out.asked = checkAsked(ws, proof.asked, `${tk.key} is in Backlog`);
  if (NEEDS_MERGE.has(to)) {
    const name = ws.config.human.name;
    if (proof.merged === undefined)
      throw new FactoryError(`REFUSED: ${to} is ${name}'s merge, from any state.\n` +
        `  If ${name} HAS merged ${tk.key}'s PR, pass it, which is checked with GitHub: --merged '#<pr>'\n` +
        `  If the work is not wanted, move it to Cancelled instead.`);
    out.askGitHub = true;
  }
  return out;
}

// The whole check, GitHub included. Returns what to record with the move.
export async function checkMove(ws: Workspace, tk: Ticket, to: TicketState, actor: Actor, proof: MoveProof = {}): Promise<MoveProof> {
  const now = checkMoveNow(ws, tk, to, actor, proof);
  if (now.askGitHub) await checkMerged(ws, tk, proof.merged as string);
  return { ...(now.asked ? { asked: now.asked } : {}), ...(now.askGitHub ? { merged: proof.merged } : {}) };
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
