// PreToolUse hook for SendMessage, run as `factory --workspace W hook wake`, in every session's
// settings. A message to an agent whose session is off fails, and nothing queues it, so this wakes
// the recipient first and lets the send through once it is live. When it cannot wake it, the send
// is blocked with why, rather than failing with "not reachable" and nobody knowing it was off.
//
// A recipient that is not a fleet agent by name (`to` is "name" or "name [ref]") is left alone, and
// so is one whose host cannot be asked or a workspace that does not load: the send then succeeds or
// fails on its own, as it did before this hook.
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";
import { sleep } from "../util.js";
import { WAKE_SETTLE_S, wake } from "../wake.js";
import { openWorkspace, resolveWorkspace } from "../workspace.js";

// The settings give the hook WAKE_HOOK_TIMEOUT_S, so the wait for the session to be listed, the
// settle and the listings before it all fit inside it.
export const WAKE_HOOK_TIMEOUT_S = 90;

// The recipient's name, without the " [ref]" a listing may have given it.
export const recipient = (to: unknown): string | null => {
  if (typeof to !== "string") return null;
  const n = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  return n || null;
};

export function hook(argv: string[], input: string, workspace?: string): HookResult {
  const v = parseArgs({ args: argv, options: { "wait-seconds": { type: "string" }, "settle-seconds": { type: "string" } }, strict: false }).values;
  const num = (x: unknown, d: number) => (typeof x === "string" && /^\d+$/.test(x) ? Number(x) : d);
  const waitS = num(v["wait-seconds"], 60);
  const settleS = num(v["settle-seconds"], WAKE_SETTLE_S);
  let to: string | null = null;
  try {
    const ev = JSON.parse(input) as { tool_input?: { to?: unknown } };
    to = recipient(ev.tool_input?.to);
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
  let w;
  try {
    w = wake(ws, agent, { waitS });
  } catch (e) {
    return { code: 2, stderr: `${to} is off and did not wake: ${(e as Error).message}\n` };
  }
  switch (w.is) {
    case "live":
    case "unknown":
      return { code: 0 };
    case "woke":
      // Listed live on its host is not yet addressable from here over Remote Control.
      if (agent.host && settleS > 0) sleep(settleS * 1000);
      return { code: 0 };
    case "none":
      return { code: 2, stderr: `${to} is off and has no session to wake. Start it the factory way (dispatch, review or assistant), then send.\n` };
    case "failed":
      return { code: 2, stderr: `${to} is off and did not wake: ${w.why}. Try \`factory wake ${to}\`, or tell the lead.\n` };
  }
}
