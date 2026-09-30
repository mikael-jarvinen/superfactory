// The courier: carries one text to the lead's live session. The board uses it for a message page
// line that lands while no inbox monitor is armed, and the queue watcher for what it found.
//
// No CLI hands a message to a running session, so the only way in is a session of its own calling
// SendMessage. This is the smallest one that can: the relay model, low effort, two tools, one
// instruction, no memory. It is a courier and nothing else, so it is never given the text to
// interpret, only to deliver. A page line arrives already prefixed and tagged by the inbox, and the
// tag is what the page's receipts look for, so it goes through untouched.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { Relay } from "../board/inbox.js";
import { claudeBin } from "../fleet.js";
import type { Workspace } from "../workspace.js";
import { die, run } from "../util.js";
import { claudeArgs, claudeOptions, failure, loadPrompt, logTo, openLog } from "./job.js";

const TOOLS = ["SendMessage", "ListAgents"];

export function courierPrompt(ws: Workspace, text: string): string {
  if (!loadPrompt(ws, "relay").includes("{text}")) die("the relay prompt has no {text}, so the courier would carry nothing");
  return loadPrompt(ws, "relay", { text });
}

// For the board: starts the courier and returns at once, because the sweep runs inside the board
// and a sweep that waits on a model call is a page that hangs after Send. The courier's reply goes
// to logs/relay.log; a failure is also a line in the failures log.
export const relay: Relay = (ws: Workspace, text: string) => {
  let log: string;
  let prompt: string;
  let args: string[];
  try {
    log = openLog(ws, "relay");
    prompt = courierPrompt(ws, text);
    args = claudeArgs(ws, "relay", TOOLS);
  } catch (e) {
    failure(ws, `relay FAILED before starting: ${(e as Error).message}`);
    return;
  }
  const fd = openSync(log, "a");
  const o = claudeOptions("relay");
  const child = spawn(claudeBin(), args, { env: o.env, timeout: o.timeout, killSignal: o.killSignal, stdio: ["pipe", fd, fd] });
  closeSync(fd);
  // A courier that cannot start can report both an error and an exit; one failure line is enough.
  let failed = false;
  const fail = (why: string) => {
    if (!failed) failure(ws, `relay FAILED ${why}`);
    failed = true;
  };
  child.on("error", (e) => fail(`to start: ${e.message}`));
  child.on("exit", (code, signal) => {
    logTo(log, `exit=${code ?? signal}`);
    if (code !== 0) fail(`exit=${code ?? signal}`);
  });
  child.stdin?.on("error", () => {}); // a courier that died at once is reported by its exit
  child.stdin?.end(prompt);
};

// For a watcher, which is a process of its own and can wait. True when the courier exited clean.
export function deliver(ws: Workspace, text: string): boolean {
  const log = openLog(ws, "relay");
  const r = run(claudeBin(), claudeArgs(ws, "relay", TOOLS), { ...claudeOptions("relay"), input: courierPrompt(ws, text) });
  logTo(log, r.stdout);
  if (r.stderr.trim()) logTo(log, r.stderr);
  logTo(log, `exit=${r.status}`);
  if (r.status !== 0) failure(ws, `relay FAILED exit=${r.status}`);
  return r.status === 0;
}
