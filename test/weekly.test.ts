import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { ACCOUNT, refreshHosts, type Read, TranscriptUsage } from "../src/board/analytics.js";
import { type Keychain, keychainItem, oauthUsage, PlanUsage, type Sample } from "../src/board/plan-usage.js";
import type { Runner } from "../src/board/remote-transcripts.js";
import { serve } from "../src/board/server.js";
import { costOf, WEEK, weekly } from "../src/board/weekly.js";
import { openWorkspace } from "../src/workspace.js";
import { tempDir, tempWorkspace, TOML } from "./helpers.js";

const HOUR = 3_600_000;
// A reset on a Wednesday at 11:00 UTC; now is a day and a half after the next one.
const R0 = Date.parse("2026-11-04T11:00:00Z");
const NOW = R0 + 3 * WEEK + 36 * HOUR;
const iso = (t: number) => new Date(t).toISOString();

const call = (t: number, id: string, model: string, u: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", timestamp: iso(t), requestId: `req_${id}`, message: { id, model, role: "assistant", content: [{ type: "text", text: "x" }], usage: u } });
// What Claude Code writes when the weekly limit refuses a call: a synthetic message with no tokens.
const refusal = (t: number, resets: number) =>
  JSON.stringify({
    type: "assistant", timestamp: iso(t), message: { id: `r${t}`, model: "<synthetic>", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    apiError: "usage_limit_reached", error: "rate_limit",
    quotaLimits: { status: "rejected", resetsAt: resets / 1000, rateLimitType: "seven_day" },
  });
const opusOut = (n: number) => ({ output_tokens: n }); // $20 per million

test("a call is priced by its model and token type, an hour's cache write apart from five minutes'", () => {
  const c = (model: string | null, tokens: Partial<Record<"input" | "output" | "cache_read" | "cache_write", number>>, write_1h = 0) =>
    costOf({ at: 0, id: "x", model, write_1h, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, ...tokens } });
  assert.equal(c("claude-opus-5-5", { input: 1e6, output: 1e6, cache_read: 1e6 }), 4 + 20 + 0.2);
  assert.equal(c("claude-opus-5-5", { cache_write: 3e6 }, 1e6), 2 * 5 + 8);
  assert.equal(c("claude-haiku-5-5", { output: 1e6 }), 0.5);
  assert.equal(c("claude-sonnet-5-5", { output: 1e6 }), 10);
  assert.equal(c("claude-fable-5-2", { output: 1e6 }), 40);
  assert.equal(c("claude-fable-5-1", { output: 1e6 }), 50);
  assert.equal(c("something-new", { output: 1e6 }), 20, "an unknown model is priced as Opus");
  assert.equal(c("<synthetic>", {}), 0);
});

test("transcripts keep each call's model and hour-long cache writes, and the weekly limit's refusals", () => {
  const cfg = tempDir();
  const dir = join(cfg, "projects", "-x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), [
    call(R0 + HOUR, "m1", "claude-sonnet-5-5", { input_tokens: 5, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 20 } }),
    call(R0 + HOUR, "m1", "claude-sonnet-5-5", { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 20 } }),
    refusal(R0 + 2 * HOUR, R0 + WEEK),
    // a five-hour refusal is not the weekly limit
    refusal(R0 + 3 * HOUR, R0 + 5 * HOUR).replace('"seven_day"', '"five_hour"'),
  ].join("\n") + "\n");
  const [r] = new TranscriptUsage().read(dir);
  const m1 = r!.calls.find((c) => c.id === "m1")!;
  assert.equal(m1.model, "claude-sonnet-5-5");
  assert.equal(m1.write_1h, 20);
  assert.deepEqual(m1.tokens, { input: 5, output: 9, cache_read: 0, cache_write: 30 }, "the call once, with its largest counts");
  assert.deepEqual(r!.hits, [{ at: R0 + 2 * HOUR, resets: R0 + WEEK }]);
});

