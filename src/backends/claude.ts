// Claude Code: sessions are `claude --bg` workers under its daemon, listed by `claude agents --json`.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { oauthUsage } from "../board/plan-usage.js";
import { claudeConfigDir } from "../claude-bin.js";
import type { Session } from "../fleet.js";
import { ListingTimedOut } from "../remote.js";
import { claudeEnv, claudeScoped, scopeCheck } from "../scope.js";
import { renderSettings } from "../settings.js";
import { die, MAX_OUTPUT, run } from "../util.js";
import type { AgentBackend, LaunchSpec } from "./backend.js";

// The tool a Claude session sends messages with.
export const MESSAGE_TOOL = "SendMessage";

// Claude's projects/ directory for a cwd: the cwd with every character but a letter or digit made "-".
const projectDir = (cwd: string) => join(claudeConfigDir(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

// When a session last did anything: its transcript's mtime, under projects/ by its cwd. The listing
// gives a session only startedAt, and one started earlier may have talked since. Undefined when the
// transcript is not found.
export function transcriptAt(s: Session): number | undefined {
  if (typeof s.sessionId !== "string" || !/^[\w-]+$/.test(s.sessionId) || typeof s.cwd !== "string") return undefined;
  try {
    return statSync(join(projectDir(s.cwd), `${s.sessionId}.jsonl`)).mtimeMs;
  } catch {
    return undefined;
  }
}

const withActivity = (rows: Session[]): Session[] =>
  rows.map((s) => {
    const at = transcriptAt(s);
    return at === undefined ? s : { ...s, activeAt: at };
  });

// Rows that are not a list, `{}` say, are as unreadable as text that is not JSON.
const parse = (stdout: string): Session[] => {
  const rows: unknown = JSON.parse(stdout || "[]");
  if (!Array.isArray(rows)) throw new SyntaxError("not a list");
  return rows as Session[];
};

// `claude agents --json` is a registry, not a probe: after the daemon retires an idle worker and
// exits, the listing keeps the session at its last state. The roster names the supervisor pid; a
// dead pid or a missing control socket means no background session is alive, whatever the listing
// says. These are undocumented Claude Code internals, so they stay behind this one function.
// Probed on every call, never cached. The roster is under claude's config dir, as transcripts are;
// SF_CC_DAEMON_DIR stands in for the socket dir, so a test can give the probe a daemon of its own.
export const daemonSocketDir = () => process.env.SF_CC_DAEMON_DIR || join("/tmp", `cc-daemon-${process.getuid?.() ?? ""}`);
export function daemonAlive(): boolean {
  try {
    const roster = JSON.parse(readFileSync(join(claudeConfigDir(), "daemon", "roster.json"), "utf8")) as { supervisorPid?: unknown };
    const pid = Number.parseInt(String(roster.supervisorPid), 10);
    if (!Number.isInteger(pid)) return false;
    process.kill(pid, 0);
    const base = daemonSocketDir();
    return readdirSync(base).some((d) => !d.startsWith(".") && existsSync(join(base, d, "control.sock")));
  } catch {
    return false;
  }
}

// Whether a process exists. EPERM means it does, run by someone else.
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A background session that has not stopped or failed, behind a daemon that is running. "done"
// means it finished a turn and is idle; it still wakes on SendMessage, so it counts as alive. But
// the listing keeps a row whose worker is gone, from before a reboot or retired by the daemon, at
// its last state, done or blocked; such a row has no pid. So a row is live only while its worker's
// pid exists. Not "started after the supervisor": a worker can outlive a supervisor restart, and
// one started from a pre-spawned spare predates its row's startedAt, so neither time rules it out.
// One exception: a worker just launched is listed working before its pid, for about 1.3 s after
// `claude --bg` returns. A pid-less working row younger than STARTING_MS is that start, and live;
// a stale row is done or blocked, and far older.
export const STARTING_MS = 30_000;
// A session in a turn: stopping it cuts the turn short. A worker just launched counts, as it is in
// its first turn.
export const midTurn = (s: Session): boolean => s.state === "working";

export function sessionAlive(s: Session | null | undefined): s is Session {
  if (!s || s.kind !== "background" || s.state === "stopped" || s.state === "failed") return false;
  if (typeof s.pid !== "number" || !Number.isInteger(s.pid) || s.pid <= 0)
    return s.state === "working" && Date.now() - instant(s.startedAt) < STARTING_MS && daemonAlive();
  return pidExists(s.pid) && daemonAlive();
}

// A number is epoch milliseconds; Date.parse would read it as text and give NaN.
export const instant = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : NaN);

// A listing that hangs is cut off here, so a caller with a deadline can count on it.
export const LISTING_TIMEOUT_MS = 20_000;

const scoped = (argv: string[], timeout?: number) => scopeCheck(argv, run(...claudeScoped(argv), { env: claudeEnv(), ...(timeout ? { timeout } : {}) }, `claude ${argv[0]}`));

// ORDER MATTERS. `--add-dir` is variadic and eats every following bare word, including the prompt,
// so it comes before the single-valued flags and the prompt always follows one of those.
function launchArgs(spec: LaunchSpec): string[] {
  const settings = ["--settings", spec.settings];
  const args = ["--bg"];
  if (spec.role !== "builder") args.push(...settings);
  for (const d of spec.addDirs) args.push("--add-dir", d);
  if (spec.remoteControl !== undefined) args.push("--remote-control", spec.remoteControl);
  if (spec.role === "builder") args.push(...settings);
  if (spec.mcpConfig) args.push("--mcp-config", spec.mcpConfig);
  args.push("--name", spec.name);
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.autocompact) args.push("--autocompact", spec.autocompact);
  if (spec.permissionMode) args.push("--permission-mode", spec.permissionMode);
  if (spec.appendixPath) args.push("--append-system-prompt-file", spec.appendixPath);
  args.push(spec.prompt);
  return args;
}

