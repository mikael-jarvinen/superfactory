import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { run } from "../src/util.js";
import { factory, tempWorkspace } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../../test/fixtures/stack.sh", import.meta.url));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const exe = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

// The fakes answer as a logged-in machine would. gh reads acme/web and nothing else, so a repo
// config adds is a repo doctor asks about. launchctl lists whatever is installed under $HOME.
function workspace(toml: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tempWorkspace(toml);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  exe(join(bin, "claude"), `case "$1" in agents) echo '[]' ;; auth) echo '{"loggedIn": true}' ;; *) exit 1 ;; esac`);
  exe(join(bin, "gh"), `case "$1" in --version|auth) echo gh ;; api) [ "$2" = repos/acme/web ] || exit 1; echo acme/web ;; *) exit 1 ;; esac`);
  exe(join(bin, "ffmpeg"), `echo " V....D libx264"`);
  exe(join(bin, "launchctl"), `[ "$1" = list ] || exit 1\nfor f in "$HOME"/Library/LaunchAgents/*.plist; do [ -f "$f" ] && printf '1\\t0\\t%s\\n' "$(basename "$f" .plist)"; done; exit 0`);
  const home = join(dir, "home");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, GH_BIN: join(bin, "gh"), LAUNCHCTL_BIN: join(bin, "launchctl") };

  mkdirSync(join(dir, "lead"));
  writeFileSync(join(dir, "lead", "CLAUDE.md"), "You lead.\n");
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "round.md"), "Judge the facts.\n");
  writeFileSync(join(dir, "prompts", "relay.md"), "Carry {text}.\n");
  const web = join(dir, "repos", "web");
  mkdirSync(web, { recursive: true });
  assert.equal(run("git", ["init", "-q", web]).status, 0);
  assert.equal(run("git", ["-C", web, "remote", "add", "origin", "https://github.com/acme/web.git"]).status, 0);
  return { dir, env };
}

const base = (port: number) => `
[human]
name = "Alex"

[paths]
repos = "repos"

[repos.web]
remote = "acme/web"

[roles.lead]
cwd = "lead"
settings = "lead"

[[agents]]
name = "ada"
role = "lead"

[board]
host = "127.0.0.1"
port = ${port}
`;

// What config does not ask for is not checked, and what it adds is: a tracker adds the queue
// watcher's prompt and job, a stack its script and the script's own doctor, a repo its checkout and
// GitHub access, an appendix its file, demo.env the demo tools.
test("doctor checks exactly what config needs", async () => {
  const bare = workspace(base(await freePort()));
  // Installed as config renders them, so the scheduler reads as done.
  assert.equal(factory(bare.dir, ["schedule", "render"], { env: bare.env }).status, 0);
  const rendered = join(bare.dir, "logs", "run", "launchd");
  for (const f of readdirSync(rendered)) copyFileSync(join(rendered, f), join(bare.env.HOME as string, "Library", "LaunchAgents", f));

  const a = factory(bare.dir, ["doctor"], { env: bare.env });
  const lines = a.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.filter((l) => !l.startsWith("ok ")), [], a.stdout + a.stderr);
  assert.equal(a.status, 0);
  assert.ok(lines.includes("ok gh can read acme/web (repos.web)"));
  assert.ok(lines.some((l) => /^ok .*repos\/web is a checkout of acme\/web \(repos\.web\)$/.test(l)));
  assert.ok(lines.includes("ok lead/CLAUDE.md, the lead's instructions (roles.lead.cwd)"));
  assert.ok(lines.some((l) => l.startsWith("ok board port 127.0.0.1:")));
  for (const absent of ["queue", "ffmpeg", "playwright", "stacks/", "appended", "reviewers"])
    assert.ok(!lines.some((l) => l.toLowerCase().includes(absent)), `${absent} is not asked about: ${a.stdout}`);

  const full = workspace(base(await freePort()).replace("[roles.lead]", () => `[repos.api]
remote = "acme/api"

[stacks.app]
repos = ["web", "api"]
slots = 2
reserve = [0]
script = "${SCRIPT}"

[roles.builder]
settings = "builder"

[roles.reviewer]
cwd = "reviewers"
settings = "readonly"

[[agents]]
name = "bea"
role = "builder"
stack = "app"
appendix = ["briefs/app.md", "repo:AGENTS.md"]

[[agents]]
name = "rae"
role = "reviewer"

[tracker]
kind = "jira"
key_pattern = '^[A-Z]+-\\d+$'

[tracker.status]
queued = "To Do"
building = "In Progress"
colleague-review = "In Review"
done = "Done"

[roles.lead]`));
  writeFileSync(join(full.dir, "demo.env"), "DEMO_BASE_URL=http://localhost\n");
  const b = factory(full.dir, ["doctor"], { env: full.env });
  const got = b.stdout.trimEnd().split("\n");
  assert.equal(b.status, 1, b.stderr);
  const has = (re: RegExp) => assert.ok(got.some((l) => re.test(l)), `${re} in:\n${b.stdout}${b.stderr}`);
  has(/^MISSING gh can read acme\/api \(repos\.api\) \[fix: /);
  has(/^MISSING .*repos\/api is a checkout of acme\/api/);
  has(/^MISSING reviewers\/CLAUDE\.md, the reviewers' instructions/);
  has(/^MISSING briefs\/app\.md, appended for bea \[fix: /);
  has(/^MISSING .*repos\/web\/AGENTS\.md, appended for bea/);
  assert.ok(!got.some((l) => l.includes("repos/api/AGENTS.md")), "a checkout that is not there has one line, its own");
  has(/^MISSING prompts\/queue\.md, the queue watcher's prompt/);
  has(/^ok ffmpeg with libx264, which factory demo encodes with \(the workspace has demo\.env\)$/);
  has(/playwright\/test/);
  has(/executable \(stacks\.app\.script\)$/);
  has(/^app: ok container runtime$/);
  has(/^app: MISSING web\.app-2\.test resolving/);
  if (process.platform === "darwin") has(/^MISSING launchd job superfactory\.ada\.queue installed \[fix: factory schedule install\]$/);
});
