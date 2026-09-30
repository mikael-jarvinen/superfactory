import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Agent, RoleName } from "./config.js";
import type { Workspace } from "./workspace.js";
import { die, pyRepr, pyStr, run, sleep } from "./util.js";

export interface Session {
  id?: string;
  name?: string;
  kind?: string;
  state?: string;
  status?: string;
  cwd?: string;
  updatedAt?: string;
  startedAt?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// $CLAUDE_BIN, else claude on PATH, else ~/.local/bin/claude.
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  for (const d of (env.PATH ?? "").split(delimiter)) if (d && executable(join(d, "claude"))) return join(d, "claude");
  return join(homedir(), ".local", "bin", "claude");
}

export const agents = (ws: Workspace) => ws.config.agents;

export const byRole = (ws: Workspace, role: RoleName) => ws.config.agents.filter((a) => a.role === role);

export function lead(ws: Workspace): Agent {
  return byRole(ws, "lead")[0] as Agent;
}

export function agentOrDie(ws: Workspace, name: string): Agent {
  const a = ws.config.agents.find((x) => x.name === name);
  if (!a) die(`no fleet entry for ${pyRepr(name)}; known: ${ws.config.agents.map((x) => x.name).join(", ")}`);
  return a;
}

export function sessions(includeDone = false): Session[] {
  const r = run(claudeBin(), ["agents", "--json", ...(includeDone ? ["--all"] : [])]);
  if (r.status !== 0) die(`\`claude agents --json\` failed: ${r.stderr.trim()}`);
  try {
    return JSON.parse(r.stdout || "[]") as Session[];
  } catch {
    return die("`claude agents --json` returned something that is not JSON");
  }
}

// `claude agents --json` is a registry, not a probe: after the daemon retires an idle worker and
// exits, the listing keeps the session at its last state. The roster names the supervisor pid; a
// dead pid or a missing control socket means no background session is alive, whatever the listing
// says. These are undocumented Claude Code internals, so they stay behind this one function.
// Probed on every call, never cached.
export function daemonAlive(): boolean {
  try {
    const roster = JSON.parse(readFileSync(join(homedir(), ".claude", "daemon", "roster.json"), "utf8")) as { supervisorPid?: unknown };
    const pid = Number.parseInt(String(roster.supervisorPid), 10);
    if (!Number.isInteger(pid)) return false;
    process.kill(pid, 0);
    const base = join("/tmp", `cc-daemon-${process.getuid?.() ?? ""}`);
    return readdirSync(base).some((d) => !d.startsWith(".") && existsSync(join(base, d, "control.sock")));
  } catch {
    return false;
  }
}

// A background session that has not stopped or failed, behind a daemon that is running. "done"
// means it finished a turn and is idle; it still wakes on SendMessage, so it counts as alive.
export function sessionAlive(s: Session | null | undefined): s is Session {
  return !!s && s.kind === "background" && s.state !== "stopped" && s.state !== "failed" && daemonAlive();
}

export function findSession(name: string, includeDone = false): Session | null {
  const hits = sessions(includeDone).filter((s) => s.name === name);
  const live = hits.filter(sessionAlive);
  return live[0] ?? hits[0] ?? null;
}

export function waitForName(name: string, timeoutS = 90): Session | null {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const s = findSession(name);
    if (sessionAlive(s)) return s;
    sleep(3000);
  }
  return null;
}

export function stopSession(s: Session | null, remove = true): void {
  const id = s?.id;
  if (!id) return;
  run(claudeBin(), ["stop", id]);
  if (remove) run(claudeBin(), ["rm", id]);
}

const field = (s: Session, k: string) => (k in s ? pyStr(s[k]) : "?");

// One line per fleet member: live session, stale record, or nothing. Returns the live ones too.
export function fleetLines(ws: Workspace): { lines: string[]; live: Map<string, Session> } {
  const listed = new Map<string, Session>();
  for (const s of sessions()) if (s.kind === "background" && s.name !== undefined) listed.set(s.name, s);
  const live = new Map([...listed].filter(([, s]) => sessionAlive(s)));
  const lines = ws.config.agents.map((a) => {
    const s = listed.get(a.name);
    const st = s && live.has(a.name)
      ? `${field(s, "status")}/${field(s, "state")} id=${pyStr(s.id)} cwd=${pyStr(s.cwd)}`
      : s
        ? `not running (stale record id=${pyStr(s.id)} says ${field(s, "state")}; the daemon is gone)`
        : "not running";
    return `  ${a.name.padEnd(10)} ${a.role.padEnd(9)} ${st}`;
  });
  return { lines, live };
}
