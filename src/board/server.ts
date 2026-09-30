import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeBin, lead, type Session, sessionAlive } from "../fleet.js";
import { statusFile } from "../hooks/status.js";
import { isHuman, readTail } from "../messages.js";
import { allRecs, BUSY, isLocal, type Rec, recPrs, STATES, WAITING_ON_YOU } from "../state.js";
import type { Workspace } from "../workspace.js";
import { capitalize, run, sleep } from "../util.js";
import { postMessage, Receipts, type Relay, sweep } from "./inbox.js";

// The board: a read-only picture of the fleet at `/`, and the thread between the human and the lead
// at `/messages`. `/api` and `/api/messages` are the JSON behind them, and both pages re-fetch every
// two seconds. Posting to `/api/messages` is the one write, and it only appends to the message log:
// the text lands in the thread at once, so the page never looks like it swallowed it. Getting it to
// the lead is the inbox's job. state/ is written by the factory alone, so a board that is wrong is
// a board with a bug rather than a store that has been corrupted.

const STATIC = fileURLToPath(new URL("./static/", import.meta.url));
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

// What the stack engine exports for the board, one row per site of a slot:
// stack, slot, name, worktree ("-" for a free slot), url, health url.
export const stacksFile = (ws: Workspace) => join(ws.stateDir, "stacks.tsv");

const pidFile = (ws: Workspace) => join(ws.logsDir, "board.pid");
const logFile = (ws: Workspace) => join(ws.logsDir, "board.log");
const url = (ws: Workspace) => `http://${ws.config.board.host}:${ws.config.board.port}`;

// One short paragraph per column, sent with the data so the page never carries its own copy. They
// describe what is true of a work item sitting there, not what somebody should do about it.
const DESCRIPTIONS: Record<string, string> = {
  "queued": "Ready to start and waiting for a free teammate: a ticket assigned to {human}, or an " +
    "ad-hoc task {human} asked for that has no ticket at all.",
  "building": "A teammate is writing the code in a worktree of its own. There is no plan to approve " +
    "first, so {lead}'s brief is the whole specification and the first thing {human} sees is the PR.",
  "pr-open": "A draft PR exists against the base branch, with its number and head sha recorded.",
  "agent-review": "A reviewer is reading the diff in a fresh session that has seen nothing before it.",
  "fixing": "The builder is back on the same item, closing every finding the review reported.",
  "gate": "The gate is asking every question about the current head and treating any absence as a " +
    "failure. The PR is undrafted only once all of them pass.",
  "your-review": "{human}'s. The PR is frozen at the sha that was reviewed, and nobody pushes over it " +
    "without saying so first.",
  "colleague-review": "{human} has asked the team. {lead} watches GitHub and does nothing until the merge lands.",
  "blocked": "{lead} asked {human} something and has no answer yet. The state underneath is kept, so " +
    "the work resumes where it stopped rather than starting again.",
};

const ageMinutes = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 60000);
};

const clock = () => new Date().toTimeString().slice(0, 8);

// ---------------------------------------------------------------- sessions
//
// `claude agents --json` spawns a process and the page asks every two seconds, so one answer is
// refreshed in the background and every request is served it. Asynchronously, because a board that
// stops answering while the listing runs is a board that looks down.
const SESSION_EVERY = 3000;

class SessionCache {
  rows: Session[] = [];
  private busy = false;

  refresh(): void {
    if (this.busy) return;
    this.busy = true;
    execFile(claudeBin(), ["agents", "--json"], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      this.busy = false;
      try {
        this.rows = err ? [] : (JSON.parse(stdout || "[]") as Session[]);
      } catch {
        this.rows = [];
      }
    });
  }

  background(): Map<string, Session> {
    const m = new Map<string, Session>();
    for (const s of this.rows) if (s.kind === "background" && s.name !== undefined && !(m.has(s.name) && !sessionAlive(s))) m.set(s.name, s);
    return m;
  }
}

