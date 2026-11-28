// What each backend can and cannot do, as plain data with no imports, so config.ts can check an
// agent against its backend without loading the backends (which import config.ts in turn). Each
// backend in backends/ spreads its own entry, so these are AgentBackend's too.
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
  // Which models agy takes is asked of the agy that runs, at start (agy-supervisor.ts pickValue),
  // never of a list kept here, which would go stale with the next agy.
  antigravity: { listing: "the antigravity sessions", onHosts: true, roleModel: false },
};
