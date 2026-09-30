import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Stack } from "../config.js";
import type { Workspace } from "../workspace.js";
import { die, run, type RunResult } from "../util.js";

// The program owns the slots; the workspace's script owns what a slot runs. It is called as
// `<script> <verb>` with the slot in its environment, and exit 0 is success.
//
//   up       bring the slot to the placement in the environment. Called on a slot that may already
//            be up, so it must be safe to repeat.
//   down     stop what the slot runs and keep its data.
//   destroy  stop it and delete its data. Also called to reclaim a slot whose worktree has been
//            removed, so it must work when FACTORY_WORKTREE_<REPO> no longer exists.
//   url      print the slot's base URL.
//   status   print name<TAB>url<TAB>health rows for the board. Called for every slot on every
//            export, so it prints what the slot would serve and probes nothing; the board probes.
//   doctor   print `ok <what>` or `MISSING <what> [fix: <step>]` lines for the machine.
export const VERBS = ["up", "down", "destroy", "url", "status", "doctor"] as const;
export type Verb = (typeof VERBS)[number];

// What a slot holds: a worktree per repo key. Empty for a free slot.
export type Placement = Record<string, string>;

// A repo key in a variable name: upper case, anything a shell would not take as `_`.
export const envKey = (repo: string) => repo.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export const slotDir = (ws: Workspace, stack: string, slot: number) => join(ws.stateDir, "stacks", stack, String(slot));
export const slotLogDir = (ws: Workspace, stack: string, slot: number) => join(ws.logsDir, "stacks", stack, String(slot));

export function scriptEnv(ws: Workspace, stack: Stack, slot: number, placement: Placement): Record<string, string> {
  const env: Record<string, string> = {
    FACTORY_WORKSPACE: ws.dir,
    FACTORY_STACK: stack.key,
    FACTORY_SLOT: String(slot),
    FACTORY_SLOT_DIR: slotDir(ws, stack.key, slot),
    FACTORY_LOG_DIR: slotLogDir(ws, stack.key, slot),
  };
  // Every repo gets both variables, empty when the slot holds nothing, so a script under `set -u`
  // can read them on any verb.
  for (const r of stack.repos) {
    env[`FACTORY_WORKTREE_${envKey(r)}`] = placement[r] ?? "";
    env[`FACTORY_CHECKOUT_${envKey(r)}`] = ws.config.repos[r]?.path ?? "";
  }
  return env;
}

export function scriptOf(stack: Stack): string {
  return stack.script ?? die(`stacks.${stack.key} has no script, so its slots run nothing. Set stacks.${stack.key}.script in factory.toml.`);
}

// `stream` hands the script this process's stdout and stderr, for the verbs that take minutes and
// report as they go. Otherwise both are captured, for the verbs whose output the engine reads.
// `args` follow the verb: what the command line gave after `--`, for the script alone.
export function callScript(ws: Workspace, stack: Stack, slot: number, placement: Placement, verb: Verb, stream = false, args: string[] = []): RunResult {
  const script = scriptOf(stack);
  const env = { ...process.env, ...scriptEnv(ws, stack, slot, placement) };
  mkdirSync(env.FACTORY_SLOT_DIR as string, { recursive: true });
  mkdirSync(env.FACTORY_LOG_DIR as string, { recursive: true });
  if (!stream) return run(script, [verb, ...args], { cwd: ws.dir, env });
  const r = spawnSync(script, [verb, ...args], { cwd: ws.dir, env, stdio: ["ignore", "inherit", "inherit"] });
  if (r.error) return { status: 127, stdout: "", stderr: `cannot run ${script}: ${r.error.message}` };
  return { status: r.status ?? 1, stdout: "", stderr: "" };
}

// The failure as the person reading it needs it: which call, and what the script said.
export function failed(stack: Stack, slot: number, verb: Verb, r: RunResult): string {
  const said = r.stderr.trim();
  return `${stack.key} slot ${slot}: \`${verb}\` exited ${r.status}${said ? `:\n${said}` : ""}`;
}
