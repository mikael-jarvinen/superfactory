// The remote transport against a fake factory daemon, and what a host that cannot be asked looks
// like in config, `sessions --fleet`, the doctor and the board.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { serve } from "../src/board/server.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { checkouts, hostChecks, line, workspaceFiles } from "../src/doctor.js";
import { launch, roleOf, settingsFile } from "../src/launch.js";
import { builderLeft, fleetLines, type Session, stopWorktree, waitForName, worktreeOf } from "../src/fleet.js";
import { serveCheckout, serveWorktree, Unreachable } from "../src/remote.js";
import { loadRec, saveRec } from "../src/state.js";
import { local, type Transport, transportFor } from "../src/transport.js";
import { openWorkspace } from "../src/workspace.js";
import { FactoryError } from "../src/util.js";
import { worktreePath } from "../src/worktree.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

const withHost = (url: string, extra = "") =>
  TOML.replace(`name = "rae"
role = "reviewer"`, `name = "rae"
role = "reviewer"
host = "far"
cwd = "/far/rae"`) + `
[hosts.far]
url = "${url}"
token_file = "token"
hash_files = ["daemon.toml", "workspace.toml"]
${extra}`;

// cal, a builder, on far with its one repo checked out there; web stays here, alone in bea's stack.
const hostedCal = (url: string) =>
  withHost(url)
    .replace(`[repos.api]
remote = "acme/api"`, `[repos.api]
remote = "acme/api"
host = "far"
path = "/far/api"`)
    .replace('repos = ["web", "api"]', 'repos = ["web"]')
    .replace(`stack = "app"
appendix = ["briefs/app.md", "repo:AGENTS.md"]
add_dirs = ["web", "api"]`, `stack = "app"
appendix = ["briefs/app.md", "repo:AGENTS.md"]
add_dirs = ["web"]`)
    .replace(`name = "cal"
role = "builder"`, `name = "cal"
role = "builder"
host = "far"`);

const TOKEN = "t".repeat(40);

// The daemon runs in its own process: the CLI's requests are synchronous and would block one
// served from this process. Each request it gets is a line in requests.jsonl.
const FAKE = `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const { TOKEN, HASH, LOG, CLEAN } = process.env;
const sessions = [
  { id: "r1", name: "rae", kind: "background", state: "idle", status: "idle", alive: true },
  { id: "r0", name: "rae", kind: "background", state: "idle", alive: false }, // a stale record: its supervisor is gone,
];
let lefts = CLEAN ? 2 : 0; // the first look at cal's worktree cannot read it, the second finds an uncommitted file, later ones nothing
createServer((req, res) => {
  let body = "";
  req.on("data", (b) => (body += b));
  req.on("end", () => {
    appendFileSync(LOG, JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null }) + "\\n");
    const send = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.headers.authorization !== "Bearer " + TOKEN) return send(401, { error: "bad token" });
    if (req.headers["x-factory-hash"] !== HASH) return send(409, { error: "config drift", hash: HASH });
    if (req.method === "GET" && req.url.startsWith("/agents")) return send(200, { sessions });
    if (req.url === "/agents/rae/start") return send(200, { id: "launched1" });
    const id = body ? JSON.parse(body).id : null;
    if (id === "r422") return send(422, { error: "not that one" }); // a session route: a 422 here is no refusal
    if (req.url === "/agents/rae/stop" || req.url === "/agents/rae/deliver") return send(200, {});
    const q = body ? JSON.parse(body) : {};
    const wt = "/far/" + q.repo + "/.claude/worktrees/" + q.ticket;
    if (req.url === "/agents/cal/start") {
      sessions.push({ id: "c1", name: "cal", kind: "background", state: "busy", alive: true, cwd: q.cwd });
      return send(200, { id: "c1" });
    }
    if (req.url === "/agents/cal/stop") {
      for (const s of sessions) if (s.name === "cal") s.alive = false;
      return send(200, {});
    }
    if (req.url === "/agents/cal/worktree") return q.ticket === "TEST-7" ? send(422, { error: wt + " is in the way" }) : send(200, { wt, how: "made " + wt });
    if (q.ticket === "TEST-7" && req.url.startsWith("/agents/cal/worktree/")) return send(422, { error: wt + " is in the way" });
    if (req.url === "/repos/gone/checkout") return send(422, { error: "not a refusal" });
    if (req.url === "/agents/cal/worktree/left") return send(200, [{ exists: true, dirty: [], unreadable: "git status exited 128: fatal: x", pushed: false }, { exists: true, dirty: ["src/x.ts"], pushed: true }][lefts++] ?? { exists: true, dirty: [], pushed: true });
    if (req.url === "/agents/cal/worktree/remove") return send(200, { ok: true, said: "" });
    if (req.url === "/repos/api/checkout") return send(200, { top: "/far/api", origin: "https://github.com/acme/api.git" });
    send(404, { error: "no such route" });
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;

async function fakeDaemon(dir: string, hash: string, clean = false): Promise<{ url: string; proc: ChildProcess; requests: () => { method: string; url: string; body: Record<string, unknown> | null }[] }> {
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const proc = spawn(process.execPath, ["--input-type=module", "-e", FAKE], { env: { ...process.env, TOKEN, HASH: hash, LOG: log, ...(clean ? { CLEAN: "1" } : {}) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((res, rej) => {
    proc.stdout?.once("data", (b) => res(String(b).trim()));
    proc.once("exit", (c) => rej(new Error(`fake daemon exited ${c}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    proc,
    requests: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

