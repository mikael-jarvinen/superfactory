// PreToolUse hook for SendMessage, in every session's settings: wakes a recipient that is off and
// lets the send through once it is live, or blocks the send with why it could not.
//
// A recipient that is not a fleet agent by name (`to` is "name" or "name [ref]") is left alone, and
// so is one whose host cannot be listed, or a workspace that does not load: the send then succeeds or
// fails on its own, as it did before this hook. A respawn that fails blocks, its host's failure
// included, with why: the recipient is known to be off, so the send would fail anyway.
//
// A session on a host runs this with --from-host <host>. It can wake only an agent on that same
// host, through its local claude; it cannot list the primary or another host, so a message to any
// other agent passes through. If that send then fails, the same hook after it says the agent
// is off and to have the lead wake it, rather than leave "not reachable" unexplained. The lead
// being off is a known gap: nobody else can wake it.
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";
import { sleep } from "../util.js";
import { lead } from "../fleet.js";
import { local } from "../transport.js";
import { WAKE_SETTLE_S, wake } from "../wake.js";
import { openWorkspace, resolveWorkspace } from "../workspace.js";

export const WAKE_HOOK_TIMEOUT_S = 90;

// What SendMessage says of a recipient that is off, or not there at all.
const NOT_REACHABLE = /No agent named .* is reachable|\bis not reachable\b/;

export const recipient = (to: unknown): string | null => {
  if (typeof to !== "string") return null;
  const n = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  return n || null;
};

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
  try {
    const ev = JSON.parse(input) as { hook_event_name?: unknown; tool_input?: { to?: unknown }; tool_response?: { success?: unknown; message?: unknown }; error?: unknown };
    to = recipient(ev.tool_input?.to);
    // Explained is only a send that failed as not reachable: a result with success false and that
    // message (PostToolUse, recorded in the test fixtures), or a tool error saying it
    // (PostToolUseFailure). Any other failure, a name two sessions share say, passes as it is.
    if (ev.hook_event_name === "PostToolUse" || ev.hook_event_name === "PostToolUseFailure") {
      const said = ev.hook_event_name === "PostToolUse" ? (ev.tool_response?.success === false ? ev.tool_response.message : undefined) : ev.error;
      if (!fromHost || typeof said !== "string" || !NOT_REACHABLE.test(said)) return { code: 0 };
      failedSend = true;
    }
  } catch {
    return { code: 0 };
  }
  if (!to) return { code: 0 };
  let ws;
  try {
    ws = openWorkspace(resolveWorkspace({ flag: workspace }));
  } catch {
    return { code: 0 };
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
    return { code: 2, stderr: `${to} could not be checked or woken: ${(e as Error).message}\n` };
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
