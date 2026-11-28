// The ACP ToolKinds (https://agentclientprotocol.com/protocol/tool-calls) that only read. "fetch"
// reads from the network, where a request can carry the workspace out, so it is not one.
export const READ_ONLY_KINDS: readonly string[] = ["read", "search", "think"];

export const readOnly = (kind: unknown): boolean => typeof kind === "string" && READ_ONLY_KINDS.includes(kind);

// One option of a permission request (ACP PermissionOption).
export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: string;
}

// The answer to a session/request_permission: the first allow-once option when it is allowed, else
// the first reject option, and "cancelled" when the request offers none. Never an allow-always: a
// rule the agent keeps would outlive the supervisor's rules.
export function permissionOutcome(allow: boolean, options: unknown): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const opts = Array.isArray(options) ? (options as PermissionOption[]).filter((o) => o && typeof o.optionId === "string") : [];
  const pick = (k: string) => opts.find((o) => o.kind === k);
  const chosen = allow ? pick("allow_once") : (pick("reject_once") ?? pick("reject_always"));
  return chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" };
}
