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
import { loadRec } from "../src/state.js";
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
const { TOKEN, HASH, LOG } = process.env;
const sessions = [
  { id: "r1", name: "rae", kind: "background", state: "idle", status: "idle", alive: true },
  { id: "r0", name: "rae", kind: "background", state: "idle", alive: false }, // a stale record: its supervisor is gone,
];
let lefts = 0; // the first look at cal's worktree finds an uncommitted file, later ones nothing
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
    if (req.url === "/agents/rae/respawn") return send(200, { ok: true, said: "back" });
    if (req.url === "/agents/rae/stop") return send(200, {});
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
    if (req.url === "/agents/cal/worktree/left") return send(200, lefts++ ? { exists: true, dirty: [], pushed: true } : { exists: true, dirty: ["src/x.ts"], pushed: true });
    if (req.url === "/agents/cal/worktree/remove") return send(200, { ok: true, said: "" });
    if (req.url === "/repos/api/checkout") return send(200, { top: "/far/api", origin: "https://github.com/acme/api.git" });
    send(404, { error: "no such route" });
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;

async function fakeDaemon(dir: string, hash: string): Promise<{ url: string; proc: ChildProcess; requests: () => { method: string; url: string; body: Record<string, unknown> | null }[] }> {
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const proc = spawn(process.execPath, ["--input-type=module", "-e", FAKE], { env: { ...process.env, TOKEN, HASH: hash, LOG: log }, stdio: ["ignore", "pipe", "inherit"] });
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
  const id = t.start({ agent: rae, cwd: "/far/rae", prompt: "hello", appendix: "the appendix", phase: undefined, args: () => assert.fail("rendered on the host, not here"), env: { SECRET: "x" } });
  assert.equal(id, "launched1");
  assert.deepEqual(t.respawn("rae", "r0"), { ok: true, said: "back", why: "back" });
  t.stop("rae", "r1", true);
  assert.deepEqual(d.requests().map((r) => [r.method, r.url, r.body]), [
    ["GET", "/agents?all=1", null],
    ["POST", "/agents/rae/start", { cwd: "/far/rae", prompt: "hello", appendix: "the appendix", phase: null }],
    ["POST", "/agents/rae/respawn", { id: "r0" }],
    ["POST", "/agents/rae/stop", { id: "r1", remove: true }],
  ]);
  // a 422 on a session route is an unknown host: respawn falls back, stop throws Unreachable
  const no = t.respawn("rae", "r422");
  assert.equal(no.ok, false);
  assert.match(no.why, /^host far is unknown: HTTP 422 not that one$/);
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
    respawn: () => assert.fail("not used"),
    stop: () => assert.fail("not used"),
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

  // the host's worktree has an uncommitted file: stop refuses and stops nothing
  r = factory(dir, ["stop", "cal"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cal's worktree \/far\/api\/\.claude\/worktrees\/TEST-1 has uncommitted changes: src\/x\.ts/);
  assert.deepEqual(posts().slice(3), [["/agents/cal/worktree/left", { repo: "api", ticket: "TEST-1" }]]);

  r = factory(dir, ["stop", "cal", "--remove-worktree"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopped cal \(c1\)\n  worktree removed/);
  assert.deepEqual(posts().slice(4).map(([u, b]) => (u === "/agents/cal/stop" ? [u] : [u, b])), [
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
