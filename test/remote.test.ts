// The remote transport against a fake factory daemon, and what a host that cannot be asked looks
// like in config, `sessions --fleet`, the doctor and the board.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { serve } from "../src/board/server.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { hostChecks, line, workspaceFiles } from "../src/doctor.js";
import { launch, roleOf, settingsFile } from "../src/launch.js";
import { fleetLines, type Session, waitForName } from "../src/fleet.js";
import { Unreachable } from "../src/remote.js";
import { local, type Transport, transportFor } from "../src/transport.js";
import { openWorkspace } from "../src/workspace.js";
import { TOML, tempWorkspace } from "./helpers.js";

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
    if (req.url === "/agents/rae/respawn") return send(200, { ok: true, said: "back" });
    if (req.url === "/agents/rae/stop") return send(200, {});
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
host = "far"`)), ["agents[2].host: a builder runs where its worktrees are, on this machine"]);
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