// ---------------------------------------------------------------- stacks
//
// The rows come from the engine's export, so a slot, port or hostname has one home. The HTTP
// checks run here on a timer, and every request is served the last result: probing each stack on
// every two-second poll would make the page as slow as the slowest stack.
const STACK_EVERY = 30_000;
const PROBE_TIMEOUT = 4000;

interface StackRow {
  stack: string;
  slot: number;
  name: string;
  worktree: string;
  url: string;
  health: string;
  up: boolean;
  code: number | null;
}

function probe(target: string): Promise<{ up: boolean; code: number | null }> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return resolve({ up: false, code: null });
    }
    const done = (r: IncomingMessage) => {
      r.resume();
      const code = r.statusCode ?? null;
      resolve({ up: code !== null && code >= 200 && code < 400, code });
    };
    // the stacks serve local self-signed certificates
    const req = u.protocol === "https:" ? httpsGet(u, { rejectUnauthorized: false, timeout: PROBE_TIMEOUT }, done) : httpGet(u, { timeout: PROBE_TIMEOUT }, done);
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ up: false, code: null }));
  });
}

class StackChecks {
  rows: StackRow[] = [];
  present = false;
  at: number | null = null;

  async check(ws: Workspace): Promise<void> {
    let text: string;
    try {
      text = readFileSync(stacksFile(ws), "utf8");
      this.present = true;
    } catch {
      this.present = false;
      this.rows = [];
      this.at = Date.now();
      return;
    }
    const rows: StackRow[] = [];
    for (const line of text.split("\n")) {
      const f = line.split("\t");
      if (f.length !== 6 || !/^\d+$/.test(f[1] as string)) continue;
      const [stack, slot, name, worktree, u, health] = f as [string, string, string, string, string, string];
      rows.push({ stack, slot: Number(slot), name, worktree, url: u, health: health || u, up: false, code: null });
    }
    const first = await Promise.all(rows.map((r) => probe(r.health)));
    // A cold stack can miss one timeout, and one shown down for half a minute because of it is a
    // false alarm. Down means it failed twice.
    const again = await Promise.all(rows.map((r, i) => (first[i]!.up ? first[i]! : probe(r.health))));
    rows.forEach((r, i) => Object.assign(r, again[i]));
    this.rows = rows;
    this.at = Date.now();
  }

  view(ws: Workspace, recs: Rec[]) {
    const byTicket = new Map(recs.map((r) => [r.ticket, r]));
    const owner = (worktree: string) => {
      if (worktree === "-" || worktree === "") return { who: null, ticket: null, idle: true, free: true };
      const rec = byTicket.get(basename(worktree));
      // a worktree that is no work item's is the stack's own, idle on its base branch
      if (!rec) return { who: null, ticket: null, idle: true, free: false };
      return { who: rec.agent, ticket: rec.ticket, idle: false, free: false };
    };
    const order = Object.keys(ws.config.stacks);
    const keys = [...new Set(this.rows.map((r) => r.stack))].sort((a, b) => {
      const [x, y] = [order.indexOf(a), order.indexOf(b)];
      return x === y ? (a < b ? -1 : 1) : x < 0 ? 1 : y < 0 ? -1 : x - y;
    });
    const out = [];
    for (const stack of keys) {
      const reserve = ws.config.stacks[stack]?.reserve ?? [];
      const here = this.rows.filter((r) => r.stack === stack);
      // the human's own slots last in each stack
      const slots = [...new Set(here.map((r) => r.slot))].sort((a, b) => Number(reserve.includes(a)) - Number(reserve.includes(b)) || a - b);
      for (const slot of slots) {
        const rows = here.filter((r) => r.slot === slot);
        const mine = reserve.includes(slot);
        let host = "";
        try {
          host = new URL(rows[0]!.url).host;
        } catch {
          host = rows[0]!.url;
        }
        const sites = rows.map((r) => ({ name: r.name, link: r.url, up: r.up, code: r.code, owner: mine ? null : owner(r.worktree) }));
        out.push({ stack, slot, mine, host, up: sites.filter((s) => s.up).length, of: sites.length, sites });
      }
    }
    return { present: this.present, checked_s: this.at === null ? null : Math.floor((Date.now() - this.at) / 1000), stacks: out };
  }
}

