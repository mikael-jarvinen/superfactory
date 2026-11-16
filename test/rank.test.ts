import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { serve } from "../src/board/server.js";
import type { Actor } from "../src/tickets/guard.js";
import { between, compare, isRank, ordered, spread } from "../src/tickets/rank.js";
import * as T from "../src/tickets/store.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

const LOCAL = `${TOML.replace(/\[tracker\][\s\S]*?done = "Done"\n/, "")}
[tracker]
kind = "local"

[[tracker.projects]]
key = "RPE"
name = "RPE Training App"
`;
const IMPORT: Actor = { human: false, name: "plane", importer: true };
const keys = (ws: ReturnType<typeof openWorkspace>) => ordered(T.list(ws)).map((t) => t.key);
// Tickets RPE-1.. with these updated times, and these states or Backlog.
function seeded(times: string[], states: T.TicketState[] = []) {
  const ws = openWorkspace(tempWorkspace(LOCAL));
  times.forEach((t, i) => T.create(ws, { project: "RPE", number: i + 1, t, title: `t${i + 1}`, state: states[i] ?? "Backlog", source: { system: "plane" } }, IMPORT));
  return ws;
}

test("rank: between is strictly between, spread is in order, and neither ends in 0", () => {
  const cases: [string, string | null][] = [["", null], ["", "1"], ["1", "2"], ["z", null], ["", "01"], ["0z", "1"], ["a", "a1"], ["az", "b"], ["i", "i01"]];
  for (const [lo, hi] of cases) {
    const m = between(lo, hi);
    assert.ok(isRank(m), `${lo}..${hi} -> ${m}`);
    assert.ok(m > lo && (hi === null || m < hi), `${lo}..${hi} -> ${m}`);
  }
  // a thousand drops into the same gap stay in order
  let lo = "", hi: string | null = "1";
  for (let i = 0; i < 1000; i++) {
    const m = between(lo, hi);
    assert.ok(isRank(m) && m > lo && m < (hi as string), `${lo}..${hi} -> ${m}`);
    if (i % 2) lo = m;
    else hi = m;
  }
  assert.ok(lo.length < 300, `${lo.length} characters`);
  const s = spread("", null, 337);
  assert.equal(new Set(s).size, 337);
  assert.deepEqual([...s].sort(), s);
  assert.ok(s.every(isRank) && s.every((r) => r.length <= 2));
  assert.deepEqual(spread("a", "b", 0), []);
  assert.ok(!isRank("a0") && !isRank("") && !isRank("A") && !isRank(3));
});

test("rank: open tickets by rank, then unranked longest-waiting first, then closed newest first", () => {
  const tk = (key: string, updated: string, state = "Todo", rank?: string) => ({ key, updated, state, ...(rank ? { rank } : {}) });
  const list = [tk("RPE-1", "2026-03-01"), tk("RPE-2", "2026-01-01"), tk("RPE-3", "2026-05-01", "Backlog", "m"), tk("RPE-4", "2026-01-01", "Todo", "c"),
    tk("RPE-5", "2026-01-01"), tk("RPE-6", "2026-02-01", "Done", "a"), tk("RPE-7", "2026-04-01", "Cancelled"), tk("RPE-8", "2026-03-01", "Done")];
  assert.deepEqual(ordered(list).map((t) => t.key), ["RPE-4", "RPE-3", "RPE-2", "RPE-5", "RPE-1", "RPE-7", "RPE-8", "RPE-6"]);
  assert.equal(compare(list[0]!, list[0]!), 0);
});

