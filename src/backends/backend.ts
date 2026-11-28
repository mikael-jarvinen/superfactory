// Which CLI runs an agent's sessions; a Transport says where. Written for both kinds of CLI: one
// that keeps its own sessions (Claude's daemon), and one that lives only as long as whoever holds
// its stdio (`agy acp`), whose backend runs a detached supervisor per session.
import type { RoleName } from "../config.js";
import type { PlanFetch } from "../board/plan-usage.js";
import type { Session } from "../fleet.js";
import type { SessionSettings } from "../settings.js";
import type { StartRequest } from "../transport.js";
import type { BackendCapabilities } from "./capabilities.js";
import type { Workspace } from "../workspace.js";

// What a background start needs, in no CLI's terms; the backend turns it into its own arguments.
export interface LaunchSpec {
  name: string;
  role: RoleName;
  prompt: string;
  appendixPath: string | null;
  // The file installSettings wrote, or null for a backend that takes no settings file.
  settings: string | null;
  addDirs: string[];
  // The session's name in the CLI's own remote control.
  remoteControl?: string;
  mcpConfig?: string;
  model?: string;
  effort?: string;
  autocompact?: string;
  permissionMode?: string;
}

export interface AgentBackend extends BackendCapabilities {
  readonly name: string;

  // The arguments of a background start, which start() runs on the session's machine.
  launchArgs(spec: LaunchSpec): string[];
  // Returns the session's id, or "?" when the CLI printed none, once the session is held by
  // something that outlives the caller: the CLI's daemon, or the backend's supervisor.
  start(req: StartRequest, appendixPath: string | null): string;
  stop(id: string, remove: boolean): void;
  // Where to look when a start does not come up, for the error that says so.
  logsHint(id: string): string;

  // sessions() throws ListingTimedOut (remote.ts) on a listing that hangs; sessionsAsync()
  // resolves to an empty list on any failure. alive() probes the process behind a row of its own.
  sessions(includeDone?: boolean): Session[];
  sessionsAsync(): Promise<Session[]>;
  alive(s: Session | null | undefined): s is Session;
  // Busy: a session in a turn, which a stop cuts short. Any other live session is idle.
  midTurn(s: Session): boolean;

  // messageTool is the tool a session sends messages with, before which the wake hook starts a
  // recipient that is off; null for none. deliver, for a backend that tool cannot reach, puts a
  // message in a live session as its next prompt; the wake hook calls it.
  readonly messageTool: string | null;
  deliver?(s: Session, text: string, from?: string): void;

  // Writes the session's settings file, hooks included, and returns its path.
  installSettings?(ws: Workspace, s: SessionSettings): string;

  // transcriptAt: when a session last wrote its transcript.
  transcriptsDir(): string;
  projectDir(cwd: string): string;
  transcriptAt(s: Session): number | undefined;

  // The plan's weekly usage, read with the CLI's own login.
  planUsage(): PlanFetch;
}
