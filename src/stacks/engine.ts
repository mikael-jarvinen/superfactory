import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stacksFile } from "../board/server.js";
import type { Repo, Stack } from "../config.js";
import { loadRec } from "../state.js";
import type { Workspace } from "../workspace.js";
import { die, now, pyDumps, realpathLoose, sleep } from "../util.js";
import { git, HTTPS, registeredWorktrees, worktreePath } from "../worktree.js";
import { callScript, failed, type Placement } from "./contract.js";
import { alive } from "./process.js";

// The program owns the slots. A slot is a number from 0 to stacks.<key>.slots; the registry in
// state/stacks/<stack>.json says which worktree holds each repo's place in it. Everything a slot
// runs, and every port, hostname and database it runs on, is the stack script's business.

type Out = (line: string) => void;

export interface SlotEntry {
  created: string;
  worktrees: Placement;
}

export interface Registry {
  slots: Record<string, SlotEntry>;
}

export const registryPath = (ws: Workspace, stack: string) => join(ws.stateDir, "stacks", `${stack}.json`);

export function loadRegistry(ws: Workspace, stack: string): Registry {
  const p = registryPath(ws, stack);
  if (!existsSync(p)) return { slots: {} };
  return { slots: (JSON.parse(readFileSync(p, "utf8")) as Partial<Registry>).slots ?? {} };
}

function saveRegistry(ws: Workspace, stack: string, reg: Registry): void {
  const p = registryPath(ws, stack);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + ".tmp", pyDumps(reg, { indent: 2, sortKeys: true }) + "\n");
  renameSync(p + ".tmp", p);
}

