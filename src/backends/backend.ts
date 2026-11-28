// Which CLI runs an agent's sessions. A Transport says where a session runs; its backend says what
// runs there: how a session starts and stops, how it is listed and told alive or mid-turn, how a
// message reaches it, what settings and hooks it is given, where its transcripts are, and how the
// plan's usage is read. An agent names its backend with `backend` in [[agents]] (config.ts).
import type { RoleName } from "../config.js";
import type { PlanFetch } from "../board/plan-usage.js";
import type { Session } from "../fleet.js";
import type { SessionSettings } from "../settings.js";
import type { StartRequest } from "../transport.js";
import type { Workspace } from "../workspace.js";

// What a background start needs, in no CLI's terms; the backend turns it into its own arguments.
export interface LaunchSpec {
  name: string;
  role: RoleName;
  prompt: string;
  // The brief's file, or null for a session with none.
  appendixPath: string | null;
  // The file installSettings wrote.
  settings: string;
  addDirs: string[];
  // The name the session is shown under in the CLI's own remote control, or undefined for none.
  remoteControl?: string;
  mcpConfig?: string;
  model?: string;
  effort?: string;
  autocompact?: string;
  permissionMode?: string;
}

export interface AgentBackend {
  readonly name: string;

  // Launch: the arguments of a background start, run by start() on the machine that runs the session.
  launchArgs(spec: LaunchSpec): string[];
  // Runs a start on this machine, with the brief's file the transport wrote, and returns the launch
  // id the CLI printed, or "?".
  start(req: StartRequest, appendixPath: string | null): string;
  stop(id: string, remove: boolean): void;

  // Listing and liveness. sessions() throws ListingTimedOut (remote.ts) on a listing that hangs;
  // sessionsAsync() resolves to an empty list on any failure.
  sessions(includeDone?: boolean): Session[];
  sessionsAsync(): Promise<Session[]>;
  alive(s: Session | null | undefined): s is Session;
  // Busy: a session in a turn, which a stop cuts short. Any other live session is idle.
  midTurn(s: Session): boolean;

  // Message delivery. The tool a session sends messages with; the wake hook in its settings runs
  // before that tool and starts a recipient that is off.
  readonly messageTool: string;

  // Settings and hooks: writes the session's settings file, hooks included, and returns its path.
  installSettings(ws: Workspace, s: SessionSettings): string;

  // Transcripts and usage: the directory that holds every transcript, the one for a cwd's sessions,
  // and when a session last wrote its transcript (undefined when it is not found).
  transcriptsDir(): string;
  projectDir(cwd: string): string;
  transcriptAt(s: Session): number | undefined;

  // The plan's weekly usage, read with the CLI's own login.
  planUsage(): PlanFetch;
}