// A port nothing listens on.
const closedPort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

function workspace(toml: string) {
  const dir = tempWorkspace(toml);
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), TOKEN + "\n");
  writeFileSync(join(dir, "daemon.toml"), "[daemon]\nport = 8787\n");
  writeFileSync(join(dir, "workspace.toml"), "[human]\nname = \"Alex\"\n");
  process.env.CLAUDE_BIN = join(dir, "bin", "claude");
  return dir;
}
// the daemon's side: its files' bytes one after another, in the order hash_files names them
const sha = (...ps: string[]) => ps.reduce((h, p) => h.update(readFileSync(p)), createHash("sha256")).digest("hex");

const problems = (toml: string): string[] => {
  const dir = tempWorkspace(toml);
  try {
    loadConfig(join(dir, "factory.toml"), {});
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a host: url and hash_files wanted, named by an agent that is not a builder", () => {
  assert.deepEqual(problems(withHost("http://192.168.1.184:8787")), []);
  assert.deepEqual(problems(withHost("192.168.1.184:8787").replace('hash_files = ["daemon.toml", "workspace.toml"]\n', "")), [
    'hosts.far.url: must be http(s)://host:port, got "192.168.1.184:8787"',
    "hosts.far.hash_files: missing",
  ]);
  assert.deepEqual(problems(withHost("http://x:1").replace('["daemon.toml", "workspace.toml"]', "[]")), ["hosts.far.hash_files: must name two files, the daemon's config then the workspace config, got 0"]);
  assert.deepEqual(problems(withHost("http://x:1").replace('["daemon.toml", "workspace.toml"]', '["daemon.toml"]')), ["hosts.far.hash_files: must name two files, the daemon's config then the workspace config, got 1"]);
  assert.deepEqual(problems(withHost("http://x:1").replace("[hosts.far]", "[hosts.local]").replace('host = "far"', 'host = "local"')), ['hosts.local: "local" names this machine\'s own sessions; give the host another name']);
  // a host agent's cwd is a path on the host: absolute as written, its own or its role's
  for (const bad of ["~/rae", "$HOME/rae", "/far/$USER", "rae"])
    assert.deepEqual(problems(withHost("http://x:1").replace('cwd = "/far/rae"', `cwd = "${bad}"`)),
      [`agents[3].cwd: rae runs on host far, so its cwd must be an absolute path there, with no ~ or $, got "${bad}"`]);
  assert.deepEqual(problems(withHost("http://x:1").replace('cwd = "/far/rae"\n', "")),
    ['agents[3].host: rae runs on host far, so roles.reviewer.cwd must be an absolute path there, with no ~ or $, got "reviewers"']);
  assert.deepEqual(problems(withHost("http://x:1").replace('cwd = "/far/rae"\n', "").replace('cwd = "reviewers"', 'cwd = "/srv/reviewers"')), []);
  assert.deepEqual(problems(withHost("http://x:1").replace('host = "far"', 'host = "near"')), ['agents[3].host: no host "near"; hosts: far']);
  assert.deepEqual(problems(withHost("http://x:1").replace(`name = "cal"
role = "builder"`, `name = "cal"
role = "builder"
host = "far"`)), [
    "agents[2].host: repo api lives on this machine, and a builder runs where its worktrees are, so cal needs no host",
  ]);
});