// Allocation reads the registry, runs scripts and writes it back, and two builders starting their
// stacks at once must not both take the same free slot. The lock covers the other slots' scripts
// (reclaim, hand-back) but not this slot's own `up`, which can take minutes.
function withLock<T>(ws: Workspace, stack: string, out: Out, fn: () => T): T {
  const p = registryPath(ws, stack).replace(/\.json$/, ".lock");
  mkdirSync(dirname(p), { recursive: true });
  let told = false;
  for (const end = Date.now() + 15 * 60_000; ;) {
    try {
      writeFileSync(p, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder = 0;
    try {
      holder = Number.parseInt(readFileSync(p, "utf8"), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(holder) || !alive(holder)) {
      try {
        unlinkSync(p);
      } catch {
        // another waiter took it first
      }
      continue;
    }
    if (Date.now() > end) die(`${stack}'s slot registry is still held by pid ${holder} after 15 minutes`);
    if (!told) out(`waiting for ${stack}'s slot registry, held by pid ${holder}`);
    told = true;
    sleep(500);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(p);
    } catch {
      // gone already
    }
  }
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

const repoOf = (ws: Workspace, key: string): Repo => ws.config.repos[key] as Repo;

// A stack's own worktree for one repo and slot: detached at origin/<base>, holding the place of a
// repo that no work item in the slot brings.
export const ownWorktree = (ws: Workspace, stack: string, repo: string, slot: number) =>
  realpathLoose(worktreePath(repoOf(ws, repo).path, `${stack}-s${slot}`));

function isOwn(ws: Workspace, stack: string, repo: string, wt: string): boolean {
  const rest = basename(wt).slice(stack.length + 2);
  return basename(wt).startsWith(`${stack}-s`) && /^\d+$/.test(rest) && dirname(wt) === dirname(ownWorktree(ws, stack, repo, 0));
}

// A worktree is named after its work item, and the item's record names the builder.
const ownerOf = (ws: Workspace, wt: string) => loadRec(ws, basename(wt))?.agent ?? null;

export type SlotKind = "reserved" | "free" | "vanished" | "own" | "held";

export interface SlotView {
  slot: number;
  kind: SlotKind;
  entry: SlotEntry | null;
  ticket: string | null;
  agent: string | null;
}

// Vanished: every work item's worktree in it is gone, or, with none, every worktree is. Own: only
// the stack's own worktrees, which any builder may take over.
export function viewSlot(ws: Workspace, stack: Stack, reg: Registry, slot: number): SlotView {
  const v: SlotView = { slot, kind: "free", entry: reg.slots[String(slot)] ?? null, ticket: null, agent: null };
  if (stack.reserve.includes(slot)) return { ...v, kind: "reserved", entry: null };
  if (!v.entry) return v;
  const all = Object.entries(v.entry.worktrees);
  const items = all.filter(([r, wt]) => !isOwn(ws, stack.key, r, wt));
  const gone = ([, wt]: [string, string]) => !isDir(wt);
  if (items.length ? items.every(gone) : all.every(gone)) return { ...v, kind: "vanished" };
  if (!items.length) return { ...v, kind: "own" };
  const wt = items.find((x) => !gone(x))![1];
  return { ...v, kind: "held", ticket: basename(wt), agent: ownerOf(ws, wt) };
}

export function describe(v: SlotView, human: string): string {
  switch (v.kind) {
    case "reserved": return `reserved, ${human}'s own`;
    case "free": return "free";
    case "vanished": return "its worktree was removed; the next up reclaims it";
    case "own": return "the stack's own worktrees, idle";
    case "held": return `${v.ticket}, ${v.agent ?? "no builder"}'s`;
  }
}

const slotsOf = (stack: Stack) => Array.from({ length: stack.slots + 1 }, (_, i) => i);

function placementOf(ws: Workspace, stack: Stack, reg: Registry, slot: number): Placement {
  if (stack.reserve.includes(slot)) return Object.fromEntries(stack.repos.map((r) => [r, realpathLoose(repoOf(ws, r).path)]));
  return reg.slots[String(slot)]?.worktrees ?? {};
}

const samePlacement = (a: Placement, b: Placement) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([r, wt]) => b[r] === wt);

const showPlacement = (p: Placement) => Object.entries(p).map(([r, wt]) => `${r}=${basename(wt)}`).join(" ");

// ---------------------------------------------------------------- who is asking

export interface Caller {
  repo: string;
  wt: string;
  ticket: string;
  agent: string | null;
  checkout: boolean;
}

// The repo and worktree a directory is in, if it is one of the workspace's repos.
export function callerAt(ws: Workspace, cwd: string): Caller | null {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common.status !== 0) return null;
  const repoDir = realpathLoose(dirname(common.stdout.trim()));
  const repo = Object.values(ws.config.repos).find((r) => realpathLoose(r.path) === repoDir);
  if (!repo) return null;
  const wt = realpathLoose(git(cwd, "rev-parse", "--show-toplevel").stdout.trim());
  const ticket = basename(wt);
  const checkout = wt === repoDir;
  return { repo: repo.key, wt, ticket, agent: checkout ? null : ownerOf(ws, wt), checkout };
}

function stackFor(ws: Workspace, want: string | undefined, caller: Caller | null): Stack {
  const all = Object.values(ws.config.stacks);
  if (want) {
    const s = ws.config.stacks[want] ?? die(`no stack ${want}; stacks: ${all.map((x) => x.key).join(", ") || "none"}`);
    if (caller && !s.repos.includes(caller.repo)) die(`${want} does not serve ${caller.repo}, which ${caller.wt} is a worktree of`);
    return s;
  }
  if (caller) {
    const fits = all.filter((s) => s.repos.includes(caller.repo));
    const rec = loadRec(ws, caller.ticket);
    const agentStack = ws.config.agents.find((a) => a.name === caller.agent)?.stack;
    const named = [rec?.stack, agentStack].find((k) => fits.some((s) => s.key === k));
    if (named) return ws.config.stacks[named] as Stack;
    if (fits.length === 1) return fits[0] as Stack;
    if (!fits.length) die(`no stack serves ${caller.repo}`);
    die(`${caller.repo} is in stacks ${fits.map((s) => s.key).join(", ")}; say which with --stack`);
  }
  if (all.length === 1) return all[0] as Stack;
  return die(all.length ? `say which stack with --stack: ${all.map((s) => s.key).join(", ")}` : "factory.toml has no stacks");
}

function checkSlot(stack: Stack, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot > stack.slots) die(`${stack.key} has slots 0 to ${stack.slots}, not ${slot}`);
}

