import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownCgroupProcs } from "../src/scheduler/leftovers.js";
import { procStat } from "../src/stacks/process.js";

// On Linux every claude call goes through systemd-run --user --scope. No test may open a real scope
// or depend on this box's user bus, so every test file that imports this one runs with a
// systemd-run first on PATH that runs what follows "--" in place. A test that wants systemd-run to
// fail puts its own fake in front of this one. What no fake can show: that a call really lands in a
// cgroup under agents.slice, that a timeout's kill reaches claude through systemd-run's exec, or
// that --collect removes the scope. A detached child that outlives its test file finds this fake
// removed, and reaches the next systemd-run on PATH.
export const PASS_THROUGH_SYSTEMD_RUN = '#!/bin/sh\nwhile [ "$1" != "--" ]; do [ $# -gt 0 ] || exit 2; shift; done\nshift\nexec "$@"\n';
const fakeBin = realpathSync(mkdtempSync(join(tmpdir(), "sf-systemd-run-")));
writeFileSync(join(fakeBin, "systemd-run"), PASS_THROUGH_SYSTEMD_RUN);
chmodSync(join(fakeBin, "systemd-run"), 0o755);
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ""}`;
process.on("exit", () => rmSync(fakeBin, { recursive: true, force: true }));

// Nor may a test read this box's claude: its config dir (transcripts, the daemon's roster) or the
// daemon's sockets. Every test file gets a claude daemon of its own that is up: a roster naming the
// test process, which outlives every factory it runs, and one control socket. A test that sets its
// own CLAUDE_CONFIG_DIR gives it the roster with fakeDaemon.
export function fakeDaemon(configDir: string, pid = process.pid): void {
  mkdirSync(join(configDir, "daemon"), { recursive: true });
  writeFileSync(join(configDir, "daemon", "roster.json"), JSON.stringify({ supervisorPid: pid }));
}
const fakeClaude = realpathSync(mkdtempSync(join(tmpdir(), "sf-claude-")));
fakeDaemon(join(fakeClaude, "config"));
mkdirSync(join(fakeClaude, "sockets", "d1"), { recursive: true });
writeFileSync(join(fakeClaude, "sockets", "d1", "control.sock"), "");
process.env.CLAUDE_CONFIG_DIR = join(fakeClaude, "config");
process.env.SF_CC_DAEMON_DIR = join(fakeClaude, "sockets");
process.on("exit", () => rmSync(fakeClaude, { recursive: true, force: true }));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(what: string, fn: () => unknown, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (fn()) return;
  assert.fail(`timed out waiting for ${what}`);
}

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

// Every temp dir a test file makes is removed when its process exits, whether or not the test
// removed it: node --test runs each file in its own process, and a dir a test forgot stayed in /tmp.
const made: string[] = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
export function tempDir(prefix = "sf-test-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
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

export function factory(ws: string | undefined, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; cli?: string; input?: string } = {}): Ran {
  const env: NodeJS.ProcessEnv = { ...process.env, SF_NOTIFY: "0", ...opts.env };
  delete env.FACTORY_WORKSPACE;
  if (opts.env?.FACTORY_WORKSPACE) env.FACTORY_WORKSPACE = opts.env.FACTORY_WORKSPACE;
  if (ws) env.CLAUDE_BIN = join(ws, "bin", "claude");
  const r = spawnSync(process.execPath, [opts.cli ?? CLI, ...(ws ? ["--workspace", ws] : []), ...args], {
    encoding: "utf8", cwd: opts.cwd ?? tmpdir(), env, ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export const runningNotZombie = (pid: number): boolean => {
  const st = procStat(pid);
  return !!st && st.state !== "Z";
};

// Why a test that reads /proc cannot run here, or false.
export const linuxOnly: string | false = process.platform !== "linux" && "Linux only: reads /proc";

// Why a test of leftover cleanup cannot run here, or false: it needs Linux and a cgroup v2 this
// process can list its cgroup from, as the scheduler does.
export function noCleanup(): string | false {
  if (linuxOnly) return linuxOnly;
  const own = ownCgroupProcs();
  return "none" in own && `needs cgroup v2 for the scheduler's own cgroup (${own.none})`;
}

// Two assistants and the two builders, grouped; rae stays in the role's own roster.
export const GROUPED = TOML.replace("[tracker]", `[[agents]]
name = "otto"
role = "assistant"
group = " Servers "

[[agents]]
name = "nap"
role = "assistant"

[roles.assistant]
cwd = "assistants"
model = "opus"
permission_mode = "auto"
settings = "readonly"

[tracker]`).replace(`name = "bea"
role = "builder"`, `name = "bea"
role = "builder"
group = "Product"`).replace(`name = "cal"
role = "builder"`, `name = "cal"
role = "builder"
group = "Product"`);
