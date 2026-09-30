// `factory doctor`: what this machine and this workspace lack to run the fleet.
//
// Every check comes from config, never from a list of tools: a repo is checked because [repos]
// names it, a prompt because a scheduled job reads it, ffmpeg because the workspace records demos.
// The last lines are each stack script's own `doctor`, under the stack's name. One line per check,
// `ok <what>` or `MISSING <what> [fix: <step>]`, the shape the stack contract uses.
//
// It reads only. Nothing here installs, starts or changes anything; a fix is text for the human.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { boardPid } from "./board/server.js";
import { isSettingsPath, ROLES } from "./config.js";
import { claudeBin, executable } from "./fleet.js";
import { findPlaywright } from "./gate/demo.js";
import { ghBin } from "./gate/github.js";
import { jobStates } from "./scheduler/launchd.js";
import { TEMPLATES_DIR, templateNames } from "./settings.js";
import { stackDoctor } from "./stacks/engine.js";
import { trackerOf } from "./tracker/read.js";
import { promptPath } from "./watchers/job.js";
import type { Workspace } from "./workspace.js";
import { run } from "./util.js";

export interface Check {
  ok: boolean;
  what: string;
  fix?: string;
}

export const line = (c: Check) => (c.ok ? `ok ${c.what}` : `MISSING ${c.what}${c.fix ? ` [fix: ${c.fix}]` : ""}`);

// The combined output of a command that succeeded, or undefined.
function out(cmd: string, args: string[]): string | undefined {
  const r = run(cmd, args);
  return r.status === 0 ? (r.stdout + r.stderr).trim() : undefined;
}

export function versionAtLeast(text: string | undefined, want: [number, number]): boolean {
  const m = /(\d+)\.(\d+)/.exec(text ?? "");
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > want[0] || (major === want[0] && minor >= want[1]);
}