test("a host's git_over: https unless it says ssh, and its repos follow it", () => {
  const load = (toml: string) => {
    const dir = tempWorkspace(toml);
    try {
      return loadConfig(join(dir, "factory.toml"), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const https = load(hostedCal("http://x:1"));
  assert.equal(https.hosts.far!.gitOver, "https");
  assert.equal(https.repos.api!.gitOver, "https");
  const ssh = load(hostedCal("http://x:1").replace("[hosts.far]\n", '[hosts.far]\ngit_over = "ssh"\n'));
  assert.equal(ssh.hosts.far!.gitOver, "ssh");
  assert.equal(ssh.repos.api!.gitOver, "ssh", "a repo on far goes the way far does");
  assert.equal(ssh.repos.web!.gitOver, "https", "a repo here is still over https");
  assert.deepEqual(problems(withHost("http://x:1").replace("[hosts.far]\n", '[hosts.far]\ngit_over = "git"\n')),
    ['hosts.far.git_over: must be one of https, ssh, got "git"']);
});

test("the remote transport: each operation is a request to the host's daemon", async () => {
  const dir = workspace(withHost("http://placeholder:1"));
  const d = await fakeDaemon(dir, sha(join(dir, "daemon.toml"), join(dir, "workspace.toml")));
  after(() => d.proc.kill());
  writeFileSync(join(dir, "factory.toml"), withHost(d.url));
  const ws = openWorkspace(dir);
  const rae = ws.config.agents.find((a) => a.name === "rae")!;
  const t = transportFor(ws, rae);
  assert.notEqual(t, local);
  assert.equal(t, transportFor(ws, rae), "one transport per host");
  assert.equal(transportFor(ws, ws.config.agents.find((a) => a.name === "ada")!), local);

  const rows = t.sessions(true);
  assert.deepEqual(rows.map((s) => [s.id, t.alive(s)]), [["r1", true], ["r0", false]], "alive is the daemon's word");
  const id = t.start({ agent: rae, cwd: "/far/rae", prompt: "hello", appendix: "the appendix", runDir: ws.runDir, phase: undefined, args: () => assert.fail("rendered on the host, not here"), env: { SECRET: "x" } });
  assert.equal(id, "launched1");
  t.stop("rae", "r1", true);
  t.deliver("rae", rows[0]!, "Message from ada:\n\nhi", "ada");
  assert.deepEqual(d.requests().map((r) => [r.method, r.url, r.body]), [
    ["GET", "/agents?all=1", null],
    ["POST", "/agents/rae/start", { cwd: "/far/rae", prompt: "hello", appendix: "the appendix", phase: null }],
    ["POST", "/agents/rae/stop", { id: "r1", remove: true }],
    ["POST", "/agents/rae/deliver", { id: "r1", text: "Message from ada:\n\nhi", from: "ada" }],
  ]);
  // a 422 on a session route is an unknown host: stop throws Unreachable
  assert.throws(() => t.stop("rae", "r422", false), (e: unknown) => e instanceof Unreachable && /HTTP 422 not that one/.test(e.message));
  assert.deepEqual(await t.sessionsAsync().then((r) => (Array.isArray(r) ? r.map((s) => s.id) : r.why)), ["r1", "r0"]);
  assert.deepEqual(hostChecks(ws), [{ status: "ok", what: `host far at ${d.url} answers, for rae` }]);

  // a pulled config the daemon does not have, in either file, and a token it does not take
  writeFileSync(join(dir, "daemon.toml"), "[daemon]\nport = 8788\n");
  assert.throws(() => t.sessions(), (e: unknown) => e instanceof Unreachable && /hash mismatch: the daemon's config hashes to \w{12}, \S+daemon\.toml \+ \S+workspace\.toml hash to \w{12}$/.test(e.message));
  writeFileSync(join(dir, "daemon.toml"), "[daemon]\nport = 8787\n");
  writeFileSync(join(dir, "workspace.toml"), "[human]\nname = \"Sam\"\n");
  assert.throws(() => t.sessions(), /hash mismatch/, "the workspace config counts too");
  writeFileSync(join(dir, "workspace.toml"), "[human]\nname = \"Alex\"\n");
  assert.equal(t.sessions().length, 2, "and the same files again are answered");
  writeFileSync(join(dir, "token"), "u".repeat(40));
  assert.throws(() => t.sessions(), /host far is unknown: it refused the token/);
});

test("a host that does not answer leaves its agents unknown, not stopped", { skip: !["darwin", "linux"].includes(process.platform) && "the board's inbox lock is built for macOS and Linux only" }, async () => {
  const port = await closedPort();
  const dir = workspace(withHost(`http://127.0.0.1:${port}`));
  const ws = openWorkspace(dir);
  const rae = ws.config.agents.find((a) => a.name === "rae")!;

  assert.throws(() => transportFor(ws, rae).sessions(), /host far is unknown: ECONNREFUSED/);
  const line = fleetLines(ws).lines.find((l) => l.trim().startsWith("rae")) as string;
  assert.match(line, /unknown \(host far is unknown: ECONNREFUSED\)/);
  assert.deepEqual([...fleetLines(ws).unknown], [["rae", "host far: ECONNREFUSED"]], "the reason status, the idle check and the round print");
  assert.match(fleetLines(ws).lines.find((l) => l.trim().startsWith("ada")) as string, /not running$/, "a local agent is still told");
  const [check] = hostChecks(ws);
  assert.equal(check?.status, "missing");
  assert.match(check?.what ?? "", /^host far at http:\/\/127\.0\.0\.1:\d+, for rae: unknown \(ECONNREFUSED\)$/);

  const board = await serve(ws, { host: "127.0.0.1", port: 0 });
  after(() => board.close());
  type Member = { name: string; alive: boolean; unknown: string | null };
  let member: Member | undefined;
  for (let i = 0; i < 50; i++) {
    const snap = await (await fetch(board.url + "/api")).json();
    member = snap.teams.flatMap((g: { members: Member[] }) => g.members).find((m: Member) => m.name === "rae");
    if (member?.unknown) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.deepEqual([member?.alive, member?.unknown], [false, "host far: ECONNREFUSED"]);
});

test("waiting for a started session, a host that cannot be asked on one poll is asked again", () => {
  const polls: (Session[] | Unreachable)[] = [new Unreachable("far", "ECONNREFUSED"), [{ id: "r1", name: "rae", kind: "background", alive: true }]];
  let asked = 0;
  const t: Transport = {
    where: "far",
    sessions() {
      const r = polls[asked++] ?? [];
      if (r instanceof Unreachable) throw r;
      return r;
    },
    sessionsAsync: () => assert.fail("not used"),
    alive: (s): s is Session => !!s && s.alive === true,
    start: () => "launched1",
    stop: () => assert.fail("not used"),
    deliver: () => assert.fail("not used"),
    worktree: () => assert.fail("not used"),
    worktreeLeft: () => assert.fail("not used"),
    removeWorktree: () => assert.fail("not used"),
    checkout: () => assert.fail("not used"),
  };
  assert.equal(t.start({} as Parameters<Transport["start"]>[0]), "launched1");
  assert.equal(waitForName(t, "rae", 5, 10)?.id, "r1");
  assert.equal(asked, 2);
});

test("a host agent's cwd is the host's: launching it makes nothing here, and the doctor says it did not look", async () => {
  const dir = workspace(withHost("http://placeholder:1"));
  const d = await fakeDaemon(dir, sha(join(dir, "daemon.toml"), join(dir, "workspace.toml")));
  after(() => d.proc.kill());
  const there = join(dir, "rae-there");
  // designer's template has a work_dir, which a local launch makes under the cwd
  writeFileSync(join(dir, "factory.toml"), withHost(d.url).replace('cwd = "/far/rae"', `cwd = "${there}"`).replace('settings = "readonly"', 'settings = "designer"'));
  const ws = openWorkspace(dir);
  const rae = ws.config.agents.find((a) => a.name === "rae")!;
  assert.equal(roleOf(ws, rae).cwd, there);

  assert.equal(launch(ws, rae, there, "hello").id, "r1");
  assert.equal(existsSync(there), false, "nothing made here for a session on the host");
  settingsFile(ws, rae);
  assert.equal(existsSync(join(there, "work")), true, "where a local render would have made it");

  const lines = workspaceFiles(ws).map(line).filter((l) => l.includes("rae"));
  assert.deepEqual(lines, [`NOT CHECKED ${there}/CLAUDE.md, instructions for rae: it is on host far, and the daemon there does not say`]);
});

// rae is on a host, so the brief is the start request's body. rae is already running there, so each
// command stops it first; with the brief missing it refuses before that, and rae is left running.
test("a reviewer, an assistant and a designer started on demand each get their appendix", async () => {
  const roles = `
[roles.assistant]
cwd = "assistants"
model = "opus"
permission_mode = "auto"
settings = "readonly"

[roles.designer]
cwd = "designers"
model = "opus"
permission_mode = "auto"
settings = "designer"

[tracker]`;
  const as = (url: string, role: string) =>
    withHost(url).replace('cwd = "/far/rae"', 'cwd = "/far/rae"\nappendix = ["briefs/rae.md"]').replace(`name = "rae"
role = "reviewer"`, `name = "rae"
role = "${role}"`).replace("[tracker]", roles);
  for (const [role, argv] of [["reviewer", ["review", "--force"]], ["assistant", ["assistant", "rae", "--force"]], ["designer", ["dispatch", "rae", "TEST-1"]]] as const) {
    const dir = workspace(as("http://placeholder:1", role));
    const d = await fakeDaemon(dir, sha(join(dir, "daemon.toml"), join(dir, "workspace.toml")));
    after(() => d.proc.kill());
    writeFileSync(join(dir, "factory.toml"), as(d.url, role));
    if (role === "designer") factory(dir, ["state", "TEST-1", "queued"]);
    const no = factory(dir, [...argv]);
    assert.notEqual(no.status, 0, `${role}: no brief, no start`);
    assert.match(no.stderr, /appendix file .*rae\.md is missing or empty/, role);
    assert.deepEqual(d.requests().filter((q) => q.method === "POST").map((q) => q.url), [], `${role}: nothing stopped or started`);
    mkdirSync(join(dir, "briefs"));
    writeFileSync(join(dir, "briefs", "rae.md"), "rae's brief\n");
    const r = factory(dir, [...argv]);
    assert.equal(r.status, 0, `${role}: ${r.stderr}`);
    const posts = d.requests().filter((q) => q.method === "POST");
    // the live r1 is stopped and removed, the new one started, and the ended row r0 removed once it is up
    assert.deepEqual(posts.map((q) => [q.url, q.body?.id ?? null, q.body?.remove ?? null]),
      [["/agents/rae/stop", "r1", true], ["/agents/rae/start", null, null], ["/agents/rae/stop", "r0", true]], `${role}: the live rae is replaced`);
    const start = d.requests().find((q) => q.url === "/agents/rae/start");
    assert.equal(start?.body?.appendix, "<!-- briefs/rae.md -->\nrae's brief\n", `${role}: the start carries the brief`);
  }
});

test("a builder with a host: its repos are there, absolute, in no stack, and no agent here reads them", () => {
  const cfg = (f: (t: string) => string = (t) => t) => problems(f(hostedCal("http://x:1")));
  const ships = "and a builder runs where its worktrees are";
  assert.deepEqual(cfg(), []);
  for (const bad of ["~/api", "$HOME/api", "api"])
    assert.deepEqual(cfg((t) => t.replace('path = "/far/api"', `path = "${bad}"`)),
      [`repos.api.path: api lives on host far, so give its checkout's absolute path there, with no ~ or $, got "${bad}"`]);
  assert.deepEqual(cfg((t) => t.replace('path = "/far/api"\n', "")), ["repos.api.path: api lives on host far, so give its checkout's absolute path there, with no ~ or $"]);
  assert.deepEqual(cfg((t) => t.replace('host = "far"\npath', 'host = "near"\npath')), [
    'repos.api.host: no host "near"; hosts: far',
    `agents[2].host: repo api lives on host near, ${ships}, so cal needs host = "near"`,
    "agents[3].role: repo api lives on host near, and rae runs on host far, so it cannot be an --add-dir (from roles.reviewer.add_dirs)",
  ]);
  assert.deepEqual(cfg((t) => t.replace('repos = ["web"]', 'repos = ["web", "api"]')), [
    "stacks.app.repos: repo api lives on host far, and a stack's slots and script run on this machine",
    `agents[1].stack: repo api lives on host far, ${ships}, so bea needs host = "far"`,
  ]);
  assert.deepEqual(cfg((t) => t.replace('add_dirs = ["web"]', 'add_dirs = ["web", "api"]')),
    ["agents[1].add_dirs: repo api lives on host far, and bea runs on this machine, so it cannot be an --add-dir"]);
  assert.deepEqual(cfg((t) => t.replace('appendix = ["briefs/app.md"]\nremote_control', 'appendix = ["repo:AGENTS.md"]\nremote_control')),
    ["agents[2].appendix: repo:AGENTS.md is read from the checkout on this machine, and cal's checkouts are on host far"]);
  // a builder here with its repo there
  assert.deepEqual(cfg((t) => t.replace('role = "builder"\nhost = "far"', 'role = "builder"')), [`agents[2].repos: repo api lives on host far, ${ships}, so cal needs host = "far"`]);
});

test("a builder with a host: dispatch makes its worktree there and stop looks there, by names only", async () => {
  const dir = workspace(hostedCal("http://placeholder:1"));
  const d = await fakeDaemon(dir, sha(join(dir, "daemon.toml"), join(dir, "workspace.toml")));
  after(() => d.proc.kill());
  writeFileSync(join(dir, "factory.toml"), hostedCal(d.url));
  mkdirSync(join(dir, "briefs"));
  writeFileSync(join(dir, "briefs", "app.md"), "the brief\n");
  const posts = () => d.requests().filter((q) => q.method === "POST").map((q) => [q.url, q.body]);

  // the host refuses the worktree: an error with its words, and nothing started
  let r = factory(dir, ["dispatch", "cal", "TEST-7"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /on host far: \/far\/api\/\.claude\/worktrees\/TEST-7 is in the way/);
  assert.doesNotMatch(r.stderr, /unknown/);
  assert.deepEqual(posts(), [["/agents/cal/worktree", { repo: "api", ticket: "TEST-7" }]]);

  const wt = "/far/api/.claude/worktrees/TEST-1";
  r = factory(dir, ["dispatch", "cal", "TEST-1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cal started \(c1\) for TEST-1/);
  assert.equal(existsSync("/far"), false, "nothing made here");
  const [made, started] = posts().slice(1);
  assert.deepEqual(made, ["/agents/cal/worktree", { repo: "api", ticket: "TEST-1" }], "names, not paths");
  assert.equal(started?.[0], "/agents/cal/start");
  assert.equal((started?.[1] as { cwd: string }).cwd, wt);
  assert.equal(loadRec(openWorkspace(dir), "TEST-1")?.worktree, wt);

  // cal is live on TEST-1; with its brief gone, --force on another item refuses before stopping it
  rmSync(join(dir, "briefs", "app.md"));
  r = factory(dir, ["dispatch", "cal", "TEST-2", "--force"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /appendix file .*app\.md is missing or empty/);
  assert.equal(posts().length, 3, "no stop, no worktree, no start");
  writeFileSync(join(dir, "briefs", "app.md"), "the brief\n");

  // the host could not read its worktree's status: stop refuses, without calling it uncommitted
  r = factory(dir, ["stop", "cal"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cal's worktree \/far\/api\/\.claude\/worktrees\/TEST-1 could not be read \(git status exited 128: fatal: x\), so what stopping it would lose is unknown/);
  assert.doesNotMatch(r.stderr, /uncommitted/);

  // the host's worktree has an uncommitted file: stop refuses and stops nothing
  r = factory(dir, ["stop", "cal"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cal's worktree \/far\/api\/\.claude\/worktrees\/TEST-1 has uncommitted changes: src\/x\.ts/);
  assert.deepEqual(posts().slice(3), [["/agents/cal/worktree/left", { repo: "api", ticket: "TEST-1" }], ["/agents/cal/worktree/left", { repo: "api", ticket: "TEST-1" }]]);

  r = factory(dir, ["stop", "cal", "--remove-worktree"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopped cal \(c1\)\n  worktree removed/);
  assert.deepEqual(posts().slice(5).map(([u, b]) => (u === "/agents/cal/stop" ? [u] : [u, b])), [
    ["/agents/cal/worktree/left", { repo: "api", ticket: "TEST-1" }],
    ["/agents/cal/stop"],
    ["/agents/cal/worktree/remove", { repo: "api", ticket: "TEST-1" }],
  ]);

  // the doctor asks the host about the checkout
  const ws = openWorkspace(dir);
  const api = checkouts(ws).find((c) => c.what.includes("repos.api"));
  assert.deepEqual([api?.status, api?.what], ["ok", "/far/api is a checkout of acme/api (repos.api) on far"]);
  assert.ok(d.requests().some((q) => q.method === "GET" && q.url === "/repos/api/checkout"));

  // the host refuses a left check or a removal: an error with its words. A checkout has no refusal.
  const cal = ws.config.agents.find((a) => a.name === "cal")!;
  const t = transportFor(ws, cal);
  const q7 = { agent: cal, repo: ws.config.repos.api!, ticket: "TEST-7", toolWritten: [] };
  const refused = (e: unknown) => e instanceof FactoryError && e.message === "on host far: /far/api/.claude/worktrees/TEST-7 is in the way";
  assert.throws(() => t.worktreeLeft(q7), refused, "left");
  assert.throws(() => t.removeWorktree(q7), refused, "remove");
  assert.throws(() => t.checkout({ ...ws.config.repos.api!, key: "gone" }), (e: unknown) => e instanceof Unreachable && /HTTP 422 not a refusal/.test(e.message));
});

test("an item whose builder's host cannot be reached is handed over on --unchecked or a forced dispatch, with a warning", async () => {
  const port = await closedPort();
  const dir = workspace(hostedCal(`http://127.0.0.1:${port}`));
  for (const a of [["building", "--agent", "cal", "--evidence", "a"], ["pr-open", "--pr", "acme/api#9", "--head", "abc1234abc1234"]])
    assert.equal(factory(dir, ["state", "TEST-9", ...a]).status, 0, a.join(" "));
  // a dispatch without --force refuses on the record alone
  let r = factory(dir, ["dispatch", "bea", "TEST-9"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TEST-9 is pr-open, built by cal; its redo is cal's\. To hand it to bea, dispatch with --force\./);
  r = factory(dir, ["state", "TEST-9", "pr-open", "--agent", "bea", "--pr", "acme/api#9", "--head", "abc1234abc1234"]);
  assert.notEqual(r.status, 0);
  const refused = /cal's host far cannot be reached \(ECONNREFUSED\) to see whether its session is in TEST-9's worktree\. To hand TEST-9 to bea anyway, run again with --unchecked\./;
  assert.match(r.stderr, refused);
  // --force is no way past the host: it waives the transition checks only
  r = factory(dir, ["state", "TEST-9", "pr-open", "--agent", "bea", "--pr", "acme/api#9", "--head", "abc1234abc1234", "--force"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, refused);
  // and --unchecked waives no transition check
  r = factory(dir, ["state", "TEST-9", "fixing", "--agent", "bea", "--unchecked"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pr-open -> fixing is not a valid transition/);
  assert.equal(loadRec(openWorkspace(dir), "TEST-9")!.agent, "cal");
  r = factory(dir, ["state", "TEST-9", "pr-open", "--agent", "bea", "--pr", "acme/api#9", "--head", "abc1234abc1234", "--unchecked"]);
  assert.equal(r.status, 0, r.stderr);
  const warned = (to: string) => new RegExp(`warning: cal's host far cannot be reached \\(ECONNREFUSED\\) to see whether its session is in TEST-9's worktree, so TEST-9 goes to ${to} unchecked\\.`);
  assert.match(r.stdout, warned("bea"));
  assert.equal(loadRec(openWorkspace(dir), "TEST-9")!.agent, "bea");
});

test("a forced dispatch past a builder's host that cannot be reached warns and hands the redo over", async () => {
  const port = await closedPort();
  const dir = workspace(hostedCal(`http://127.0.0.1:${port}`));
  for (const a of [["building", "--agent", "cal", "--evidence", "a"], ["pr-open", "--pr", "acme/api#9", "--head", "abc1234abc1234"]])
    assert.equal(factory(dir, ["state", "TEST-9", ...a]).status, 0, a.join(" "));
  const r = factory(dir, ["dispatch", "bea", "TEST-9", "--force"]);
  assert.match(r.stdout, /warning: cal's host far cannot be reached \(ECONNREFUSED\) to see whether its session is in TEST-9's worktree, so TEST-9 goes to bea unchecked\./);
});

test("a hosted builder's fix round refuses on a handoff it cannot read, until --findings-checked", async () => {
  const dir = workspace(hostedCal("http://placeholder:1"));
  const d = await fakeDaemon(dir, sha(join(dir, "daemon.toml"), join(dir, "workspace.toml")));
  after(() => d.proc.kill());
  writeFileSync(join(dir, "factory.toml"), hostedCal(d.url));
  mkdirSync(join(dir, "briefs"));
  writeFileSync(join(dir, "briefs", "app.md"), "the brief\n");
  assert.equal(factory(dir, ["dispatch", "cal", "TEST-1"]).status, 0);
  for (const a of [["pr-open", "--pr", "acme/api#3", "--head", "abc1234abc1234"], ["agent-review", "--evidence", "briefed"]])
    assert.equal(factory(dir, ["state", "TEST-1", ...a]).status, 0, a.join(" "));
  let r = factory(dir, ["dispatch", "cal", "TEST-1"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cal's worktree \/far\/api\/\.claude\/worktrees\/TEST-1 is on far, so the handoff's findings cannot be checked/);
  assert.ok(!d.requests().some((q) => q.url === "/agents/cal/stop"), "nothing stopped");
  r = factory(dir, ["dispatch", "cal", "TEST-1", "--findings-checked"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /as a FIX ROUND session/);
});

// cal is live on TEST-1. A new item stops it only once the brief and the prompt file are read: with
// either missing, the dispatch refuses and the session is left running, whether TEST-1 is in review
// or --force is given.
test("a builder's dispatch that would stop its live session refuses first on a missing brief or prompt file", async () => {
  const dir = workspace(hostedCal("http://placeholder:1"));
  const d = await fakeDaemon(dir, sha(join(dir, "daemon.toml"), join(dir, "workspace.toml")), true);
  after(() => d.proc.kill());
  writeFileSync(join(dir, "factory.toml"), hostedCal(d.url));
  mkdirSync(join(dir, "briefs"));
  writeFileSync(join(dir, "briefs", "app.md"), "the brief\n");
  const posts = () => d.requests().filter((q) => q.method === "POST").map((q) => q.url);
  assert.equal(factory(dir, ["dispatch", "cal", "TEST-1"]).status, 0);
  const ws = openWorkspace(dir);
  saveRec(ws, { ...loadRec(ws, "TEST-1")!, state: "your-review" });
  const n = posts().length;
  const noStop = (what: string) => assert.ok(!posts().slice(n).includes("/agents/cal/stop"), `${what}: no stop`);

  rmSync(join(dir, "briefs", "app.md"));
  let r = factory(dir, ["dispatch", "cal", "TEST-2"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /appendix file .*app\.md is missing or empty/);
  noStop("in review, no brief");
  writeFileSync(join(dir, "briefs", "app.md"), "the brief\n");

  const gone = join(dir, "no-such-prompt.md");
  for (const extra of [[], ["--force"]]) {
    r = factory(dir, ["dispatch", "cal", "TEST-2", "--prompt-file", gone, ...extra]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no-such-prompt\.md/);
    noStop(`no prompt file ${extra.join(" ")}`);
  }
  assert.deepEqual(posts().slice(n).filter((u) => u !== "/agents/cal/worktree/left"), [], "nothing but the left check");

  // with both there, the in-review dispatch does stop it and starts TEST-2
  r = factory(dir, ["dispatch", "cal", "TEST-2"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(posts().slice(n).includes("/agents/cal/stop"));
});

test("a builder with a host, on the daemon's side: only its own builders, repos and item keys", () => {
  const dir = workspace(hostedCal("http://x:1"));
  const ws = openWorkspace(dir);
  const ok = { repo: "api", ticket: "TEST-1" };
  const st = (name: string, body: Record<string, unknown>, me = "far", op = "worktree/left") => serveWorktree(ws, me, name, op, body);
  assert.deepEqual(st("cal", ok), { status: 200, body: { exists: false, dirty: [], pushed: true } }, "no worktree there yet");
  assert.equal(st("cal", ok, "near").status, 404);
  assert.equal(st("bea", ok).status, 404);
  assert.equal(st("rae", ok).status, 404);
  assert.equal(st("nobody", ok).status, 404);
  assert.equal(st("cal", { repo: "web", ticket: "TEST-1" }).status, 400);
  for (const ticket of ["../../etc", "TEST-1/x", "..", "not a key", "", 7]) assert.equal(st("cal", { repo: "api", ticket }).status, 400, String(ticket));
  assert.equal(st("cal", ok, "far", "worktree/nope").status, 404);
  const made = st("cal", ok, "far", "worktree");
  assert.equal(made.status, 422, "a checkout that is not there is the host's refusal");
  assert.match(String(made.body.error), /\/far\/api/);
  assert.deepEqual(serveCheckout(ws, "far", "api"), { status: 200, body: { top: null, origin: "" } });
  assert.equal(serveCheckout(ws, "far", "web").status, 404);
  assert.equal(serveCheckout(ws, "near", "api").status, 404);
  // a daemon whose config moved the repo elsewhere still refuses it
  ws.config.repos.api!.host = "near";
  assert.equal(st("cal", ok).status, 404);
});

test("a builder with a host: what stopping it would lose, when its host does not answer or its cwd is no worktree", async () => {
  const dir = workspace(hostedCal(`http://127.0.0.1:${await closedPort()}`));
  const ws = openWorkspace(dir);
  const cal = ws.config.agents.find((a) => a.name === "cal")!;
  const t = transportFor(ws, cal);
  assert.match(builderLeft(ws, cal, t, "/far/api/.claude/worktrees/TEST-1") ?? "", /^cal's worktree \/far\/api\/\.claude\/worktrees\/TEST-1 could not be checked \(host far: .*\)\. Look there, or --force\.$/);
  assert.match(builderLeft(ws, cal, t, "/far/api") ?? "", /^cal's session is in \/far\/api on far, which is none of its worktrees/);
  // a session that gives no cwd is the same unknown for a hosted builder; a local one has nothing to look at
  assert.equal(builderLeft(ws, cal, t, undefined), "cal's session on far gives no cwd, so what stopping it would lose is unknown. Look there, or --force.");
  const bea = ws.config.agents.find((a) => a.name === "bea")!;
  assert.equal(builderLeft(ws, bea, local, undefined), null);
});

test("a stop removes a worktree only when the builder's cwd is one, here or on its host", () => {
  const ws = openWorkspace(workspace(hostedCal("http://x:1")));
  const removed: string[][] = [];
  const t: Transport = { ...local, removeWorktree: (q) => (removed.push([q.repo.key, q.ticket]), { ok: true, said: "" }) };
  const [bea, cal] = ["bea", "cal"].map((n) => ws.config.agents.find((a) => a.name === n)!);
  const wt = worktreePath(ws.config.repos.web!.path, "WEB-2");
  mkdirSync(join(wt, "packages", "api"), { recursive: true });
  assert.equal(stopWorktree(ws, bea!, t, join(wt, "packages", "api"), true), null, "a directory inside a worktree is not one");
  assert.equal(stopWorktree(ws, bea!, t, `${ws.config.repos.web!.path}/.claude/worktrees/`, true), null, "nor is the worktrees dir");
  assert.equal(stopWorktree(ws, bea!, t, worktreePath(ws.config.repos.web!.path, "WEB-9"), true), null, "a local worktree that is gone");
  assert.equal(stopWorktree(ws, bea!, t, wt, false), `worktree kept: ${wt}`);
  assert.equal(stopWorktree(ws, bea!, t, wt, true), "worktree removed");
  const far = "/far/api/.claude/worktrees/TEST-1";
  assert.equal(stopWorktree(ws, cal!, t, `${far}/src`, true), null);
  assert.equal(stopWorktree(ws, cal!, t, far, false), `worktree kept on far: ${far}`);
  assert.equal(stopWorktree(ws, cal!, t, far, true), "worktree removed");
  assert.deepEqual(removed, [["web", "WEB-2"], ["api", "TEST-1"]]);
});

test("a local builder's worktree is found through a symlink, from either side", () => {
  const dir = workspace(hostedCal("http://x:1"));
  const wt = join(dir, "repos", "web", ".claude", "worktrees", "WEB-3");
  mkdirSync(wt, { recursive: true });
  const link = join(dir, "home-link");
  symlinkSync(dir, link);
  const removed: string[] = [];
  const t: Transport = { ...local, removeWorktree: (q) => (removed.push(q.ticket), { ok: true, said: "" }) };
  const bea = (ws: ReturnType<typeof openWorkspace>) => ws.config.agents.find((a) => a.name === "bea")!;
  let ws = openWorkspace(dir);
  assert.equal(stopWorktree(ws, bea(ws), t, join(link, "repos", "web", ".claude", "worktrees", "WEB-3"), true), "worktree removed", "the session's cwd through the link");
  writeFileSync(join(dir, "factory.toml"), hostedCal("http://x:1").replace('repos = "repos"', `repos = "${join(link, "repos")}"`));
  ws = openWorkspace(dir);
  assert.equal(ws.config.repos.web!.path, join(link, "repos", "web"));
  assert.equal(stopWorktree(ws, bea(ws), t, wt, true), "worktree removed", "the config's path through the link");
  assert.deepEqual(removed, ["WEB-3", "WEB-3"]);
});

test("a hosted repo's path is kept normal, so its worktrees are found whatever the spelling", () => {
  for (const spelled of ["/far/api/", "/far/./api", "/far//api//", "/far/x/../api"]) {
    const ws = openWorkspace(workspace(hostedCal("http://x:1").replace('path = "/far/api"', `path = "${spelled}"`)));
    assert.equal(ws.config.repos.api!.path, "/far/api", spelled);
    const cal = ws.config.agents.find((a) => a.name === "cal")!;
    assert.equal(worktreeOf(ws, cal, "/far/api/.claude/worktrees/TEST-1")?.ticket, "TEST-1", spelled);
  }
  const root = openWorkspace(workspace(hostedCal("http://x:1").replace('path = "/far/api"', 'path = "/"')));
  assert.equal(root.config.repos.api!.path, "/", "the root keeps its slash");
  assert.equal(worktreeOf(root, root.config.agents.find((a) => a.name === "cal")!, "/.claude/worktrees/TEST-1")?.ticket, "TEST-1", "a checkout at the root");
});

test("a host's ssh destination for its transcripts: its name unless given, and never an option", () => {
  const load = (extra: string) => {
    const dir = tempWorkspace(withHost("http://x:1", extra));
    try {
      return loadConfig(join(dir, "factory.toml"), {}).hosts["far"]!.ssh;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(load(""), "far");
  assert.equal(load('ssh = "me@far.lan"'), "me@far.lan");
  for (const bad of ["-oProxyCommand=sh", "far lan"])
    assert.deepEqual(problems(withHost("http://x:1", `ssh = "${bad}"`)), [`hosts.far.ssh: must be an ssh destination, an alias or user@host, got "${bad}"`]);
  assert.deepEqual(problems(withHost("http://x:1", 'ssh = ""')), ['hosts.far.ssh: must be a non-empty string, got ""']);
});