function refuseReserved(ws: Workspace, stack: Stack, slot: number): void {
  if (stack.reserve.includes(slot))
    die(`${stack.key} slot ${slot} is reserved: it is ${ws.config.human.name}'s own, and the factory never starts, stops or destroys it`);
}

// ---------------------------------------------------------------- allocation and placement

// The work item's worktree in every repo of the stack: the one the command ran from, and any
// sibling under the same name in the stack's other repos.
function itemWorktrees(ws: Workspace, stack: Stack, caller: Caller): Placement {
  const p: Placement = { [caller.repo]: caller.wt };
  for (const r of stack.repos) {
    if (r === caller.repo) continue;
    const wt = realpathLoose(worktreePath(repoOf(ws, r).path, caller.ticket));
    if (isDir(wt) && registeredWorktrees(repoOf(ws, r).path).has(wt)) p[r] = wt;
  }
  return p;
}

interface Choice {
  slot: number;
  how: string;
}

// In order: the item's existing slot, the builder's pinned slot, a free slot, a slot whose worktree
// vanished, then one held only by the stack's own idle worktrees. A slot pinned to another builder
// is never offered, and a reserved one never at all.
export function allocate(ws: Workspace, stack: Stack, reg: Registry, item: Placement, from: string | null, agent: string | null, want?: number): Choice {
  const pinnedTo = (n: number) => Object.keys(stack.pin).find((a) => stack.pin[a] === n) ?? null;
  const view = (n: number) => viewSlot(ws, stack, reg, n);
  const heldBy = (v: SlotView) => `${stack.key} slot ${v.slot} holds ${v.ticket}, ${v.agent ?? "which no builder's record names"}${v.agent ? "'s" : ""}`;
  if (want !== undefined) {
    checkSlot(stack, want);
    refuseReserved(ws, stack, want);
    const v = view(want);
    const pin = pinnedTo(want);
    if (agent && pin && pin !== agent) die(`${stack.key} slot ${want} is pinned to ${pin}`);
    if (v.kind === "held" && (agent === null || v.agent !== agent)) die(`${heldBy(v)}. Destroy it first if it is done with.`);
    return { slot: want, how: "asked for" };
  }
  if (agent === null) die("give --slot N for a slot of the base branches");
  const open = (n: number) => !stack.reserve.includes(n) && (pinnedTo(n) ?? agent) === agent;
  const holds = (n: number) => Object.entries(reg.slots[String(n)]?.worktrees ?? {}).filter(([r, wt]) => item[r] === wt).map(([r]) => r);
  const existing = slotsOf(stack).filter((n) => open(n) && holds(n).length)
    .sort((a, b) => Number(from !== null && holds(b).includes(from)) - Number(from !== null && holds(a).includes(from)) || a - b);
  if (existing.length) return { slot: existing[0] as number, how: "its slot" };
  const pin = stack.pin[agent];
  if (pin !== undefined) {
    const v = view(pin);
    if (v.kind === "held" && v.agent !== agent) die(`${agent}'s pinned slot: ${heldBy(v)}. Move that item to its own builder's slot first.`);
    return { slot: pin, how: "pinned" };
  }
  for (const [kind, how] of [["free", "free"], ["vanished", "reclaimed"], ["own", "taken over from the stack's own worktrees"]] as const) {
    const n = slotsOf(stack).find((x) => open(x) && view(x).kind === kind);
    if (n !== undefined) return { slot: n, how };
  }
  const taken = slotsOf(stack).filter((n) => !stack.reserve.includes(n)).map((n) => `  slot ${n}: ${describe(view(n), ws.config.human.name)}`);
  return die(`every slot of ${stack.key} open to ${agent} is taken. Free one with \`factory stack destroy --stack ${stack.key} --slot N\`.\n${taken.join("\n")}`);
}

