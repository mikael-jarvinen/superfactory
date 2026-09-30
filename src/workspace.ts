import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Config, loadConfig } from "./config.js";
import { die } from "./util.js";

export const CONFIG_FILE = "factory.toml";

export interface Workspace {
  dir: string;
  config: Config;
  stateDir: string;
  logsDir: string;
  runDir: string;
  events: string;
  messages: string;
}

export interface Resolve {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

// --workspace, then $FACTORY_WORKSPACE, then the nearest factory.toml walking up from the cwd.
export function resolveWorkspace({ flag, env = process.env, cwd = process.cwd() }: Resolve = {}): string {
  const given = flag ?? (env.FACTORY_WORKSPACE || undefined);
  if (given !== undefined) {
    const from = flag !== undefined ? "--workspace" : "FACTORY_WORKSPACE";
    const dir = resolve(cwd, given);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`${from} ${given}: no such directory`);
    const real = realpathSync(dir);
    if (!existsSync(join(real, CONFIG_FILE))) die(`${from} ${given}: no ${CONFIG_FILE} in ${real}`);
    return real;
  }
  let dir = realpathSync(cwd);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return die(`no workspace: pass --workspace <dir>, set FACTORY_WORKSPACE, or run inside a directory holding ${CONFIG_FILE}`);
}

export function openWorkspace(dir: string, env: NodeJS.ProcessEnv = process.env): Workspace {
  const config = loadConfig(join(dir, CONFIG_FILE), env);
  const stateDir = config.paths.state;
  const logsDir = config.paths.logs;
  return {
    dir,
    config,
    stateDir,
    logsDir,
    runDir: join(logsDir, "run"),
    events: join(stateDir, "events.jsonl"),
    messages: join(stateDir, "messages.jsonl"),
  };
}