// Two hit weeks before the chart's span, one in it, and calls in the current week.
function reads(): Read[] {
  const usage = new TranscriptUsage();
  const cfg = tempDir();
  const dir = join(cfg, "projects", "-a");
  mkdirSync(dir, { recursive: true });
  const lines = [
    // week 0: $100 spent, then refused
    call(R0 + 10 * HOUR, "a1", "claude-opus-5-5", opusOut(5e6)),
    refusal(R0 + 30 * HOUR, R0 + WEEK),
    refusal(R0 + 31 * HOUR, R0 + WEEK),
    // week 1: $80 spent before the refusal, $20 more after it is not counted in the limit
    call(R0 + WEEK + 5 * HOUR, "b1", "claude-opus-5-5", opusOut(4e6)),
    refusal(R0 + WEEK + 50 * HOUR, R0 + 2 * WEEK),
    call(R0 + WEEK + 90 * HOUR, "b2", "claude-opus-5-5", opusOut(1e6)),
    // week 2 (the chart's first): $120, then refused
    call(R0 + 2 * WEEK + 24 * HOUR, "c1", "claude-opus-5-5", opusOut(6e6)),
    refusal(R0 + 2 * WEEK + 48 * HOUR, R0 + 3 * WEEK),
    // the current week, the chart's third: $45 so far
    call(R0 + 3 * WEEK + 2 * HOUR, "d1", "claude-opus-5-5", opusOut(1.5e6)),
    call(R0 + 3 * WEEK + 20 * HOUR, "d2", "claude-opus-5-5", opusOut(0.75e6)),
  ];
  writeFileSync(join(dir, "s.jsonl"), lines.join("\n") + "\n");
  // a resumed session copies a call into its new transcript, and it counts once
  writeFileSync(join(dir, "t.jsonl"), lines[lines.length - 1] + "\n");
  return usage.read(dir);
}

test("the weekly estimate: the resets from a refusal, the limit from the hit weeks, and each week's running percent", () => {
  const w = weekly(reads(), [], NOW);
  assert.equal(w.end, R0 + 4 * WEEK, "the next reset after now, stepped from the latest a refusal named");
  assert.equal(w.start, R0 + WEEK);
  assert.deepEqual(w.resets, [R0 + WEEK, R0 + 2 * WEEK, R0 + 3 * WEEK, R0 + 4 * WEEK]);
  assert.deepEqual(w.weeks.map((x) => [x.start, x.hit, Math.round(x.cost)]), [
    [R0, R0 + 30 * HOUR, 100], [R0 + WEEK, R0 + WEEK + 50 * HOUR, 80], [R0 + 2 * WEEK, R0 + 2 * WEEK + 48 * HOUR, 120],
  ]);
  assert.equal(Math.round(w.limit!), 100, "the mean of the hit weeks");
  assert.equal(Math.round(w.spread! * 100), 20, "the furthest week is 20% from it");
  assert.deepEqual(w.weeks.map((x) => x.tokens), [5e6, 4e6, 6e6], "each hit week's tokens up to its refusal");
  assert.equal(w.limit_tokens, 5e6, "the limit in tokens, the mean of the same weeks");
  assert.equal(Math.round(w.token_spread! * 100), 20);
  // the tokens ride on the estimate's points, by type: input, output, cache read, cache write
  assert.equal(w.tokens.length, w.estimate.length);
  assert.deepEqual(w.tokens.map((p) => p[0]), w.estimate.map((p) => p[0]));
  assert.deepEqual(w.tokens.filter(([x]) => x === R0 + 2 * WEEK), [[R0 + 2 * WEEK, 0, 5e6, 0, 0], [R0 + 2 * WEEK, 0, 0, 0, 0]], "a week's end at its full tokens, then 0");
  assert.deepEqual(w.tokens.at(-1), [NOW, 0, 2.25e6, 0, 0]);
  const at = (t: number) => w.estimate.filter(([x]) => x === t).map(([, v]) => Math.round(v));
  assert.deepEqual(at(R0 + WEEK + 6 * HOUR), [80]);
  assert.deepEqual(at(R0 + 2 * WEEK), [100, 0], "a week's end at its full figure, and the reset back at 0");
  assert.deepEqual(at(R0 + 3 * WEEK + 21 * HOUR), [45], "the copied call counted once");
  assert.deepEqual(at(R0 + 3 * WEEK + 20 * HOUR), [30], "a point counts what was spent before its time");
  assert.deepEqual(at(R0 + 3 * WEEK + 20 * HOUR + 15 * 60_000), [45], "a point every quarter hour, so on every local midnight");
  // a hit week that started before Claude Code's cleanup may have lost its first sessions
  assert.deepEqual(weekly(reads(), [], NOW + 8 * 24 * HOUR).weeks.map((x) => x.start), [R0 + WEEK, R0 + 2 * WEEK]);
  assert.deepEqual(w.estimate.at(-1), [NOW, 45], "up to now");
  assert.deepEqual(w.hits, [R0 + WEEK + 50 * HOUR, R0 + 2 * WEEK + 48 * HOUR], "the first refusal of each week on the chart");
  assert.equal(Math.round(w.week_cost), 45);
  assert.equal(w.week_tokens, 2.25e6);
  assert.equal(w.check, null);
});