// Each repo's place in the slot: the item's worktree where it has one, else the stack's own. A
// place held by another builder's work is never taken over.
export function place(ws: Workspace, stack: Stack, reg: Registry, slot: number, item: Placement, ticket: string | null, agent: string | null): Placement {
  const v = viewSlot(ws, stack, reg, slot);
  const cur = v.kind === "vanished" ? {} : (v.entry?.worktrees ?? {});
  const own = (r: string) => ownWorktree(ws, stack.key, r, slot);
  const p: Placement = {};
  for (const r of stack.repos) {
    const c = cur[r];
    if (c && c !== item[r] && isDir(c) && !isOwn(ws, stack.key, r, c)) {
      const a = ownerOf(ws, c);
      if (a && a !== agent) die(`${stack.key} slot ${slot}'s ${r} place holds ${c}, which is ${a}'s. Move it into ${a}'s slot first.`);
    }
    p[r] = item[r] ?? (c && isDir(c) && ticket !== null && basename(c) === ticket ? c : own(r));
  }
  return p;
}

// Slots other than the target that hold one of the item's worktrees, each with that repo's place
// handed back to the slot's own worktree. Otherwise the old slot would go on serving the worktree
// against the data of the slot it left.
export function handBacks(ws: Workspace, stack: Stack, reg: Registry, slot: number, item: Placement): Map<number, Placement> {
  const moves = new Map<number, Placement>();
  for (const [k, e] of Object.entries(reg.slots)) {
    const s = Number(k);
    if (s === slot) continue;
    for (const [r, wt] of Object.entries(e.worktrees))
      if (item[r] === wt) moves.set(s, { ...(moves.get(s) ?? e.worktrees), [r]: ownWorktree(ws, stack.key, r, s) });
  }
  return moves;
}

// Create the stack's own worktree, or move it to origin/<base> when that loses nothing.
function ensureOwn(repo: Repo, wt: string, out: Out): void {
  const fetch = () => git(repo.path, ...HTTPS, "fetch", "-q", "origin", repo.base).status === 0;
  const base = `origin/${repo.base}`;
  if (!isDir(wt)) {
    if (!fetch()) out(`  could not fetch ${repo.key}; ${basename(wt)} starts from the ${base} it already has`);
    git(repo.path, "worktree", "prune");
    mkdirSync(dirname(wt), { recursive: true });
    const r = git(repo.path, "worktree", "add", "-q", "--detach", wt, base);
    if (r.status !== 0) die(`could not create ${wt}: ${r.stderr.trim()}`);
    out(`  created ${wt} at ${base}`);
    return;
  }
  if (!registeredWorktrees(repo.path).has(wt)) die(`${wt} exists but is not a git worktree. Remove or rename it, then run up again.`);
  const old = git(wt, "rev-parse", "HEAD").stdout.trim();
  const branch = git(wt, "branch", "--show-current").stdout.trim();
  const why = branch ? `it is on branch ${branch}`
    : git(wt, "status", "--porcelain", "--untracked-files=no").stdout.trim() ? "it has uncommitted changes"
    : git(wt, "rev-list", "-1", "HEAD", "--not", "--remotes=origin").stdout.trim() ? "it has commits no origin branch has"
    : "";
  if (why) {
    out(`  ${wt} stays at ${old.slice(0, 8)}, not ${base}: ${why}`);
    return;
  }
  if (!fetch()) out(`  could not fetch ${repo.key}; ${basename(wt)} goes to the ${base} it already has`);
  const target = git(repo.path, "rev-parse", "--verify", "-q", base).stdout.trim();
  if (!target || target === old) return;
  const co = git(wt, "checkout", "-q", "--detach", base);
  if (co.status !== 0) out(`  ${wt} stays at ${old.slice(0, 8)}: checkout of ${base} failed: ${co.stderr.trim()}`);
  else out(`  ${wt} moved from ${old.slice(0, 8)} to ${target.slice(0, 8)}, ${base}`);
}

