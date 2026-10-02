import { parseArgs, type ParseArgsConfig } from "node:util";
import type { Workspace } from "../workspace.js";
import { FactoryError, pyRepr } from "../util.js";
import { stackBoot, stackDestroy, stackDoctor, stackDown, stackStatus, stackUp, stackUrl, type Where } from "./engine.js";
import { startDetached, stopDetached, waitHttp, waitPortFree } from "./process.js";

export const STACK_USAGE = `  stack up|down|destroy|url|status|doctor [--stack S] [--slot N] [-- <args>]
                                  a work item's local stack, run from its worktree: the slot is
                                  allocated on up and kept until destroy. --slot N names a slot;
                                  up --slot N from outside a worktree runs the base branches.
                                  status and doctor without --slot cover every slot. up, down and
                                  destroy pass <args> to the script after the verb.
  stack boot [--wait S]           for factory up, which starts it detached: wait up to S seconds
                                  (default 600) for Docker, then run up on every placed slot,
                                  reserved ones included, whose sites do not answer
  stack run-detached --pid-file F --log L [--cwd D] [--port P] -- <command>...
                                  for stack scripts: stop what F names and its children, wait for
                                  P to be released, then start the command in a session of its own
  stack run-detached --stop --pid-file F [--port P]
                                  the stopping half alone
  stack wait-http <url> [--timeout S] [--any]
                                  for stack scripts: wait until the url answers below 400, or with
                                  any status with --any; exits 1 after S seconds (default 180)`;

const usage = (msg: string) => new FactoryError(`stack: ${msg}`, 2);

function parse(verb: string, argv: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    const r = parseArgs({ args: argv, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, string | boolean | undefined>, positionals: r.positionals };
  } catch (e) {
    throw usage(`${verb}: ${(e as Error).message}`);
  }
}

const int = (flag: string, v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw usage(`--${flag} must be a whole number, got ${pyRepr(String(v))}`);
  return n;
};

// Async verbs report here: main has returned by the time they finish.
function settle(p: Promise<number>): void {
  p.then((code) => {
    process.exitCode = code;
  }, (e: unknown) => {
    if (!(e instanceof FactoryError)) throw e;
    console.error(`factory: ${e.message}`);
    process.exitCode = e.code;
  });
}

export function cmdStack(ws: Workspace, argv: string[]): void {
  const [verb, ...rest] = argv;
  if (verb === "-h" || verb === "--help") return void console.log(STACK_USAGE);
  if (verb === "run-detached") return runDetached(rest);
  if (verb === "wait-http") return waitForHttp(rest);
  if (verb === "boot") return boot(ws, rest);
  const s = { type: "string" } as const;
  // Split before parsing, so the script's own flags are never read as ours.
  const dash = rest.indexOf("--");
  const own = dash < 0 ? rest : rest.slice(0, dash);
  const args = dash < 0 ? [] : rest.slice(dash + 1);
  const { values: v, positionals: p } = parse(verb ?? "", own, { stack: s, slot: s });
  if (v.help) return void console.log(STACK_USAGE);
  if (p.length) throw usage(`${verb}: unexpected ${p.map(pyRepr).join(" ")}`);
  if (dash >= 0 && verb !== "up" && verb !== "down" && verb !== "destroy") throw usage(`${verb} passes nothing to the script; only up, down and destroy take -- <args>`);
  const w: Where = { cwd: process.cwd(), stack: v.stack as string | undefined, slot: int("slot", v.slot), args };
  switch (verb) {
    case "up": return stackUp(ws, w);
    case "down": return stackDown(ws, w);
    case "destroy": return stackDestroy(ws, w);
    case "url": return stackUrl(ws, w);
    case "status": return stackStatus(ws, w);
    case "doctor": {
      const r = stackDoctor(ws, w);
      for (const l of r.lines) console.log(l);
      if (!r.lines.length) console.log("no stack has a script");
      if (!r.ok) throw new FactoryError("the machine lacks something a stack needs; see the MISSING lines");
      return;
    }
    default:
      throw usage(verb ? `no verb ${pyRepr(verb)}; see factory stack --help` : `which verb?\n${STACK_USAGE}`);
  }
}

function boot(ws: Workspace, argv: string[]): void {
  const { values: v, positionals: p } = parse("boot", argv, { wait: { type: "string" } });
  if (v.help) return void console.log(STACK_USAGE);
  if (p.length) throw usage(`boot: unexpected ${p.map(pyRepr).join(" ")}`);
  settle(stackBoot(ws, { waitS: int("wait", v.wait) ?? 600 }));
}

function runDetached(argv: string[]): void {
  const s = { type: "string" } as const;
  const { values: v, positionals: cmd } = parse("run-detached", argv, { "pid-file": s, log: s, cwd: s, port: s, stop: { type: "boolean" } });
  if (v.help) return void console.log(STACK_USAGE);
  const pidFile = v["pid-file"] as string | undefined;
  if (!pidFile) throw usage("run-detached needs --pid-file");
  if (v.stop && cmd.length) throw usage("run-detached --stop takes no command");
  if (!v.stop && (!v.log || !cmd.length)) throw usage("run-detached needs --log and a command after --");
  const port = int("port", v.port);
  settle((async () => {
    const said = stopDetached(pidFile);
    if (port !== undefined && !(await waitPortFree(port)))
      throw new FactoryError(`port ${port} is still held 10 s after stopping ${pidFile}, by something it does not name`);
    if (v.stop) {
      console.log(said);
      return 0;
    }
    const pid = startDetached(cmd, { pidFile, log: v.log as string, cwd: v.cwd as string | undefined });
    console.log(`started ${pid}, output in ${v.log as string}`);
    return 0;
  })());
}

function waitForHttp(argv: string[]): void {
  const { values: v, positionals: p } = parse("wait-http", argv, { timeout: { type: "string" }, any: { type: "boolean" } });
  if (v.help) return void console.log(STACK_USAGE);
  if (p.length !== 1) throw usage("wait-http takes one url");
  const url = p[0] as string;
  const timeoutS = int("timeout", v.timeout) ?? 180;
  settle(waitHttp(url, { timeoutS, any: !!v.any }).then((r) => {
    if (r.ok) {
      console.log(`${url} answered ${r.code}`);
      return 0;
    }
    console.error(`factory: ${url} did not answer${v.any ? "" : " below 400"} within ${timeoutS} s${r.code !== null ? `; the last answer was ${r.code}` : ""}`);
    return 1;
  }));
}