// ---------------------------------------------------------------- the snapshot

// Builders group by their stack, or by their repos when they have none, so an agent added to the
// config lands in the right group without the board changing.
function teams(ws: Workspace, recs: Rec[], listed: Map<string, Session>) {
  const groups = new Map<string, { key: string; title: string; scope: string; members: unknown[] }>();
  const reviewerRepos = ws.config.roles.reviewer?.addDirs ?? [];
  for (const a of ws.config.agents) {
    const [key, title, scope] =
      a.role === "lead" ? ["lead", "Lead", ""]
      : a.role === "reviewer" ? ["reviewers", "Reviewers", reviewerRepos.join(", ")]
      : a.stack ? [`stack:${a.stack}`, capitalize(a.stack), a.repos.join(", ")]
      : [`repos:${a.repos.join(",")}`, a.repos.length === 1 ? capitalize(a.repos[0] as string) : "Builders", a.repos.join(", ")];
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, title, scope, members: [] }));
    const s = listed.get(a.name);
    const alive = sessionAlive(s);
    const rec = recs.find((r) => r.agent === a.name && r.state !== null && BUSY.has(r.state));
    g.members.push({
      name: a.name,
      alive,
      status: alive ? (s?.status ?? null) : null,
      ticket: rec?.ticket ?? null,
      state: rec?.state ?? null,
      since_min: rec ? ageMinutes(rec.since) : null,
    });
  }
  const rank = (k: string) => (k === "lead" ? 0 : k === "reviewers" ? 2 : 1);
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

// Each item's most recent note or evidence, so a card says why it sits where it does.
function latestLines(ws: Workspace): Map<string, string> {
  const out = new Map<string, string>();
  for (const ev of readTail(ws.events) as Record<string, unknown>[]) {
    const line = ev.note || ev.evidence;
    if (typeof ev.ticket === "string" && typeof line === "string" && line) out.set(ev.ticket, line);
  }
  return out;
}

// Every heartbeat a job has left in logs/, whoever wrote it.
function heartbeats(ws: Workspace) {
  let names: string[] = [];
  try {
    names = readdirSync(ws.logsDir).filter((f) => f.endsWith(".heartbeat")).sort();
  } catch {
    // no logs yet
  }
  return names.map((name) => {
    try {
      return { name, age_s: Math.floor((Date.now() - statSync(join(ws.logsDir, name)).mtimeMs) / 1000) };
    } catch {
      return { name, age_s: null };
    }
  });
}

function snapshot(ws: Workspace, sessions: SessionCache, stacks: StackChecks) {
  const recs = allRecs(ws);
  const lines = latestLines(ws);
  const human = ws.config.human.name;
  const leadName = capitalize(lead(ws).name);
  const tickets = recs.filter((r) => r.state !== "done").map((r) => ({
    ticket: r.ticket,
    title: r.title ?? null,
    state: r.state,
    agent: r.agent,
    stack: r.stack,
    jira: r.jira,
    local: isLocal(r.ticket),
    age_min: ageMinutes(r.since),
    question: r.asked_you?.question ?? null,
    line: lines.get(r.ticket) ?? null,
    prs: recPrs(r).map((p) => ({
      repo: (p.repo ?? "").split("/").pop(),
      number: p.number ?? null,
      url: `https://github.com/${p.repo}/pull/${p.number}`,
    })),
  }));
  const idx = (s: string | null) => (s !== null && (STATES as readonly string[]).includes(s) ? STATES.indexOf(s as (typeof STATES)[number]) : 99);
  tickets.sort((a, b) => idx(a.state) - idx(b.state) || (b.age_min ?? 0) - (a.age_min ?? 0));
  const descriptions = Object.fromEntries(Object.entries(DESCRIPTIONS).map(([k, v]) => [k, v.replaceAll("{human}", human).replaceAll("{lead}", leadName)]));
  return {
    at: clock(),
    human,
    lead: lead(ws).name,
    columns: STATES.filter((s) => s !== "done"),
    descriptions,
    waiting_on_you: [...WAITING_ON_YOU].sort(),
    teams: teams(ws, recs, sessions.background()),
    stacks: stacks.view(ws, recs),
    tickets,
    plumbing: heartbeats(ws),
  };
}