function ensureOwnAll(ws: Workspace, stack: Stack, slot: number, p: Placement, out: Out): void {
  for (const [r, wt] of Object.entries(p)) if (wt === ownWorktree(ws, stack.key, r, slot)) ensureOwn(repoOf(ws, r), wt, out);
}

function mustRun(ws: Workspace, stack: Stack, slot: number, p: Placement, verb: "up" | "down" | "destroy", after = ""): void {
  const r = callScript(ws, stack, slot, p, verb, true);
  if (r.status !== 0) die(failed(stack, slot, verb, r) + after);
}

// ---------------------------------------------------------------- the verbs

export interface Where {
  cwd: string;
  stack?: string;
  slot?: number;
}

// Bring up the slot of the work item whose worktree `cwd` is, or with --slot and no worktree, a
// slot of the stack's own worktrees on the base branches.
export function stackUp(ws: Workspace, w: Where, out: Out = console.log): void {
  const at = callerAt(ws, w.cwd);
  if (at?.checkout && w.slot === undefined)
    die(`${at.wt} is ${ws.config.human.name}'s checkout, not a work item's worktree. Give --slot N for a slot of the base branches.`);
  const caller = at && !at.checkout ? at : null;
  if (caller) {
    const ag = ws.config.agents.find((a) => a.name === caller.agent);
    if (!caller.agent) die(`${caller.wt} is no builder's: state/${caller.ticket}.json is missing or names no agent. A slot goes only to a builder's work item.`);
    if (!ag || ag.role !== "builder") die(`${caller.ticket} is recorded to ${caller.agent}, who is not a builder`);
  } else if (w.slot === undefined) die("run `factory stack up` from a work item's worktree, or give --slot N for a slot of the base branches");
  const stack = stackFor(ws, w.stack, caller);
  const item = caller ? itemWorktrees(ws, stack, caller) : {};
  const { slot, placement } = withLock(ws, stack.key, out, () => {
    const reg = loadRegistry(ws, stack.key);
    const choice = allocate(ws, stack, reg, item, caller?.repo ?? null, caller?.agent ?? null, w.slot);
    const n = choice.slot;
    const v = viewSlot(ws, stack, reg, n);
    const plan = place(ws, stack, reg, n, item, caller?.ticket ?? null, caller?.agent ?? null);
    out(`${stack.key} slot ${n} (${choice.how}): ${showPlacement(plan)}`);
    if (v.kind === "vanished") {
      out(`  reclaiming slot ${n}: its worktree was removed, so destroy drops what it left`);
      mustRun(ws, stack, n, v.entry!.worktrees, "destroy");
      delete reg.slots[String(n)];
      saveRegistry(ws, stack.key, reg);
    }
    for (const [s, back] of handBacks(ws, stack, reg, n, item)) {
      const e = reg.slots[String(s)] as SlotEntry;
      out(`  slot ${s} takes back its own worktree: ${showPlacement(back)}`);
      mustRun(ws, stack, s, e.worktrees, "down");
      ensureOwnAll(ws, stack, s, back, out);
      reg.slots[String(s)] = { created: e.created, worktrees: back };
      saveRegistry(ws, stack.key, reg);
      mustRun(ws, stack, s, back, "up", `\nslot ${s} did not come back up on its own worktrees`);
    }
    const prev = reg.slots[String(n)];
    if (prev && !samePlacement(prev.worktrees, plan)) mustRun(ws, stack, n, prev.worktrees, "down");
    ensureOwnAll(ws, stack, n, plan, out);
    reg.slots[String(n)] = { created: prev?.created ?? now(), worktrees: plan };
    saveRegistry(ws, stack.key, reg);
    exportStacks(ws);
    return { slot: n, placement: plan };
  });
  mustRun(ws, stack, slot, placement, "up", `\nThe slot stays placed. Fix it and run up again, or free it with \`factory stack destroy\`.`);
  const u = callScript(ws, stack, slot, placement, "url");
  out(`${stack.key} slot ${slot} up${u.status === 0 && u.stdout.trim() ? `: ${u.stdout.trim()}` : ""}`);
}

