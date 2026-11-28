// Which CLI runs an agent's sessions. A Transport says where a session runs; its backend says what
// runs there: how a session starts and stops, how it is listed and told alive or mid-turn, how a
// message reaches it, what settings and hooks it is given, where its transcripts are, and how the
// plan's usage is read. An agent names its backend with `backend` in [[agents]] (config.ts).
//
// Two kinds of CLI sit behind it. One keeps its own sessions: Claude's daemon runs each `claude
// --bg` worker and lists them (claude.ts). The other is a process that lives only as long as
// whoever holds its stdio, as `agy acp` does; its backend runs a supervisor of its own for each
// session, detached so it outlives the `factory` command, and lists the supervisors
// (antigravity.ts). Every method below is written for both.
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
  // The brief's file, or null for a session with none.
  appendixPath: string | null;
  // The file installSettings wrote, or null for a backend that takes no settings file.
  settings: string | null;
  addDirs: string[];
  // The name the session is shown under in the CLI's own remote control, or undefined for none.
  remoteControl?: string;
  mcpConfig?: string;
  model?: string;
  effort?: string;
  autocompact?: string;
  permissionMode?: string;
}

// Its capabilities (capabilities.ts): what its listing is called, whether it runs on a host,
// whether a role's model applies to it, and which models it takes.
export interface AgentBackend extends BackendCapabilities {
  readonly name: string;

  // Launch: the arguments of a background start, run by start() on the machine that runs the session.
  launchArgs(spec: LaunchSpec): string[];
  // Runs a start on this machine, with the brief's file the transport wrote, and returns the id the
  // session is listed under, or "?" when the CLI printed none. It returns once the session is
  // started and held by something that outlives the caller: the CLI's daemon, or the backend's
  // supervisor.
  start(req: StartRequest, appendixPath: string | null): string;
  stop(id: string, remove: boolean): void;
  // Where to look when a start does not come up, for the error that says so.
  logsHint(id: string): string;

  // Listing and liveness, from wherever the backend keeps its sessions: the CLI's registry, or its
  // supervisors' state files. sessions() throws ListingTimedOut (remote.ts) on a listing that
  // hangs; sessionsAsync() resolves to an empty list on any failure. alive() takes a row of this
  // backend's own listing, and probes the process behind it.
  sessions(includeDone?: boolean): Session[];
  sessionsAsync(): Promise<Session[]>;
  alive(s: Session | null | undefined): s is Session;
  // Busy: a session in a turn, which a stop cuts short. Any other live session is idle.
  midTurn(s: Session): boolean;

  // Message delivery. messageTool is the tool a session sends messages with; the wake hook in its
  // settings runs before that tool and starts a recipient that is off. null for a session that has
  // no such tool. deliver, on a backend whose sessions cannot be reached by that tool, puts a
  // message into a live session as its next prompt; the wake hook calls it for a send to one.
  readonly messageTool: string | null;
  deliver?(s: Session, text: string): void;

  // Settings and hooks: writes the session's settings file, hooks included, and returns its path.
  // Left out by a backend whose sessions take no settings file.
  installSettings?(ws: Workspace, s: SessionSettings): string;

  // Transcripts and usage: the directory that holds every transcript, the one for a cwd's sessions,
  // and when a session last wrote its transcript (undefined when it is not found).
  transcriptsDir(): string;
  projectDir(cwd: string): string;
  transcriptAt(s: Session): number | undefined;

  // The plan's weekly usage, read with the CLI's own login.
  planUsage(): PlanFetch;
}
