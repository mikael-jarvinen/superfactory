// The backends by the name an agent's `backend` gives (config.ts's BACKENDS).
import type { Agent, BackendName } from "../config.js";
import type { AgentBackend } from "./backend.js";
import { claudeBackend } from "./claude.js";

// A function, not a table built at load, so a module that imports this one in an import cycle
// never reads a backend before it is defined.
export function backend(name: BackendName): AgentBackend {
  const all: Record<BackendName, AgentBackend> = { claude: claudeBackend };
  return all[name];
}

export const backendFor = (agent: Pick<Agent, "backend">): AgentBackend => backend(agent.backend);