interface Resolved {
  stack: Stack;
  slot: number;
  caller: Caller | null;
}

// --slot N, or the slot holding the worktree `cwd` is in.
function resolveSlot(ws: Workspace, w: Where): Resolved {
  const at = callerAt(ws, w.cwd);
  const caller = at && !at.checkout ? at : null;
  const stack = stackFor(ws, w.stack, caller);
  if (w.slot !== undefined) {
    checkSlot(stack, w.slot);
    return { stack, slot: w.slot, caller };
  }
  if (!caller) die("give --slot N, or run it from a worktree that holds a slot");
  const reg = loadRegistry(ws, stack.key);
  const hit = Object.entries(reg.slots).find(([, e]) => Object.values(e.worktrees).includes(caller.wt));
  if (!hit) die(`${caller.wt} holds no slot of ${stack.key}; \`factory stack up\` gives it one`);
  return { stack, slot: Number(hit[0]), caller };
}

// A builder acts on its own slot, or on one no builder holds.
function refuseOthers(ws: Workspace, r: Resolved, reg: Registry): void {
  refuseReserved(ws, r.stack, r.slot);
  const v = viewSlot(ws, r.stack, reg, r.slot);
  if (r.caller?.agent && v.kind === "held" && v.agent !== r.caller.agent)
    die(`${r.stack.key} slot ${r.slot} holds ${v.ticket}, ${v.agent ?? "no builder"}'s, not ${r.caller.agent}'s`);
}

export function stackDown(ws: Workspace, w: Where, out: Out = console.log): void {
  const r = resolveSlot(ws, w);
  const reg = loadRegistry(ws, r.stack.key);
  refuseOthers(ws, r, reg);
  const e = reg.slots[String(r.slot)];
  if (!e) die(`${r.stack.key} slot ${r.slot} is free; nothing runs there`);
  mustRun(ws, r.stack, r.slot, e.worktrees, "down");
  out(`${r.stack.key} slot ${r.slot} down. Its data is kept; \`factory stack up\` brings it back.`);
}

export function stackDestroy(ws: Workspace, w: Where, out: Out = console.log): void {
  const r = resolveSlot(ws, w);
  withLock(ws, r.stack.key, out, () => {
    const reg = loadRegistry(ws, r.stack.key);
    refuseOthers(ws, r, reg);
    mustRun(ws, r.stack, r.slot, reg.slots[String(r.slot)]?.worktrees ?? {}, "destroy");
    delete reg.slots[String(r.slot)];
    saveRegistry(ws, r.stack.key, reg);
    exportStacks(ws);
  });
  out(`${r.stack.key} slot ${r.slot} destroyed and free. Its worktrees are kept.`);
}

export function stackUrl(ws: Workspace, w: Where, out: Out = console.log): void {
  const r = resolveSlot(ws, w);
  const res = callScript(ws, r.stack, r.slot, placementOf(ws, r.stack, loadRegistry(ws, r.stack.key), r.slot), "url");
  if (res.status !== 0) die(failed(r.stack, r.slot, "url", res));
  out(res.stdout.trim());
}

// ---------------------------------------------------------------- status and the board's export

export interface Site {
  stack: string;
  slot: number;
  name: string;
  worktree: string;
  url: string;
  health: string;
}

