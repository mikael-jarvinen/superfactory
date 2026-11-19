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
import { GIT_HTTPS_ENV, launch, launchArgs, leadPrompt, refreshSettings, roleAppendix, roleOf } from "./launch.js";
import { cameUp, freshCommand, lastStopped, moveRecord, replaceStopped, resumable } from "./stopped.js";
import { isAgentSession, pick, type Transport } from "./transport.js";
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
    cameUp(ws, ld.name, t, s);
    out(`${ld.name} already running (${s.id})`);
    return;
  }
  // Read before anything starts: a missing brief refuses here, not after a resume and a respawn.
  const appendix = roleAppendix(ws, ld);
  // The session stopped last, by its id (stopped.ts); else the newest, as findSession has it.
  let old: Session | null = null;
  // the marks a launch that ran leaves standing, once the row chosen for it is up (stopped.ts)
  let marks: string[] | undefined;
  if (!fresh) {
    const st = lastStopped(ws, ld.name);
    if (!st) old = findSession(t, ld.name, true);
    else {
      const which = resumable(ws, ld.name, t.sessions(true).filter(isAgentSession(ld.name)), (rows) => pick(t, rows));
      if ("gone" in which)
        throw new FactoryError(`${ld.name}'s last stopped session ${which.gone} is no longer listed, and an older one is another conversation. ` +
          `\`${freshCommand(ld)}\` starts a new one.`);
      old = which.s;
      marks = which.failed;
    }
  }
  if (old) {
    const sid = old.id as string;
    if (!ld.host && typeof old.sessionId === "string" && resume(ws, ld, t, old, old.sessionId, waitS, out, appendix, marks)) return;
    // A respawn reruns the old command line, which still names the settings file: a render that
    // fails (a role's template gone) leaves the last render there, so the lead comes back on it
    // rather than staying down, and the failure is said loudly (CodeRabbit on #127).
    try {
      refreshSettings(ws, ld);
    } catch (e) {
      out(`WARNING: ${ld.name}'s settings could not be rendered (${(e as Error).message}); respawning on the last rendered settings. Fix the template, then \`factory stop ${ld.name}\` and \`factory up\`: up leaves a running lead as it is.`);
    }
    const r = t.respawn(ld.name, sid);
    const up = r.ok ? waitForName(t, ld.name, waitS) : null;
    if (up) {
      // the id that came back, which can differ from the one respawned (Marie on #130 at 2e89a7a4)
      if (marks || (up.id && up.id !== sid)) replaceStopped(ws, ld.name, t, up.id ?? sid, sid);
      out(`${ld.name} respawned from ${sid}: ${r.said}`);
      return;
    }
    out(`respawn of ${sid} did not come back (${r.why}); starting fresh`);
  }
  const cwd = roleOf(ws, ld).cwd as string;
  const started = launch(ws, ld, cwd, leadPrompt(ws), appendix, undefined, t);
  out(`${ld.name} started (${started.id}) in ${cwd}${ld.remoteControl ? " with Remote Control" : ""}`);
}

function resume(ws: Workspace, ld: Agent, t: Transport, old: Session, sessionId: string, waitS: number, out: (line: string) => void, appendix: string | null,
  marks?: string[]): boolean {
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
  // Up under a new id, the one a later stop records; until now the record stays, so a resume that
  // fails leaves the next try aimed at the same conversation (CodeRabbit on #130). The row it
  // replaced is removed below.
  // Launches still marked keep their marks, now on the new id (CodeRabbit on #130 at 7a20b268).
  if (marks && back.id) replaceStopped(ws, ld.name, t, back.id);
  else if (back.id) moveRecord(ws, ld.name, back.id, lastStopped(ws, ld.name)?.failed ?? []);
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
