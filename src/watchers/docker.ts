// Docker Desktop quit on its own twice on 2026-10-06, an orderly quit with no crash and no trigger
// in its logs, and took every stack down with it. Nobody noticed until a builder could not run a
// test. The queue watcher runs every 15 minutes, so it is the cheapest place to notice and bring it
// back: start Docker Desktop, then the same detached boot `factory up` uses, which waits for Docker.
import { spawnSync } from "node:child_process";
import { startBoot } from "../stacks/engine.js";
import type { Workspace } from "../workspace.js";

// DOCKER_BIN="" turns the watchdog off, as GH_BIN="" does for gh, so tests never touch the real daemon.
export function dockerWatchdog(ws: Workspace, env: NodeJS.ProcessEnv = process.env): string | null {
  const docker = env.DOCKER_BIN ?? "docker";
  if (!docker || process.platform !== "darwin") return null;
  if (!Object.values(ws.config.stacks).some((s) => s.script)) return null;
  if (spawnSync(docker, ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0) return null;
  if (spawnSync("open", ["-a", "Docker"], { stdio: "ignore", timeout: 20_000 }).status !== 0) {
    return "docker DOWN: Docker did not answer and `open -a Docker` failed; start Docker Desktop by hand";
  }
  const log = startBoot(ws);
  return `docker DOWN: started Docker Desktop and the stack boot${log ? ` (${log})` : ""}`;
}