function sitesOf(ws: Workspace, stack: Stack, reg: Registry, slot: number, warn: Out): Site[] {
  const p = placementOf(ws, stack, reg, slot);
  const r = callScript(ws, stack, slot, p, "status");
  if (r.status !== 0) {
    warn(failed(stack, slot, "status", r));
    return [];
  }
  const sites: Site[] = [];
  for (const line of r.stdout.split("\n")) {
    const [name, url, health] = line.split("\t").map((f) => f.trim());
    if (!name || !url || name.startsWith("#")) continue;
    // a site named after a repo is that repo's worktree; any other is the stack's first repo's
    const worktree = p[name] ?? p[stack.repos[0] as string] ?? "-";
    sites.push({ stack: stack.key, slot, name, worktree, url, health: health || url });
  }
  return sites;
}

// Every slot of every stack with a script, one row per site, for the board: stack, slot, name,
// worktree ("-" for a free slot), url, health url.
export function exportStacks(ws: Workspace, warn: Out = console.error): Site[] {
  const sites: Site[] = [];
  for (const stack of Object.values(ws.config.stacks)) {
    if (!stack.script) continue;
    const reg = loadRegistry(ws, stack.key);
    for (const n of slotsOf(stack)) sites.push(...sitesOf(ws, stack, reg, n, warn));
  }
  const clean = (s: string | number) => String(s).replace(/[\t\r\n]/g, " ");
  const text = sites.map((s) => [s.stack, s.slot, s.name, s.worktree, s.url, s.health].map(clean).join("\t") + "\n").join("");
  const f = stacksFile(ws);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", text);
  renameSync(f + ".tmp", f);
  return sites;
}

export function stackStatus(ws: Workspace, w: Where, out: Out = console.log): void {
  if (w.slot !== undefined) {
    const r = resolveSlot(ws, w);
    for (const s of sitesOf(ws, r.stack, loadRegistry(ws, r.stack.key), r.slot, console.error)) out(`${s.name}\t${s.url}\t${s.health}`);
    return;
  }
  const keys = w.stack ? [stackFor(ws, w.stack, null).key] : Object.keys(ws.config.stacks);
  const sites = exportStacks(ws);
  if (!keys.length) out("no stacks in factory.toml");
  for (const key of keys) {
    const stack = ws.config.stacks[key] as Stack;
    const reg = loadRegistry(ws, key);
    out(`${key}${stack.script ? "" : " (no script)"}`);
    for (const n of slotsOf(stack)) {
      const v = viewSlot(ws, stack, reg, n);
      const p = v.entry ? `  ${showPlacement(v.entry.worktrees)}` : "";
      out(`  slot ${n}  ${describe(v, ws.config.human.name)}${p}`);
      for (const s of sites.filter((x) => x.stack === key && x.slot === n)) out(`    ${s.name.padEnd(10)} ${s.url}`);
    }
  }
}

// The stack's own needs on the machine, asked of every slot, since hostnames and ports differ per
// slot. A check that reads the same for every slot is printed once.
export function stackDoctor(ws: Workspace, w: Where): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  const keys = w.stack ? [stackFor(ws, w.stack, null).key] : Object.keys(ws.config.stacks);
  for (const key of keys) {
    const stack = ws.config.stacks[key] as Stack;
    if (!stack.script) continue;
    const reg = loadRegistry(ws, key);
    const seen = new Set<string>();
    for (const n of w.slot !== undefined ? [w.slot] : slotsOf(stack)) {
      checkSlot(stack, n);
      const r = callScript(ws, stack, n, placementOf(ws, stack, reg, n), "doctor");
      const said = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (r.status !== 0 && !said.some((l) => l.startsWith("MISSING"))) said.push(`MISSING ${failed(stack, n, "doctor", r).replace(/\n/g, " ")}`);
      for (const l of said) {
        if (l.startsWith("MISSING")) ok = false;
        if (!seen.has(l)) lines.push(`${key}: ${l}`);
        seen.add(l);
      }
    }
  }
  return { lines, ok };
}
