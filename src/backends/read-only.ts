// What an Antigravity session may do without the guard (hooks/guard.ts), which does not run under
// agy: the tool calls it may make are the read-only ones, and the supervisor's
// session/request_permission handler (agy-supervisor.ts) denies every other one. A tool call is
// told by its ACP ToolKind (https://agentclientprotocol.com/protocol/tool-calls), which the agent
// sets on each call. "fetch" reads, but from the network, where a request can carry the workspace
// out, so it is not on the list; nor is "execute", whatever the command, nor "other" or a kind the
// call leaves out.
export const READ_ONLY_KINDS: readonly string[] = ["read", "search", "think"];

export const readOnly = (kind: unknown): boolean => typeof kind === "string" && READ_ONLY_KINDS.includes(kind);

// One option of a permission request (ACP PermissionOption).
export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: string;
}

// The answer to a session/request_permission: the first allow-once option for a read-only call;
// for any other call, the first reject option, and "cancelled" when the request offers none. Never
// an allow-always: a rule the agent keeps would outlive this handler.
export function permissionOutcome(kind: unknown, options: unknown): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const opts = Array.isArray(options) ? (options as PermissionOption[]).filter((o) => o && typeof o.optionId === "string") : [];
  const pick = (k: string) => opts.find((o) => o.kind === k);
  const chosen = readOnly(kind) ? pick("allow_once") : (pick("reject_once") ?? pick("reject_always"));
  return chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" };
}
