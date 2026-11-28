// PreToolUse hook for SendMessage, in every session's settings: starts a fresh session for a
// recipient that is off (wake.ts), then lets the send through. A recipient known to be off that
// does not come up blocks the send with why;
// one not in the fleet, or whose listing cannot be had, passes. The hook never stops a message by
// its own error: failOpen lets it through and says so. From a host (--from-host) it wakes only
// agents on that host, and after a send to any other fails as not reachable it says to have the
// lead wake it. The lead being off is a known gap: nobody else can wake it.
//
// A recipient whose backend has no such tool, an Antigravity agent, is never reached by the send
// itself: the hook puts the message in its session as the next prompt (AgentBackend.deliver) and
// denies the tool call, saying it was delivered.
import { appendFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";
import { sleep } from "../util.js";
import { defaultLogsDir } from "../config.js";
import { iso, wakeHookLog } from "../failures.js";
import { backendFor } from "../backends/index.js";
import { lead } from "../fleet.js";
import { roleOf } from "../launch.js";
import type { Workspace } from "../workspace.js";
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

type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

// The tool call denied, with why: a delivery, or a recipient that cannot be reached.
const deny = (reason: string): HookResult => ({
  code: 0,
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
});

// The sender as the recipient is told it: the agent whose role cwd the sending session is in.
function senderName(ws: Workspace, cwd: unknown): string {
  const hit = typeof cwd === "string" ? ws.config.agents.find((a) => a.role !== "builder" && roleOf(ws, a).cwd === cwd) : undefined;
  return hit ? hit.name : `a factory session in ${String(cwd ?? "?")}`;
}

// The hook's own error: the send goes, or after it the failure is left unexplained, and the error is
// logged and told to the sender under the event it answers. A workspace whose config does not load
// logs to its default logs/; with no workspace found there is no log.
function failOpen(event: HookEvent, logsDir: string | null, sender: string, to: string, e: unknown): HookResult {
  const error = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? (e.stack ?? error) : error;
  let logged = logsDir ? "" : "\n(no workspace found, so not logged)";
  if (logsDir) try {
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(wakeHookLog(logsDir), `${JSON.stringify({ at: iso(), from: sender, to, error, stack })}\n`);
  } catch (le) {
    logged = `\n(and it could not be logged: ${(le as Error).message})`;
  }
  const said = event === "PreToolUse" ? `wake check failed: ${error}; message sent without a wake check` : `wake check failed: ${error}; the failed send to ${to} is not explained`;
  return {
    code: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: said } }),
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
  let text: string | null = null;
  let senderCwd: unknown;
  let event: HookEvent = "PreToolUse";
  let sender = `session ? in ?${fromHost ? ` on ${fromHost}` : ""}`;
  try {
    const ev = JSON.parse(input) as { hook_event_name?: unknown; session_id?: unknown; cwd?: unknown; tool_input?: { to?: unknown; message?: unknown }; tool_response?: { success?: unknown; message?: unknown }; error?: unknown };
    sender = `session ${String(ev.session_id ?? "?")} in ${String(ev.cwd ?? "?")}${fromHost ? ` on ${fromHost}` : ""}`;
    to = recipient(ev.tool_input?.to);
    text = typeof ev.tool_input?.message === "string" ? ev.tool_input.message : null;
    senderCwd = ev.cwd;
    // Explained is only a send that failed as not reachable: a result with success false and that
    // message (PostToolUse, as recorded), or a tool error saying it (PostToolUseFailure, not seen,
    // assumed to say the same). Any other failure, a name two sessions share say, passes as it is.
    if (ev.hook_event_name === "PostToolUse" || ev.hook_event_name === "PostToolUseFailure") {
      const said = ev.hook_event_name === "PostToolUse" ? (ev.tool_response?.success === false ? ev.tool_response.message : undefined) : ev.error;
      if (!fromHost || typeof said !== "string" || !NOT_REACHABLE.test(said)) return { code: 0 };
      failedSend = true;
      event = ev.hook_event_name;
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
    return failOpen(event, dir && defaultLogsDir(dir), sender, to, e);
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
    return failOpen("PreToolUse", ws.logsDir, sender, to, e);
  }
  const b = backendFor(agent);
  if (b.deliver && !failedSend) {
    if (w.is === "unknown") return deny(`${to}'s session could not be listed (${w.why}), so the message was not delivered. Try again shortly.`);
    if (w.is === "failed") return deny(`${to} is off and did not start: ${w.why.replace(/\.$/, "")}. The message was not delivered.`);
    if (!text) return deny(`the message to ${to} has no text, so nothing was delivered.`);
    try {
      b.deliver(w.s, `Message from ${senderName(ws, senderCwd)}:\n\n${text}`);
    } catch (e) {
      return deny(`the message to ${to} was not delivered: ${(e as Error).message}`);
    }
    return deny(`Delivered: ${to} runs on ${b.name}, which SendMessage does not reach, so the message went into its session as its next prompt${w.is === "started" ? ", after a fresh start" : ""}. Do not send it again. Its answers are in its transcript, not a reply.`);
  }
  switch (w.is) {
    case "live":
    case "unknown":
      return { code: 0 };
    case "started":
      if (settle > 0) sleep(settle * 1000);
      return { code: 0 };
    case "failed":
      // a builder or designer, which wake does not start: another try fails the same way
      if (w.fresh) return { code: 2, stderr: `${to} is off: ${w.why}. Tell the lead, who starts it with \`${w.fresh}\`; then send.\n` };
      return { code: 2, stderr: `${to} is off and did not start: ${w.why.replace(/\.$/, "")}. Try \`factory wake ${to}\`, or tell the lead.\n` };
  }
}
