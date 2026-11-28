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
  // Why a model an agent names cannot run under it, or null when it can.
  modelProblem(model: string): string | null;
}

// agy 1.5.19's models, as its session config offers them (value, then name). The supervisor picks
// a model by either, case aside (agy-supervisor.ts pickValue).
export const AGY_MODELS: readonly (readonly [string, string])[] = [
  ["gemini-4-neon", "Gemini 4 Neon"],
  ["gemini-4-carbon", "Gemini 4 Carbon"],
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
  ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"],
  ["gemini-pro-orchestrator", "Orchestrator (Carbon)"],
  ["gemini-pro-orchestrator-argon", "Orchestrator (Argon)"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];

export const CAPABILITIES: Record<BackendName, BackendCapabilities> = {
  claude: { listing: "`claude agents`", onHosts: true, roleModel: true, modelProblem: () => null },
  antigravity: {
    listing: "the antigravity sessions",
    onHosts: false,
    roleModel: false,
    modelProblem: (m) =>
      AGY_MODELS.some((x) => x.some((w) => w.toLowerCase() === m.toLowerCase()))
        ? null
        : `${JSON.stringify(m)} is not an agy model; agy offers ${AGY_MODELS.map(([v]) => v).join(", ")}`,
  },
};