test("the plan's samples: the actual line, its reset, and what 1% cost this week", () => {
  const samples: Sample[] = [
    { at: R0 + 3 * WEEK + 1 * HOUR, percent: 2, resets_at: R0 + 4 * WEEK + 135 },
    { at: R0 + 3 * WEEK + 30 * HOUR, percent: 50, resets_at: R0 + 4 * WEEK + 135 },
    { at: R0, percent: 99, resets_at: R0 + WEEK }, // before the chart
  ];
  const w = weekly(reads(), samples, NOW, null);
  assert.deepEqual(w.actual, [[R0 + 3 * WEEK + HOUR, 2], [R0 + 3 * WEEK + 30 * HOUR, 50]]);
  assert.deepEqual(w.check, { at: R0 + 3 * WEEK + 30 * HOUR, percent: 50, cost: 45, per_percent: 0.9 });
  // with no refusals, the plan's own reset places the weeks, and with no hit week there is no estimate
  const none = weekly([], samples, NOW, "the usage endpoint answered 500");
  assert.equal(none.end, R0 + 4 * WEEK, "rounded to its minute");
  assert.equal(none.limit, null);
  assert.deepEqual(none.estimate, []);
  assert.equal(none.actual_error, "the usage endpoint answered 500");
  const nothing = weekly([], [], NOW);
  assert.equal(nothing.start, null);
});

test("the plan's figure is read with Claude Code's login, which no error and no sample holds", async () => {
  const cfg = tempDir();
  const TOKEN = "test-token";
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let answer: () => Response = () => Response.json({ seven_day: { utilization: 24, resets_at: "2026-12-02T11:00:00.135500+00:00" } });
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    return answer();
  }) as typeof fetch;
  const read = oauthUsage(() => cfg, fake, null);
  const plan = new PlanUsage(join(cfg, "samples.jsonl"));

  await plan.poll(read, () => 1000);
  assert.equal(plan.error, "there is no Claude Code login to read here");
  assert.equal(seen.length, 0, "nothing is asked without a login");

  writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + HOUR } }));
  await plan.poll(read, () => 2000);
  assert.equal(plan.error, null);
  assert.equal(seen[0]!.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(seen[0]!.headers["Authorization"], `Bearer ${TOKEN}`);
  assert.equal(seen[0]!.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.deepEqual(plan.samples(), [{ at: 2000, percent: 24, resets_at: Date.parse("2026-12-02T11:00:00.135Z") }]);

  const errors: string[] = [];
  for (const a of [() => new Response("no", { status: 401 }), () => new Response("<html>"), () => Response.json({ five_hour: {} }),
    () => { throw new TypeError(`fetch failed for ${TOKEN}`); }]) {
    answer = a;
    await plan.poll(read, () => 3000);
    errors.push(plan.error!);
  }
  assert.deepEqual(errors, [
    "the usage endpoint answered 401", "the usage endpoint's answer is not JSON",
    "the usage endpoint's answer has no weekly utilization", "the usage endpoint could not be reached (TypeError)",
  ]);
  writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() - 1 } }));
  await plan.poll(read, () => 4000);
  assert.match(plan.error!, /expired/);
  assert.equal(seen.length, 5, "an expired login is not sent");
  assert.equal(plan.samples().length, 1, "a failed poll stores nothing");
  assert.ok(!readFileSync(join(cfg, "samples.jsonl"), "utf8").includes(TOKEN));
});

