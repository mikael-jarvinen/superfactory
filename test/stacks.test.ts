import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { stacksFile } from "../src/board/server.js";
import { loadRec, saveRec, transition } from "../src/state.js";
import { alive } from "../src/stacks/process.js";
import { run } from "../src/util.js";
import { ensureWorktree, git } from "../src/worktree.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { CLI, factory, tempWorkspace } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../../test/fixtures/stack.sh", import.meta.url));

const TOML = `
[human]
name = "Alex"

[paths]
repos = "repos"

[repos.web]
remote = "acme/web"

[repos.api]
remote = "acme/api"

[stacks.app]
repos = ["web", "api"]
slots = 2
reserve = [0]
pin = { bea = 1, dan = 2 }
script = "${SCRIPT}"

[stacks.solo]
repos = ["web"]
slots = 2
reserve = [0]
script = "${SCRIPT}"

[roles.lead]
cwd = "lead"
settings = "lead"

[roles.builder]
settings = "builder"

[[agents]]
name = "ada"
role = "lead"

[[agents]]
name = "bea"
role = "builder"
stack = "app"

[[agents]]
name = "dan"
role = "builder"
stack = "app"

[[agents]]
name = "eve"
role = "builder"
stack = "solo"

[[agents]]
name = "fay"
role = "builder"
stack = "solo"

[tracker]
kind = "none"
key_pattern = '^[A-Z]+-\\d+$'
`;

