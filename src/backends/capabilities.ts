// What each backend can do, as plain data, so config.ts can check an agent without loading the
// backends, which import config.ts in turn.
import type { BackendName } from "../config.js";

export interface BackendCapabilities {
  // What its listing is called, in an error that says a session did not appear in it.
  readonly listing: string;
  // Whether a host's daemon can start and list its sessions, so an agent of it may take a host.
  readonly onHosts: boolean;
  // Whether a role's model and effort apply to an agent of it that sets none. They name Claude's.
  readonly roleModel: boolean;
}

export const CAPABILITIES: Record<BackendName, BackendCapabilities> = {
  claude: { listing: "`claude agents`", onHosts: true, roleModel: true },
  // agy's models are asked of the agy that runs (pickValue); a list here would go stale.
  antigravity: { listing: "the antigravity sessions", onHosts: true, roleModel: false },
};