test("on macOS the login is Claude Code's Keychain item, the file when there is none", async () => {
  const cfg = tempDir();
  const auth: string[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    auth.push((init.headers as Record<string, string>)["Authorization"]!);
    return Response.json({ seven_day: { utilization: 1, resets_at: "2026-12-02T11:00:00Z" } });
  }) as typeof fetch;
  const login = (t: string) => JSON.stringify({ claudeAiOauth: { accessToken: t, expiresAt: Date.now() + HOUR } });
  writeFileSync(join(cfg, ".credentials.json"), login("from-file"));
  let item: string | null = login("from-keychain");
  const read = oauthUsage(() => cfg, fake, async () => item);
  await read();
  item = null;
  await read();
  assert.deepEqual(auth, ["Bearer from-keychain", "Bearer from-file"]);
  // a Keychain that could not be read says why, when there is no file to fall back on
  const unreadable: Keychain = async () => {
    throw new Error("Claude Code's Keychain item could not be read (security exited 36)");
  };
  // the read with no file to fall back on sends nothing, and the fallback below sends one request
  const sent = auth.length;
  const none = oauthUsage(() => tempDir(), fake, unreadable);
  await assert.rejects(none(), /security exited 36/);
  // and one that could not be read still falls back on the file when there is one
  await oauthUsage(() => cfg, fake, unreadable)();
  assert.deepEqual(auth.slice(sent), ["Bearer from-file"]);

  assert.deepEqual(keychainItem({ USER: "someone" }), { service: "Claude Code-credentials", account: "someone" });
  const hash = createHash("sha256").update("/x/cfg").digest("hex").slice(0, 8);
  assert.deepEqual(keychainItem({ USER: "a b", CLAUDE_CONFIG_DIR: "/x/cfg" }), { service: `Claude Code-credentials-${hash}`, account: "claude-code-user" });
  assert.equal(keychainItem({ USER: "m", CLAUDE_CONFIG_DIR: "/x/cfg", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }).service, "Claude Code-credentials");
});

const python = (far: string, scripts: string[]): Runner => (script) =>
  new Promise((resolve, reject) => {
    scripts.push(script);
    const p = spawn("python3", ["-"], { env: { ...process.env, CLAUDE_CONFIG_DIR: far } });
    let out = "";
    p.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`python3 exited ${code}`))));
    p.stdin.end(script);
  });

test("every projects/ dir of a host is read for the weekly usage, its calls' models and refusals with it", async () => {
  const dir = tempWorkspace(`${TOML}
[hosts.far]
url = "http://127.0.0.1:9"
token_file = "token"
hash_files = ["daemon.toml", "workspace.toml"]
`);
  const ws = openWorkspace(dir);
  const far = join(dir, "far-claude");
  for (const [p, lines] of [["-home-x", [call(NOW - HOUR, "f1", "claude-haiku-5-5", { output_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 0 } })]],
    ["-home-y", [refusal(NOW - 2 * HOUR, R0 + 4 * WEEK)]]] as const) {
    mkdirSync(join(far, "projects", p), { recursive: true });
    writeFileSync(join(far, "projects", p, "s.jsonl"), lines.join("\n") + "\n");
  }
  const usage = new TranscriptUsage();
  const scripts: string[] = [];
  await refreshHosts(ws, usage, () => python(far, scripts), NOW - 6 * WEEK);
  assert.equal(scripts.length, 1, "a workspace with no items still reads its hosts for the account");
  assert.equal(usage.hostRead("far")!.error, null);
  const got = usage.account(NOW - 6 * WEEK).filter((r) => r.file.startsWith("far:"));
  assert.equal(got.length, 2);
  const calls = got.flatMap((r) => r.calls).filter((c) => c.id === "f1");
  assert.deepEqual(calls.map((c) => [c.model, c.tokens.output]), [["claude-haiku-5-5", 2e6]]);
  assert.deepEqual(got.flatMap((r) => r.hits), [{ at: NOW - 2 * HOUR, resets: R0 + 4 * WEEK }]);
  assert.equal(ACCOUNT, "*");
});