const nonEmpty = (p: string) => {
  try {
    const st = statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
};

const onPath = (name: string) =>
  (process.env.PATH ?? "").split(delimiter).map((d) => join(d, name)).find((p) => p.startsWith(sep) && executable(p));

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// The workspace's own files by their path inside it, everything else as it is.
const shown = (ws: Workspace, p: string) => (p.startsWith(ws.dir + sep) ? relative(ws.dir, p) : p);

// ---------------------------------------------------------------- the machine

function tools(ws: Workspace): Check[] {
  const checks: Check[] = [];
  const node = process.versions.node;
  checks.push({ ok: versionAtLeast(node, [22, 0]), what: `Node 22 or later (running ${node})`, fix: "install Node 22 or later, then install this package again" });

  const claude = claudeBin();
  const haveClaude = executable(claude);
  checks.push({ ok: haveClaude, what: `claude at ${claude}`, fix: "install Claude Code (curl -fsSL https://claude.ai/install.sh | bash), or set CLAUDE_BIN" });
  if (haveClaude) {
    let loggedIn = false;
    try {
      loggedIn = (JSON.parse(out(claude, ["auth", "status", "--json"]) ?? "{}") as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      loggedIn = false;
    }
    checks.push({ ok: loggedIn, what: "claude logged in", fix: "claude auth login" });
    let lists = false;
    try {
      lists = Array.isArray(JSON.parse(out(claude, ["agents", "--json"]) ?? ""));
    } catch {
      lists = false;
    }
    checks.push({ ok: lists, what: "claude agents --json, which lists background sessions", fix: "claude update" });
  }

  const gh = ghBin();
  const haveGh = out(gh, ["--version"]) !== undefined;
  checks.push({ ok: haveGh, what: `gh at ${gh.includes(sep) ? gh : (onPath(gh) ?? `${gh} on PATH`)}`, fix: "brew install gh, or set GH_BIN" });
  const ghIn = haveGh && out(gh, ["auth", "status"]) !== undefined;
  if (haveGh) checks.push({ ok: ghIn, what: "gh logged in", fix: "gh auth login" });
  if (ghIn)
    for (const r of Object.values(ws.config.repos))
      checks.push({
        ok: out(gh, ["api", `repos/${r.remote}`, "--jq", ".full_name"]) !== undefined,
        what: `gh can read ${r.remote} (repos.${r.key})`,
        fix: `ask for access to ${r.remote}, or gh auth refresh -s repo`,
      });

  const git = out("git", ["version"]);
  checks.push({
    ok: versionAtLeast(git, [2, 31]),
    what: `git 2.31 or later, for rev-parse --path-format${git ? ` (${git.replace(/^git version /, "")})` : ""}`,
    fix: "install a newer git",
  });
  return checks;
}

// A repo is checked out where config resolves it, as its own top level, with its remote as origin.
function checkouts(ws: Workspace): Check[] {
  return Object.values(ws.config.repos).map((r) => {
    let ok = false;
    if (isDir(r.path)) {
      const top = out("git", ["-C", r.path, "rev-parse", "--show-toplevel"]);
      const origin = top ? (out("git", ["-C", r.path, "remote", "get-url", "origin"]) ?? "") : "";
      ok = !!top && real(top) === real(r.path) && origin.toLowerCase().includes(r.remote.toLowerCase());
    }
    return {
      ok,
      what: `${r.path} is a checkout of ${r.remote} (repos.${r.key})`,
      fix: `git clone https://github.com/${r.remote}.git ${r.path}, or set repos.${r.key}.path`,
    };
  });
}

// ---------------------------------------------------------------- the workspace

function workspaceFiles(ws: Workspace): Check[] {
  const checks: Check[] = [];
  const cfg = ws.config;
  for (const name of ROLES) {
    const role = cfg.roles[name];
    if (!role || !cfg.agents.some((a) => a.role === name)) continue;
    // The lead's and the reviewers' launch prompts both begin with reading CLAUDE.md in their cwd.
    if (role.cwd) {
      const whose = name === "reviewer" ? "the reviewers'" : `the ${name}'s`;
      const md = join(role.cwd, "CLAUDE.md");
      checks.push({
        ok: nonEmpty(md),
        what: `${shown(ws, md)}, ${whose} instructions (roles.${name}.cwd)`,
        fix: isDir(role.cwd) ? `write ${shown(ws, md)}` : `create ${shown(ws, role.cwd)} and write CLAUDE.md in it, or set roles.${name}.cwd`,
      });
    }
    if (isSettingsPath(role.settings))
      checks.push({ ok: nonEmpty(role.settings), what: `${shown(ws, role.settings)} (roles.${name}.settings)`, fix: `write it, or name a template: ${templateNames().join(", ")}` });
    else
      checks.push({
        ok: existsSync(join(TEMPLATES_DIR, `${role.settings}.json`)),
        what: `settings template ${JSON.stringify(role.settings)} (roles.${name}.settings)`,
        fix: `name one of ${templateNames().join(", ")}, or the path of a settings file`,
      });
    if (role.mcpConfig) checks.push({ ok: nonEmpty(role.mcpConfig), what: `${shown(ws, role.mcpConfig)} (roles.${name}.mcp_config)`, fix: "write it, or remove the key" });
  }

  // One line per file however many agents append it. A repo: file is looked for in each checkout
  // the agent can be dispatched into, since dispatch refuses when it is missing there; a checkout
  // that is not there has its own line above.
  const appendix = new Map<string, string[]>();
  for (const a of cfg.agents)
    for (const item of a.appendix) {
      const files = item.startsWith("repo:")
        ? a.repos.map((k) => cfg.repos[k]!.path).filter(isDir).map((d) => join(d, item.slice("repo:".length)))
        : [item];
      for (const f of files) appendix.set(f, [...(appendix.get(f) ?? []), a.name]);
    }
  for (const [f, names] of appendix)
    checks.push({ ok: nonEmpty(f), what: `${shown(ws, f)}, appended for ${names.join(", ")}`, fix: "write it, or take it out of the agent's appendix" });

  // The round runs on every schedule and the courier on every board; the queue watcher only when
  // there is a tracker to read.
  const example = (job: string) => `copy examples/prompts/${job}.md from the program and edit it`;
  const prompt = (job: "queue" | "round" | "relay", why: string, extra?: (text: string) => boolean) => {
    const p = promptPath(ws, job);
    const ok = nonEmpty(p) && (!extra || extra(readFileSync(p, "utf8")));
    checks.push({ ok, what: `${shown(ws, p)}, ${why}`, fix: example(job) });
  };
  if (trackerOf(ws).reads) prompt("queue", "the queue watcher's prompt");
  prompt("round", "the hourly round's prompt");
  prompt("relay", "the courier's prompt, with {text} in it", (t) => t.includes("{text}"));

  for (const s of Object.values(cfg.stacks))
    if (s.script)
      checks.push({
        ok: existsSync(s.script) && executable(s.script),
        what: `${shown(ws, s.script)} executable (stacks.${s.key}.script)`,
        fix: existsSync(s.script) ? `chmod +x ${shown(ws, s.script)}` : "write it to the stack contract in the program's docs/design.md",
      });
  return checks;
}

// ---------------------------------------------------------------- demos

// A workspace records demos when it holds demo.env, the file `factory demo` reads its sign-in and
// base URLs from, or when @playwright/test can be found, which `factory demo` runs. Otherwise no
// builder can run a demo there, and ffmpeg and Playwright are not asked about.
export function demoReason(ws: Workspace): string | undefined {
  if (existsSync(join(ws.dir, "demo.env"))) return "the workspace has demo.env";
  if (findPlaywright(ws, ws.dir)) return "@playwright/test is installed";
  return undefined;
}

// The headless Chromium Playwright launches for headless: true, by the revision its own
// browsers.json pins, in the cache `npx playwright install` fills.
function headlessChromium(pw: string): { dir?: string; name: string } {
  const name = "chromium_headless_shell";
  let core: string | undefined;
  for (const from of [pw, join(pw, "..", "..", "playwright")]) {
    try {
      core = dirname(createRequire(join(from, "package.json")).resolve("playwright-core/package.json"));
      break;
    } catch {
      // not resolvable from here
    }
  }
  if (!core) return { name };
  let rev: string | undefined;
  try {
    const doc = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")) as { browsers?: { name?: string; revision?: string }[] };
    rev = doc.browsers?.find((b) => b.name === "chromium-headless-shell")?.revision;
  } catch {
    return { name };
  }
  if (!rev) return { name };
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright"));
  return { dir: join(cache, `${name}-${rev}`), name: `${name}-${rev}` };
}

function demoTools(ws: Workspace): Check[] {
  const why = demoReason(ws);
  if (!why) return [];
  const checks: Check[] = [];
  checks.push({
    ok: (out("ffmpeg", ["-hide_banner", "-encoders"]) ?? "").includes("libx264"),
    what: `ffmpeg with libx264, which factory demo encodes with (${why})`,
    fix: "brew install ffmpeg",
  });
  const pw = findPlaywright(ws, ws.dir);
  checks.push({
    ok: !!pw,
    what: pw ? `@playwright/test at ${pw}` : `@playwright/test, which factory demo runs (${why})`,
    fix: "npm install -D @playwright/test in the workspace",
  });
  if (pw) {
    const b = headlessChromium(pw);
    checks.push({ ok: !!b.dir && isDir(b.dir), what: `Playwright's headless Chromium ${b.name}`, fix: "npx playwright install chromium, in the workspace" });
  }
  return checks;
}

// ---------------------------------------------------------------- the board and the scheduler

// A bind rather than a connect, because the question is whether the board could listen there,
// whatever interface the other holder chose. The socket closes before this returns.
function tryListen(host: string, port: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e));
    s.listen(port, host, () => s.close(() => resolve(null)));
  });
}

