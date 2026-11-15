// PreToolUse hook for SendMessage, in every session's settings: wakes a recipient that is off and
// lets the send through once it is live, or blocks the send with why it could not.
//
// A recipient that is not a fleet agent by name (`to` is "name" or "name [ref]") is left alone, and
// so is one whose listing timed out or whose host cannot be asked, or a workspace that does not load:
// the send then succeeds or fails on its own, as it did before this hook. Any other error in the hook
// lets the send through too: the hook is there to wake, never to stop a message, and SendMessage
// fails by itself on a recipient that is not reachable. That error, with its stack, is appended to
// the workspace's logs/wake-hook.log and written to stderr, and the sender is told the message went
// without a wake check. A respawn
// that fails blocks, its host's failure included, with why: the recipient is known to be off, so the
// send would fail anyway.
//
// A session on a host runs this with --from-host <host>. It can wake only an agent on that same
// host, through its local claude; it cannot list the primary or another host, so a message to any
// other agent passes through. If that send then fails, the same hook after it says the agent
// is off and to have the lead wake it, rather than leave "not reachable" unexplained. The lead
// being off is a known gap: nobody else can wake it.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";
import { sleep } from "../util.js";
import { lead } from "../fleet.js";
import { local } from "../transport.js";
import { WAKE_SETTLE_S, wake } from "../wake.js";
import { openWorkspace, resolveWorkspace } from "../workspace.js";

export const WAKE_HOOK_TIMEOUT_S = 90;

// What SendMessage says of a recipient that is off, or not there at all (test/fixtures/sendmessage-failed.json).
const NOT_REACHABLE = /No agent named .* is reachable/;

export const recipient = (to: unknown): string | null => {
  if (typeof to !== "string") return null;
  const n = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  return n || null;
};

// The hook's own error: the send goes, and the error is logged and told to the sender. A workspace
// whose config does not load logs to its default logs/; with no workspace found there is no log.
function failOpen(logsDir: string | null, sender: string, to: string, e: unknown): HookResult {
  const error = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? (e.stack ?? error) : error;
  let logged = logsDir ? "" : "\n(no workspace found, so not logged)";
  if (logsDir) try {
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, "wake-hook.log"), `${JSON.stringify({ at: new Date().toISOString(), from: sender, to, error, stack })}\n`);
  } catch (le) {
    logged = `\n(and it could not be logged: ${(le as Error).message})`;
  }
  const said = `wake check failed: ${error}; message sent without a wake check`;
  return {
    code: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: said } }),
    stderr: `factory hook wake: ${said}\n${stack}${logged}\n`,
  };
}

export function hook(argv: string[], input: string, workspace?: string): HookResult {
  const t0 = Date.now();
  const v = parseArgs({ args: argv, options: { "wait-seconds": { type: "string" }, "settle-seconds": { type: "string" }, "from-host": { type: "string" }, "timeout-seconds": { type: "string" } }, strict: false }).values;
  const num = (x: unknown, d: number) => (typeof x === "string" && /^\d+$/.test(x) ? Number(x) : d);
  const waitS = num(v["wait-seconds"], 60);
  const settleS = num(v["settle-seconds"], WAKE_SETTLE_S);
  const timeoutS = num(v["timeout-seconds"], WAKE_HOOK_TIMEOUT_S);
  const fromHost = typeof v["from-host"] === "string" ? v["from-host"] : undefined;
  let to: string | null = null;
  let failedSend = false;
  let sender = `session ? in ?${fromHost ? ` on ${fromHost}` : ""}`;
  try {
    const ev = JSON.parse(input) as { hook_event_name?: unknown; session_id?: unknown; cwd?: unknown; tool_input?: { to?: unknown }; tool_response?: { success?: unknown; message?: unknown }; error?: unknown };
    sender = `session ${String(ev.session_id ?? "?")} in ${String(ev.cwd ?? "?")}${fromHost ? ` on ${fromHost}` : ""}`;
    to = recipient(ev.tool_input?.to);
    // Explained is only a send that failed as not reachable: a result with success false and that
    // message (PostToolUse, as recorded), or a tool error saying it (PostToolUseFailure, not seen,
    // assumed to say the same). Any other failure, a name two sessions share say, passes as it is.
    if (ev.hook_event_name === "PostToolUse" || ev.hook_event_name === "PostToolUseFailure") {
      const said = ev.hook_event_name === "PostToolUse" ? (ev.tool_response?.success === false ? ev.tool_response.message : undefined) : ev.error;
      if (!fromHost || typeof said !== "string" || !NOT_REACHABLE.test(said)) return { code: 0 };
      failedSend = true;
    }
  } catch (e) {
    return { code: 0, stderr: `factory hook wake: the hook's input is not JSON (${(e as Error).message}); message sent without a wake check\n` };
  }
  if (!to) return { code: 0 };
  let dir: string | null = null;
  let ws;
  try {
    dir = resolveWorkspace({ flag: workspace });
    ws = openWorkspace(dir);
  } catch (e) {
    return failOpen(dir && join(dir, "logs"), sender, to, e);
  }
  const agent = ws.config.agents.find((a) => a.name === to);
  if (!agent) return { code: 0 };
  if (failedSend) {
    const ld = lead(ws).name;
    if (agent.host === fromHost || agent.name === ld) return { code: 0 };
    return { code: 2, stderr: `${to} runs on ${agent.host ?? "the primary"}, not on ${fromHost}, and was not reachable: it is most likely off (stopped idle), and a session on ${fromHost} cannot wake it. Tell ${ld} that ${to} is off, so ${ld} wakes it (\`factory wake ${to}\`); then send again.\n` };
  }
  if (fromHost && agent.host !== fromHost) return { code: 0 };
  // Listed live on its host is not yet addressable from another machine over Remote Control.
  const settle = !fromHost && agent.host ? settleS : 0;
  // Everything, the settle included, ends 5 s before the hook would be killed.
  const deadline = t0 + (timeoutS - 5 - settle) * 1000;
  let w;
  try {
    w = wake(ws, agent, { waitS, deadline, ...(fromHost ? { t: local } : {}) });
  } catch (e) {
    return failOpen(ws.logsDir, sender, to, e);
  }
  switch (w.is) {
    case "live":
    case "unknown":
      return { code: 0 };
    case "woke":
      if (settle > 0) sleep(settle * 1000);
      return { code: 0 };
    case "none":
      return { code: 2, stderr: `${to} is off and has no session to wake. Start it the factory way (dispatch, review or assistant), then send.\n` };
    case "failed":
      return { code: 2, stderr: `${to} is off and did not wake: ${w.why}. Try \`factory wake ${to}\`, or tell the lead.\n` };
  }
}
