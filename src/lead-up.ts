// How `factory up` brings the lead back. A session given no first turn never stops, so the Stop hook
// that tells the lead to arm the message page inbox never fires, and the human's messages wait
// until someone types into the session. So a lead that was here before is resumed with a first
// turn of its own: `claude --bg --resume <session id> <prompt>` continues that conversation under
// the same id, and the prompt arms the inbox. Respawn, which takes no prompt, is left for a lead
// on another host (whose daemon renders the launch itself), a listing with no session id, or a
// resume that fails. claude may bring a resumed session back as a copy under a new id; the
// conversation carries over either way, and the old entry is removed.
import type { Agent } from "./config.js";
import { findSession, type Session, waitForName } from "./fleet.js";
import { armText } from "./hooks/status.js";
import { GIT_HTTPS_ENV, launch, launchArgs, leadPrompt, roleAppendix, roleOf } from "./launch.js";
import type { Transport } from "./transport.js";
import { FactoryError } from "./util.js";
import type { Workspace } from "./workspace.js";

export const resumePrompt = (ws: Workspace) => `You were restarted by \`factory up\`. ${armText(ws)}`;

// A resumed session gets its messages back, not the system prompt it started with, so the appendix
// goes on the command line again. A fresh launch's argv with `--resume <id>` before the prompt, so
// the two cannot pass the appendix differently.
export function resumeArgs(ws: Workspace, agent: Agent, sessionId: string, prompt: string, appendixPath: string | null): string[] {
  const args = launchArgs(ws, agent, prompt, appendixPath, undefined);
  return [...args.slice(0, -1), "--resume", sessionId, prompt];
}

export function bringUpLead(ws: Workspace, ld: Agent, t: Transport, fresh: boolean, out: (line: string) => void = console.log, waitS = 60): void {
  const s = findSession(t, ld.name);
  if (t.alive(s)) {
    out(`${ld.name} already running (${s.id})`);
    return;
  }
  // Read before anything starts: a missing brief refuses here, not after a resume and a respawn.
  const appendix = roleAppendix(ws, ld);
  const old = fresh ? null : findSession(t, ld.name, true);
  if (old) {
    const sid = old.id as string;
    if (!ld.host && typeof old.sessionId === "string" && resume(ws, ld, t, old, old.sessionId, waitS, out, appendix)) return;
    const r = t.respawn(ld.name, sid);
    if (r.ok && waitForName(t, ld.name, waitS)) {
      out(`${ld.name} respawned from ${sid}: ${r.said}`);
      return;
    }
    out(`respawn of ${sid} did not come back (${r.why}); starting fresh`);
  }
  const cwd = roleOf(ws, ld).cwd as string;
  const started = launch(ws, ld, cwd, leadPrompt(ws), appendix, undefined, t);
  out(`${ld.name} started (${started.id}) in ${cwd}${ld.remoteControl ? " with Remote Control" : ""}`);
}

function resume(ws: Workspace, ld: Agent, t: Transport, old: Session, sessionId: string, waitS: number, out: (line: string) => void, appendix: string | null): boolean {
  const prompt = resumePrompt(ws);
  const cwd = old.cwd ?? (roleOf(ws, ld).cwd as string);
  try {
    t.start({ agent: ld, cwd, prompt, appendix, runDir: ws.runDir, phase: undefined, args: (p) => resumeArgs(ws, ld, sessionId, prompt, p), env: { ...process.env, ...GIT_HTTPS_ENV } });
  } catch (e) {
    out(`resuming ${sessionId} failed (${(e as Error).message}); respawning instead`);
    return false;
  }
  const back = waitForName(t, ld.name, waitS);
  if (!back) {
    out(`resumed ${sessionId} did not come back; respawning instead`);
    return false;
  }
  // A resume that comes back under a new id leaves the old one listed, stopped; take it off the list.
  // The lead is up by now, so a stop that dies (a scope systemd-run cannot make) only leaves the
  // old entry listed; it is no reason to fail the bring-up. Any other error is a bug, and throws.
  if (old.id && back.id !== old.id)
    try {
      t.stop(ld.name, old.id, true);
    } catch (e) {
      if (!(e instanceof FactoryError)) throw e;
      out(`the old ${old.id} stays listed: ${e.message}`);
    }
  out(`${ld.name} resumed from ${sessionId} as ${back.id}, told to arm the message page inbox`);
  return true;
}