export const claudeBackend: AgentBackend = {
  name: "claude",
  launchArgs,
  start(req, appendixPath) {
    const argv = req.args(appendixPath);
    const r = scopeCheck(argv, run(...claudeScoped(argv), { cwd: req.cwd, env: claudeEnv(req.env), ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}) }, `claude ${argv[0]}`));
    if (r.status === 124 && req.timeoutMs) die(`claude --bg did not finish in the ${Math.round(req.timeoutMs / 1000)} s it had`);
    if (r.status !== 0) die(`claude --bg failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return /backgrounded · (\w+) · /.exec(r.stdout)?.[1] ?? "?";
  },
  stop(id, remove) {
    scoped(["stop", id]);
    if (remove) scoped(["rm", id]);
  },
  logsHint: (id) => `\`claude logs ${id}\``,
  sessions(includeDone = false) {
    const r = scoped(["agents", "--json", ...(includeDone ? ["--all"] : [])], LISTING_TIMEOUT_MS);
    if (r.status === 124) throw new ListingTimedOut(`\`claude agents --json\` did not answer in ${LISTING_TIMEOUT_MS / 1000} s`);
    if (r.status !== 0) die(`\`claude agents --json\` failed: ${r.stderr.trim()}`);
    let rows: Session[];
    try {
      rows = parse(r.stdout);
    } catch {
      return die("`claude agents --json` returned something that is not a JSON list");
    }
    return withActivity(rows);
  },
  // Any failure here, a scope's included, is an empty listing.
  sessionsAsync() {
    return new Promise((res) => {
      execFile(...claudeScoped(["agents", "--json"]), { timeout: LISTING_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: claudeEnv() }, (err, stdout) => {
        try {
          res(err ? [] : withActivity(parse(stdout)));
        } catch {
          res([]);
        }
      });
    });
  },
  alive: sessionAlive,
  midTurn,
  messageTool: MESSAGE_TOOL,
  installSettings: (ws, s) => renderSettings(ws, s, MESSAGE_TOOL),
  transcriptsDir: () => join(claudeConfigDir(), "projects"),
  projectDir,
  transcriptAt,
  planUsage: () => oauthUsage(),
};
