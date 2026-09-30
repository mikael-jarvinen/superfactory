import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

export const TOML = `
[human]
name = "Alex"
legacy_message_kind = "alex"

[paths]
repos = "repos"

[repos.web]
remote = "acme/web"
gate_checks = ["test"]

[repos.api]
remote = "acme/api"

[stacks.app]
repos = ["web", "api"]
slots = 2
reserve = [0]
pin = { bea = 1 }

[roles.lead]
cwd = "lead"
model = "opus"
effort = "high"
autocompact = "1M"
permission_mode = "bypassPermissions"
settings = "lead"
extra_hooks = ["status"]

[roles.builder]
model = "opus"
effort = "high"
autocompact = "1M"
permission_mode = "bypassPermissions"
settings = "builder"
mcp_config = "settings/mcp.json"

[roles.reviewer]
cwd = "reviewers"
model = "opus"
effort = "high"
autocompact = "1M"
permission_mode = "auto"
settings = "readonly"
add_dirs = ["web", "api"]

[[agents]]
name = "ada"
role = "lead"
remote_control = true

[[agents]]
name = "bea"
role = "builder"
stack = "app"
appendix = ["briefs/app.md", "repo:AGENTS.md"]
add_dirs = ["web", "api"]
remote_control = true

[[agents]]
name = "cal"
role = "builder"
repos = ["api"]
appendix = ["briefs/app.md"]
remote_control = true

[[agents]]
name = "rae"
role = "reviewer"
remote_control = true

[tracker]
kind = "jira"
key_pattern = '^[A-Z][A-Z0-9]+-\\d+$'

[tracker.status]
queued = "To Do"
building = "In Progress"
colleague-review = "In Review"
done = "Done"
`;

export function tempDir(prefix = "sf-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// A workspace with its config, and a claude that lists no sessions.
export function tempWorkspace(toml = TOML): string {
  const dir = tempDir();
  writeFileSync(join(dir, "factory.toml"), toml);
  mkdirSync(join(dir, "bin"));
  const claude = join(dir, "bin", "claude");
  writeFileSync(claude, "#!/bin/sh\n[ \"$1\" = agents ] && echo '[]' && exit 0\nexit 1\n");
  chmodSync(claude, 0o755);
  return dir;
}

export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

export function factory(ws: string | undefined, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; cli?: string } = {}): Ran {
  const env: NodeJS.ProcessEnv = { ...process.env, SF_NOTIFY: "0", ...opts.env };
  delete env.FACTORY_WORKSPACE;
  if (opts.env?.FACTORY_WORKSPACE) env.FACTORY_WORKSPACE = opts.env.FACTORY_WORKSPACE;
  if (ws) env.CLAUDE_BIN = join(ws, "bin", "claude");
  const r = spawnSync(process.execPath, [opts.cli ?? CLI, ...(ws ? ["--workspace", ws] : []), ...args], {
    encoding: "utf8", cwd: opts.cwd ?? tmpdir(), env,
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}