// The lead's status hook writes its last word there, with the transcript path the receipts read.
function leadStatus(ws: Workspace): { words?: string; transcript?: string } {
  try {
    return JSON.parse(readFileSync(statusFile(ws, lead(ws).name), "utf8"));
  } catch {
    return {};
  }
}

function messagesView(ws: Workspace, sessions: SessionCache, receipts: Receipts) {
  const st = leadStatus(ws);
  receipts.read(st.transcript);
  const leadName = lead(ws).name;
  const status = sessionAlive(sessions.background().get(leadName)) ? (st.words ?? null) : "offline";
  const rows = readTail(ws.messages).reverse().slice(0, 60).map((r) => {
    const human = isHuman(ws, r.kind);
    return { ...r, from: human ? "human" : "lead", age_min: ageMinutes(r.t), receipt: human && r.id ? receipts.receipt(r.id) : null };
  });
  return { at: clock(), human: ws.config.human.name, lead: leadName, status, messages: rows };
}

// ---------------------------------------------------------------- HTTP

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const PAGES: Record<string, string> = { "/": "board.html", "/messages": "messages.html" };
const MAX_BODY = 64 * 1024;

function send(res: ServerResponse, code: number, body: string | Buffer, type: string): void {
  const raw = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(code, { "Content-Type": type, "Content-Length": raw.length, "Cache-Control": "no-store" });
  res.end(raw);
}

const json = (res: ServerResponse, code: number, v: unknown) => send(res, code, JSON.stringify(v), "application/json; charset=utf-8");