const must = (dir: string, ...args: string[]) => {
  const r = git(dir, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// A workspace whose repos are real clones of local origins, so worktrees and fetches are real.
function setup(): { dir: string; ws: Workspace; wt: (repo: string, ticket: string, agent: string) => string } {
  const dir = tempWorkspace(TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  for (const r of ["web", "api"]) {
    const origin = join(dir, "origins", `${r}.git`);
    const clone = join(dir, "repos", r);
    mkdirSync(join(dir, "origins"), { recursive: true });
    must(dir, "init", "-q", "--bare", "-b", "main", origin);
    must(dir, "clone", "-q", origin, clone);
    must(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
    must(clone, "push", "-q", "origin", "HEAD:main");
  }
  const ws = openWorkspace(dir);
  const wt = (repo: string, ticket: string, agent: string) => {
    if (!loadRec(ws, ticket)) transition(ws, ticket, "building", { agent }, () => {});
    return ensureWorktree(join(dir, "repos", repo), ticket, "main").wt;
  };
  return { dir, ws, wt };
}

// The verbs that change a slot, in the order the script saw them; url, status and doctor are reads.
function calls(dir: string): string[] {
  const f = join(dir, "calls.log");
  const lines = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => /^(up|down|destroy) /.test(l)) : [];
  rmSync(f, { force: true });
  return lines;
}

function ok(r: { status: number; stdout: string; stderr: string }, what: string): string {
  assert.equal(r.status, 0, `${what}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

test("stack placement across repos, and the hand-back when an item changes slot", () => {
  const { dir, ws, wt } = setup();
  const up = (cwd: string, ...args: string[]) => factory(dir, ["stack", "up", ...args], { cwd });

  // dan's item in one repo: its pinned slot, with the stack's own worktree in the other repo's place
  const web2 = wt("web", "APP-2", "dan");
  assert.match(ok(up(web2), "first up"), /app slot 2 \(pinned\): web=APP-2 api=app-s2\n[\s\S]*app slot 2 up: http:\/\/app-2\.test/);
  assert.deepEqual(calls(dir), ["up app 2 web=APP-2 api=app-s2"]);
  const own = join(dir, "repos", "api", ".claude", "worktrees", "app-s2");
  assert.equal(must(own, "rev-parse", "HEAD"), must(join(dir, "repos", "api"), "rev-parse", "origin/main"));
  assert.equal(git(own, "symbolic-ref", "-q", "HEAD").status, 1, "the stack's own worktree is detached");
  const env = readFileSync(join(ws.stateDir, "stacks", "app", "2", "env.up"), "utf8");
  assert.match(env, new RegExp(`^FACTORY_CHECKOUT_API=${join(dir, "repos", "api")}$`, "m"));
  assert.match(env, new RegExp(`^FACTORY_LOG_DIR=${join(dir, "logs", "stacks", "app", "2")}$`, "m"));
  assert.match(env, /^FACTORY_STACK=app$/m);

  // the same item's worktree in the other repo, found by its name, takes the place over
  const api2 = wt("api", "APP-2", "dan");
  assert.match(ok(up(api2), "second repo"), /app slot 2 \(its slot\): web=APP-2 api=APP-2/);
  assert.deepEqual(calls(dir), ["down app 2 web=APP-2 api=app-s2", "up app 2 web=APP-2 api=APP-2"]);

  // Handed to bea: dan's pinned slot is no longer the item's, so it moves to bea's, and slot 2 gets
  // its own worktrees back and comes up on them before the item comes up in slot 1.
  saveRec(ws, { ...loadRec(ws, "APP-2")!, agent: "bea" });
  assert.match(ok(up(web2), "reassigned"), /app slot 1 \(pinned\): web=APP-2 api=APP-2/);
  assert.deepEqual(calls(dir), [
    "down app 2 web=APP-2 api=APP-2",
    "up app 2 web=app-s2 api=app-s2",
    "up app 1 web=APP-2 api=APP-2",
  ]);
  const reg = JSON.parse(readFileSync(join(ws.stateDir, "stacks", "app.json"), "utf8"));
  assert.deepEqual(Object.keys(reg.slots).sort(), ["1", "2"]);
  assert.equal(reg.slots["1"].worktrees.api, api2);

  // the guards: another builder's pinned slot, a worktree no record names, the reserved slot, the
  // human's checkout, and another builder's slot for destroy
  const web3 = wt("web", "APP-3", "dan");
  assert.match(up(web3, "--slot", "1").stderr, /slot 1 is pinned to bea/);
  const stray = ensureWorktree(join(dir, "repos", "web"), "APP-9", "main").wt;
  assert.match(up(stray).stderr, /is no builder's: state\/APP-9\.json is missing/);
  assert.match(up(dir, "--stack", "app", "--slot", "0").stderr, /slot 0 is reserved: it is Alex's own/);
  assert.match(up(join(dir, "repos", "web")).stderr, /is Alex's checkout/);
  assert.match(factory(dir, ["stack", "destroy", "--slot", "1"], { cwd: web3 }).stderr, /slot 1 holds APP-2, bea's, not dan's/);
  assert.deepEqual(calls(dir), []);

  // the board's export: every slot, a site per row, a site named after a repo showing its worktree
  const rows = readFileSync(stacksFile(ws), "utf8").trimEnd().split("\n").map((l) => l.split("\t"));
  assert.ok(rows.every((r) => r.length === 6));
  const row = (stack: string, slot: string, name: string) => rows.find((r) => r[0] === stack && r[1] === slot && r[2] === name);
  assert.deepEqual(row("app", "1", "api"), ["app", "1", "api", api2, "http://api.app-1.test", "http://api.app-1.test"]);
  assert.deepEqual(row("app", "1", "web"), ["app", "1", "web", web2, "http://web.app-1.test", "http://web.app-1.test/up"]);
  assert.equal(row("app", "0", "web")?.[3], join(dir, "repos", "web"), "the reserved slot shows the human's checkout");
  assert.equal(row("solo", "1", "web")?.[3], "-", "a free slot has no worktree");

  const doc = factory(dir, ["stack", "doctor", "--stack", "app"]);
  assert.equal(doc.status, 1);
  assert.equal(doc.stdout, "app: ok container runtime\napp: MISSING web.app-2.test resolving [fix: add it to /etc/hosts]\n",
    "a check that reads the same for every slot is printed once");
});

// The order: its own slot, then free, then vanished (reclaimed by destroy), then the stack's own.
test("allocation order, reclaiming a removed worktree, and taking over the stack's own slot", () => {
  const { dir, wt } = setup();
  const up = (cwd: string, ...args: string[]) => factory(dir, ["stack", "up", ...args], { cwd });
  const removed = wt("web", "A-1", "eve");
  ok(up(removed), "A-1");
  assert.match(ok(up(removed), "A-1 again"), /solo slot 1 \(its slot\)/);
  assert.deepEqual(calls(dir), ["up solo 1 web=A-1 api=-", "up solo 1 web=A-1 api=-"], "an unchanged slot is not taken down first");

  must(join(dir, "repos", "web"), "worktree", "remove", "--force", removed);
  assert.match(ok(up(wt("web", "A-2", "fay")), "A-2"), /solo slot 2 \(free\)/, "a free slot before a vanished one");
  const a3 = wt("web", "A-3", "eve");
  // what follows -- goes to the up asked for, word by word, and not to the reclaim the engine runs first
  assert.match(ok(up(a3, "--", "--rebuild", "two words"), "A-3"), /solo slot 1 \(reclaimed\)/);
  assert.match(up(wt("web", "A-4", "fay")).stderr, /every slot of solo open to fay is taken/);
  assert.deepEqual(calls(dir), ["up solo 2 web=A-2 api=-", "destroy solo 1 web=A-1 api=-", "up solo 1 web=A-3 api=- args=--rebuild|two words"]);

  ok(factory(dir, ["stack", "destroy", "--stack", "solo", "--slot", "2"]), "destroy");
  assert.match(ok(up(dir, "--stack", "solo", "--slot", "2"), "the base branch"), /solo slot 2 \(asked for\): web=solo-s2/);
  assert.match(ok(up(join(dir, "repos", "web", ".claude", "worktrees", "A-4")), "A-4"), /solo slot 2 \(taken over from the stack's own worktrees\)/);
  assert.deepEqual(calls(dir), [
    "destroy solo 2 web=A-2 api=-",
    "up solo 2 web=solo-s2 api=-",
    "down solo 2 web=solo-s2 api=-",
    "up solo 2 web=A-4 api=-",
  ]);
  assert.match(ok(factory(dir, ["stack", "status", "--stack", "solo"]), "status"), /slot 1 {2}A-3, eve's {2}web=A-3\n {4}web\s+http:\/\/web\.solo-1\.test/);
});

// Boot runs async, so the factory is run without blocking the server the slots are probed on.
test("boot: up only for the slots that do not answer, the reserved one included, once Docker answers", async () => {
  const { dir, ws, wt } = setup();
  ok(factory(dir, ["stack", "up"], { cwd: wt("web", "APP-2", "dan") }), "place app slot 2");
  calls(dir);
  const server = createHttpServer((_, res) => res.end("ok")).listen(0, "127.0.0.1");
  after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const live = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const dead = `http://127.0.0.1:${await freePort()}/`;
  const health = (stack: string, slot: number, url: string) => {
    mkdirSync(join(ws.stateDir, "stacks", stack, String(slot)), { recursive: true });
    writeFileSync(join(ws.stateDir, "stacks", stack, String(slot), "health"), url);
  };
  health("app", 0, dead);
  health("app", 2, live);
  health("solo", 0, live);
  const docker = join(dir, "bin", "docker");
  writeFileSync(docker, `#!/bin/sh\n[ -f "${dir}/docker-up" ]\n`);
  chmodSync(docker, 0o755);
  const boot = (...args: string[]) => new Promise<{ status: number; stdout: string }>((resolve) =>
    execFile(process.execPath, [CLI, "--workspace", dir, "stack", "boot", ...args], { env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } },
      (e, stdout) => resolve({ status: e ? Number(e.code ?? 1) : 0, stdout })));

  const early = await boot("--wait", "0");
  assert.equal(early.status, 1);
  assert.match(early.stdout, /Docker did not answer within 0 s; no stack was checked/);
  assert.deepEqual(calls(dir), []);

  writeFileSync(join(dir, "docker-up"), "");
  const r = await boot();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /app slot 0: web, api not answering; bringing it up on web=web api=api/);
  assert.match(r.stdout, /app slot 1: free; nothing to bring up/);
  assert.match(r.stdout, /app slot 2: answers \(web, api\)/);
  assert.deepEqual(calls(dir), ["up app 0 web=web api=api"], "only the slot that did not answer, on the human's checkouts");

  writeFileSync(join(ws.logsDir, "stacks", "boot.lock"), `${process.pid}\n`);
  assert.match((await boot()).stdout, new RegExp(`another boot is running, pid ${process.pid}`));
  assert.deepEqual(calls(dir), []);
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function eventually(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !ok();) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// A server whose child would outlive it if only the pid were killed, run the way a stack script
// runs its dev servers.
test("run-detached: its own session, the whole tree stopped, the port released", async () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const server = join(dir, "server.mjs");
  writeFileSync(server, `
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[3], String(child.pid));
createServer((_, res) => res.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");
`);
  const pidFile = join(dir, "logs", "web.pid");
  const start = (childFile: string) => ok(factory(dir, ["stack", "run-detached", "--pid-file", pidFile, "--log", join(dir, "logs", "web.log"),
    "--port", String(port), "--", process.execPath, server, String(port), childFile]), "run-detached");
  const pids = () => [Number(readFileSync(pidFile, "utf8")), Number(readFileSync(join(dir, "child"), "utf8"))] as const;

  start(join(dir, "child"));
  ok(factory(dir, ["stack", "wait-http", `http://127.0.0.1:${port}/`, "--timeout", "20"]), "wait-http");
  const [first, firstChild] = pids();
  assert.equal(run("ps", ["-o", "pgid=", "-p", String(first)]).stdout.trim(), String(first), "the server leads its own group");

  // starting again replaces the old tree, and waits for the port before the new server binds it
  start(join(dir, "child"));
  ok(factory(dir, ["stack", "wait-http", `http://127.0.0.1:${port}/`, "--timeout", "20"]), "wait-http after a restart");
  assert.ok(!alive(first) && !alive(firstChild), "the old server and its child are gone");
  await eventually("the new child's pid", () => pids()[1] !== firstChild);
  const [second, secondChild] = pids();

  assert.match(ok(factory(dir, ["stack", "run-detached", "--stop", "--pid-file", pidFile, "--port", String(port)]), "stop"), /stopped \d+ and its children/);
  assert.ok(!alive(second) && !alive(secondChild));
  assert.ok(!existsSync(pidFile));
  const late = factory(dir, ["stack", "wait-http", `http://127.0.0.1:${port}/`, "--timeout", "1"]);
  assert.equal(late.status, 1);
  assert.match(late.stderr, /did not answer below 400 within 1 s/);
});