async function boardPort(ws: Workspace): Promise<Check> {
  const { host, port } = ws.config.board;
  const at = `${host}:${port}`;
  const pid = boardPid(ws);
  if (pid) return { ok: true, what: `board port ${at}, held by this workspace's board (pid ${pid})` };
  const e = await tryListen(host, port);
  if (!e) return { ok: true, what: `board port ${at} free` };
  if (e.code === "EADDRINUSE") return { ok: false, what: `board port ${at} free, but another process holds it`, fix: "stop that process, or set board.port" };
  return { ok: false, what: `board host ${host} to listen on (${e.code ?? e.message})`, fix: "set board.host to a name this machine answers on, such as localhost" };
}

// Reported, never fixed: installing jobs is `factory schedule install`, which the human runs.
function scheduler(ws: Workspace): Check[] {
  if (process.platform !== "darwin") return [{ ok: false, what: "a scheduler for the watchers; only launchd on macOS is built" }];
  const s = jobStates(ws);
  const fix = "factory schedule install";
  if (s.listFailed) return [{ ok: false, what: "launchctl list, to see the watchers' jobs", fix: "run it by hand and read its error" }];
  const checks: Check[] = s.jobs.map(({ job, installed, loaded }) =>
    installed === "no" ? { ok: false, what: `launchd job ${job.label} installed`, fix }
    : installed === "stale" ? { ok: false, what: `launchd job ${job.label} as config renders it now`, fix }
    : !loaded ? { ok: false, what: `launchd job ${job.label} loaded`, fix }
    : { ok: true, what: `launchd job ${job.label} loaded` });
  for (const l of s.unwanted) checks.push({ ok: false, what: `launchd job ${l} removed, since config no longer runs it`, fix });
  return checks;
}

// ---------------------------------------------------------------- all of it

// Prints as it goes, since the GitHub reads take a moment each. Resolves to the exit code: 1 when
// anything is missing.
export async function doctor(ws: Workspace, print: (l: string) => void = console.log): Promise<number> {
  let missing = 0;
  const emit = (checks: Check[]) => {
    for (const c of checks) {
      if (!c.ok) missing++;
      print(line(c));
    }
  };
  emit(tools(ws));
  emit(checkouts(ws));
  emit(workspaceFiles(ws));
  emit(demoTools(ws));
  emit([await boardPort(ws)]);
  emit(scheduler(ws));
  // A stack whose script cannot run has its line above; its doctor would only repeat it.
  for (const s of Object.values(ws.config.stacks)) {
    if (!s.script || !existsSync(s.script) || !executable(s.script)) continue;
    const r = stackDoctor(ws, { cwd: ws.dir, stack: s.key });
    for (const l of r.lines) {
      if (l.startsWith(`${s.key}: MISSING`)) missing++;
      print(l);
    }
  }
  return missing ? 1 : 0;
}