// A posted message reaches the lead as the human's own instruction, so a page on another site open
// in the same browser must not be able to post one. Requiring application/json makes the request
// non-simple, which forces a preflight the board never answers with CORS headers, so the browser
// refuses to send it. An Origin naming another host is refused as well.
function sameSite(req: IncomingMessage): boolean {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export interface ServeOptions {
  host?: string;
  port?: number;
  // Step in for the lead while no monitor holds the inbox. Without one, messages wait in the log
  // and the next monitor prints them from its cursor.
  relay?: Relay;
}

export interface Board {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export function serve(ws: Workspace, opts: ServeOptions = {}): Promise<Board> {
  // Read once: the set of files served is fixed, and nothing outside it can be asked for.
  const files = new Map<string, Buffer>();
  for (const f of readdirSync(STATIC)) files.set(f, readFileSync(join(STATIC, f)));

  const sessions = new SessionCache();
  const stacks = new StackChecks();
  const receipts = new Receipts();
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => {
    fn();
    timers.push(setInterval(fn, ms));
  };
  every(SESSION_EVERY, () => sessions.refresh());
  let checking = false;
  every(STACK_EVERY, () => {
    if (checking) return;
    checking = true;
    stacks.check(ws).catch(() => {}).finally(() => (checking = false));
  });
  const relay = opts.relay;
  if (relay)
    every(500, () => {
      try {
        sweep(ws, relay);
      } catch {
        // an unreadable log or cursor is tried again on the next pass
      }
    });

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    if (req.method === "POST") {
      if (path !== "/api/messages") return send(res, 404, "not found", "text/plain; charset=utf-8");
      if (!sameSite(req)) return json(res, 403, { ok: false, error: "refused: not from the message page" });
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        let body: { text?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return json(res, 400, { ok: false, error: "bad json" });
        }
        const r = postMessage(ws, body?.text);
        json(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", "text/plain; charset=utf-8");
    if (path === "/api") return json(res, 200, snapshot(ws, sessions, stacks));
    if (path === "/api/messages") return json(res, 200, messagesView(ws, sessions, receipts));
    const name = PAGES[path] ?? (path.startsWith("/static/") ? path.slice("/static/".length) : undefined);
    const body = name !== undefined ? files.get(name) : undefined;
    if (body) return send(res, 200, body, TYPES[extname(name as string)] ?? "application/octet-stream");
    send(res, 404, "not found", "text/plain; charset=utf-8");
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      // a torn record or an unreadable file costs this request, not the board
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    }
  });
  const host = opts.host ?? ws.config.board.host;
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => {
      timers.forEach(clearInterval);
      reject(e);
    };
    server.once("error", fail);
    server.listen(opts.port ?? ws.config.board.port, host, () => {
      server.off("error", fail);
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        url: `http://${host}:${port}`,
        close: () => {
          timers.forEach(clearInterval);
          return new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

// ---------------------------------------------------------------- running it

// The running board's pid, or null. A pid file outlives the process it names, so the pid is
// checked rather than trusted: after a reboot the number in the file is somebody else's, and a
// recycled pid belonging to something else would be worse than no board at all.
export function boardPid(ws: Workspace): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidFile(ws), "utf8").trim(), 10);
    process.kill(pid, 0);
  } catch {
    return null;
  }
  const cmd = run("ps", ["-o", "command=", "-p", String(pid)]).stdout;
  return cmd.includes("board --serve") && cmd.includes(ws.dir) ? pid : null;
}

export const boardLine = (ws: Workspace) => {
  const pid = boardPid(ws);
  return pid ? `  board      ${url(ws)} (pid ${pid})` : "  board      not running";
};

// `factory board --serve`: the board in this process, which is what `factory board` starts
// detached. The pid file is written once the port is bound, so its presence means the board answers.
export function runBoard(ws: Workspace, opts: ServeOptions = {}): void {
  serve(ws, opts).then(
    (b) => {
      mkdirSync(ws.logsDir, { recursive: true });
      writeFileSync(pidFile(ws), String(process.pid));
      console.log(`board on ${b.url}  (read-only; ctrl-c to stop)`);
      const stop = () => {
        try {
          if (readFileSync(pidFile(ws), "utf8").trim() === String(process.pid)) unlinkSync(pidFile(ws));
        } catch {
          // already gone
        }
        b.close().finally(() => process.exit(0));
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    },
    (e: Error) => {
      console.error(`factory: board: cannot listen on ${opts.host ?? ws.config.board.host}:${opts.port ?? ws.config.board.port}: ${e.message}`);
      process.exit(1);
    },
  );
}

export function startBoard(ws: Workspace, quiet = false, out = console.log): void {
  if (boardPid(ws)) {
    if (!quiet) out(`board already on ${url(ws)}`);
    return;
  }
  mkdirSync(ws.logsDir, { recursive: true });
  if (existsSync(pidFile(ws))) unlinkSync(pidFile(ws));
  const log = openSync(logFile(ws), "a");
  // detached: it survives the shell that ran `factory up`
  const child = spawn(process.execPath, [CLI, "--workspace", ws.dir, "board", "--serve"], { cwd: ws.dir, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  closeSync(log);
  for (let i = 0; i < 50; i++) {
    sleep(100);
    if (boardPid(ws) === child.pid) {
      out(`board on ${url(ws)}`);
      return;
    }
  }
  let tail = "";
  try {
    tail = readFileSync(logFile(ws), "utf8").trimEnd().split("\n").slice(-3).join("\n");
  } catch {
    // no log
  }
  out(`board did not come up; see ${logFile(ws)}${tail ? `\n${tail}` : ""}`);
}

export function stopBoard(ws: Workspace, quiet = false, out = console.log): void {
  const pid = boardPid(ws);
  if (!pid) {
    if (!quiet) out("board is not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // gone already
  }
  for (let i = 0; i < 20 && boardPid(ws); i++) sleep(100);
  try {
    unlinkSync(pidFile(ws));
  } catch {
    // the board removed it
  }
  out("board stopped");
}