test("the weekly chart is served and drawn: two lines, the limit, and each week's Friday and Sunday", async () => {
  const cfg = tempDir();
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  after(() => (was === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = was)));
  const proj = join(cfg, "projects", "-p");
  mkdirSync(proj, { recursive: true });
  const now = Date.now();
  const reset = Math.ceil(now / WEEK) * WEEK + 11 * HOUR; // a reset ahead of now
  writeFileSync(join(proj, "s.jsonl"), [
    call(reset - 3 * WEEK + HOUR, "w1", "claude-opus-5-5", opusOut(5e6)),
    refusal(reset - 3 * WEEK + 2 * HOUR, reset - 2 * WEEK),
    call(now - HOUR, "w2", "claude-opus-5-5", opusOut(1e6)),
  ].join("\n") + "\n");
  const ws = openWorkspace(tempWorkspace());
  const b = await serve(ws, { host: "127.0.0.1", port: 0, plan: async () => ({ percent: 30, resets_at: reset }) });
  after(() => b.close());
  let d: any;
  for (const end = Date.now() + 5000; !(d = await (await fetch(`${b.url}/api/weekly`)).json()).actual.length;) {
    if (Date.now() > end) assert.fail(`the plan was never sampled: ${d.actual_error}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(d.end, reset);
  assert.equal(Math.round(d.limit), 100);
  assert.equal(d.actual[0][1], 30);

  const page = await (await fetch(`${b.url}/analytics`)).text();
  assert.match(page, /id="weekly"[\s\S]*weekly\.js[\s\S]*analytics\.js/);
  const dom = new JSDOM(page.replace(/<script src[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: `${b.url}/analytics`, pretendToBeVisual: true });
  after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, { fetch: async () => ({ ok: true, json: async () => d }), setInterval: () => 0 });
  const ctx = dom.getInternalVMContext();
  for (const f of ["common.js", "weekly.js"])
    new vm.Script(readFileSync(new URL(`../src/board/static/${f}`, import.meta.url), "utf8"), { filename: f }).runInContext(ctx);
  const doc = w.document;
  for (const end = Date.now() + 5000; !doc.querySelector("#wchart svg");) {
    if (Date.now() > end) assert.fail("the chart never rendered");
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(doc.querySelector("path.est")!.getAttribute("d")!.startsWith("M"));
  assert.ok(doc.querySelector("path.act"));
  assert.equal(doc.querySelectorAll("line.lim").length, 1, "the 100% line");
  assert.equal(doc.querySelectorAll("line.reset").length, 4);
  assert.equal(doc.querySelectorAll("#wtable tbody tr").length, 3, "one row a week");
  assert.deepEqual([...doc.querySelectorAll("#wtable thead tr:last-child th")].map((t) => t.textContent), ["Week", "by Fri", "by Sun", "at reset", "by Fri", "by Sun", "at reset"]);
  assert.deepEqual([...doc.querySelectorAll("#wtable tr.grp th")].map((t) => t.textContent), ["", "% of limit", "tokens"]);
  assert.match(doc.querySelector("#wtable tbody tr")!.textContent!, /100%/, "the hit week spent all of it");
  assert.ok([...doc.querySelectorAll("#wtable tbody tr, #wtable thead tr:last-child")].every((r) => r.querySelectorAll(".tk1").length === 1 && r.querySelector(".tk1") === r.querySelector(".tk")), "the divider on the first token column of each row");
  assert.deepEqual(d.token_kinds, ["input", "output", "cache_read", "cache_write"]);
  // the hit week's tokens at its reset, with their split on hover
  const atReset = doc.querySelector("#wtable tbody tr td.tk:last-child")!;
  assert.equal(atReset.textContent, "5.00M");
  assert.equal(atReset.getAttribute("title"), "input 0, output 5.00M, cache read 0, cache write 0");
  // the limit in tokens on its line, marked an estimate, and the latest point in both units
  assert.equal(doc.querySelector("#wlegend .lim-t")!.textContent, "100% ≈ 5.00M tokens, est.");
  assert.equal(doc.querySelector("#wtable tbody tr td:nth-child(4) .tkl")!.textContent, "5.00M tok", "and folded into the % cell, for a narrow screen");
  assert.ok([...doc.querySelectorAll("text.val")].some((t) => /% · 1\.00M$/.test(t.textContent!)), "the estimate's latest point in % and tokens");
  assert.match(doc.getElementById("wnote")!.textContent!, /In tokens the limit is about 5\.00M, the mean the same weeks spent: an estimate/);
  assert.match(doc.getElementById("wlegend")!.textContent!, /estimated, from transcripts.*actual/);
  assert.match(doc.getElementById("wnote")!.textContent!, /weekly limit of \$100: the mean of 1 week the limit was hit\./);
  // a pointer over the chart shows both figures at that time
  const svg = doc.querySelector("#wchart svg")!;
  (svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 220 } as DOMRect);
  doc.getElementById("wchart")!.dispatchEvent(new w.MouseEvent("pointermove", { clientX: 300 }) as Event);
  assert.match(doc.getElementById("wtip")!.textContent!, /estimated.*%.*actual/);
  assert.match(doc.getElementById("wtip")!.textContent!, /tokens1\.00Minput0output1\.00Mcache read0cache write0/, "the tokens at that time, by type");
});