test("store: rank places a ticket, ranks the unranked rows above it in place, and leaves updated alone", () => {
  const ws = seeded(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"]);
  assert.deepEqual(keys(ws), ["RPE-1", "RPE-2", "RPE-3", "RPE-4"]);
  const was = T.load(ws, "RPE-4").updated;
  T.rank(ws, "RPE-4", { before: "RPE-1" }, "Alex");
  assert.deepEqual(keys(ws), ["RPE-4", "RPE-1", "RPE-2", "RPE-3"]);
  assert.equal(T.load(ws, "RPE-4").updated, was);
  assert.equal(T.load(ws, "RPE-1").rank, undefined, "a drop at the top ranks nothing else");
  // dropped below an unranked row: the rows above it keep their place by taking ranks
  T.rank(ws, "RPE-1", { after: "RPE-3" }, "Alex");
  assert.deepEqual(keys(ws), ["RPE-4", "RPE-2", "RPE-3", "RPE-1"]);
  assert.ok(T.list(ws).every((t) => isRank(t.rank)));
  T.rank(ws, "RPE-1", { after: "RPE-4" }, "Alex");
  assert.deepEqual(keys(ws), ["RPE-4", "RPE-1", "RPE-2", "RPE-3"]);
  assert.throws(() => T.rank(ws, "RPE-1", { after: "RPE-1" }, "Alex"), /next to itself/);
  assert.throws(() => T.rank(ws, "RPE-1", { after: "RPE-9" }, "Alex"), /no ticket RPE-9/);
  assert.throws(() => T.rank(ws, "RPE-1", {}, "Alex"), /after or before/);
});

test("store: closed tickets are never ranked, by a drop or a seed, and cannot be placed", () => {
  const ws = seeded(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z", "2026-01-05T00:00:00Z"],
    ["Cancelled", "Todo", "Done", "Todo", "Todo"]);
  const closed = () => T.list(ws).filter((t) => t.state === "Done" || t.state === "Cancelled");
  // a drop below the last unranked open row ranks the open rows above it, and no closed one
  T.rank(ws, "RPE-2", { after: "RPE-5" }, "Alex");
  assert.deepEqual(keys(ws), ["RPE-4", "RPE-5", "RPE-2", "RPE-3", "RPE-1"]);
  assert.equal(closed().length, 2);
  assert.ok(closed().every((t) => t.rank === undefined));
  assert.throws(() => T.rank(ws, "RPE-1", { after: "RPE-2" }, "Alex"), /RPE-1 is Cancelled/);
  assert.throws(() => T.rank(ws, "RPE-2", { after: "RPE-1" }, "Alex"), /RPE-1 is Cancelled/);
  assert.deepEqual(T.seedRanks(ws, ["RPE-1", "RPE-2", "RPE-3", "RPE-4"], "plane"), []);
  assert.ok(closed().every((t) => t.rank === undefined));
});

test("store: closing a ticket drops its rank, so a reopened one comes back at the bottom", async () => {
  const ws = seeded(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"], ["Todo", "Todo", "Todo"]);
  T.seedRanks(ws, ["RPE-3", "RPE-1", "RPE-2"], "plane");
  assert.deepEqual(keys(ws), ["RPE-3", "RPE-1", "RPE-2"]);
  await T.move(ws, "RPE-3", "Cancelled", { human: true, name: "Alex" });
  assert.equal(T.load(ws, "RPE-3").rank, undefined);
  // a rank event that lands after the close, as from a drop that raced it, is not taken
  appendFileSync(join(T.projectDir(ws, "RPE"), "RPE-3.jsonl"), JSON.stringify({ t: "2026-06-01T00:00:00Z", by: "Alex", op: "rank", rank: "1" }) + "\n");
  assert.equal(T.load(ws, "RPE-3").rank, undefined);
  await T.move(ws, "RPE-3", "Todo", { human: true, name: "Alex" });
  assert.deepEqual(keys(ws), ["RPE-1", "RPE-2", "RPE-3"]);
});

test("store: an anchor load() finds but the order leaves out is refused, and nothing is written", () => {
  const ws = seeded(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]);
  // Stands in for an anchor that closed between the check and list(): a ticket in a project the
  // workspace does not configure, which load() reads but list() leaves out.
  const web = join(T.trackerDir(ws), "tickets", "WEB");
  mkdirSync(web, { recursive: true });
  copyFileSync(join(T.projectDir(ws, "RPE"), "RPE-1.jsonl"), join(web, "WEB-1.jsonl"));
  const logs = () => [T.projectDir(ws, "RPE"), web].flatMap((d) => readdirSync(d).map((f) => readFileSync(join(d, f), "utf8")));
  const was = logs();
  assert.throws(() => T.rank(ws, "RPE-3", { after: "WEB-1" }, "Alex"), /WEB-1 is not in the order \(closed, or in a project this workspace does not list\); place RPE-3 next to another open ticket/);
  assert.throws(() => T.rank(ws, "RPE-3", { before: "WEB-1" }, "Alex"), /WEB-1 is not in the order/);
  assert.deepEqual(logs(), was);
  assert.deepEqual(keys(ws), ["RPE-1", "RPE-2", "RPE-3"]);
});

test("rank: ties go by project, then number, so RPE-9 comes before RPE-10", () => {
  const tk = (key: string) => ({ key, updated: "2026-01-01", state: "Todo" });
  assert.deepEqual(ordered([tk("RPE-10"), tk("WEB-2"), tk("RPE-9")]).map((t) => t.key), ["RPE-9", "RPE-10", "WEB-2"]);
});

test("store: seedRanks ranks only the unranked, after the ranked, and a second run changes nothing", () => {
  const ws = seeded(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"]);
  T.rank(ws, "RPE-2", { before: "RPE-1" }, "Alex");
  assert.deepEqual(T.seedRanks(ws, ["RPE-4", "RPE-2", "RPE-1", "RPE-9"], "plane"), ["RPE-4", "RPE-1"]);
  assert.deepEqual(keys(ws), ["RPE-2", "RPE-4", "RPE-1", "RPE-3"]);
  assert.deepEqual(T.seedRanks(ws, ["RPE-4", "RPE-1"], "plane"), []);
  assert.deepEqual(keys(ws), ["RPE-2", "RPE-4", "RPE-1", "RPE-3"]);
});

test("the board and the CLI list in the one order, and both can rank", async () => {
  const ws = seeded(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]);
  const board = await serve(ws, { port: 0, host: "127.0.0.1", reviews: async () => "{}" });
  after(() => board.close());
  const post = async (p: string, b: unknown) => {
    const r = await fetch(board.url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const listed = async () => ((await (await fetch(board.url + "/api/tickets")).json()) as { tickets: { key: string; rank?: string }[] }).tickets.map((t) => t.key);
  assert.deepEqual(await listed(), ["RPE-1", "RPE-2", "RPE-3"]);
  const r = await post("/api/tickets/RPE-3", { op: "rank", after: null, before: "RPE-1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((r.body.ticket as T.Ticket).rank !== undefined, true);
  assert.deepEqual(await listed(), ["RPE-3", "RPE-1", "RPE-2"]);
  assert.equal((await post("/api/tickets/RPE-3", { op: "rank" })).status, 400);

  const cli = (args: string[]) => {
    const out = factory(ws.dir, args);
    assert.equal(out.status, 0, `${args.join(" ")}: ${out.stderr}`);
    return out.stdout;
  };
  cli(["ticket", "rank", "RPE-2", "--before", "RPE-3"]);
  const json = JSON.parse(cli(["ticket", "list", "--json"])) as { key: string }[];
  assert.deepEqual(json.map((t) => t.key), ["RPE-2", "RPE-3", "RPE-1"]);
  assert.deepEqual(await listed(), ["RPE-2", "RPE-3", "RPE-1"]);
});
