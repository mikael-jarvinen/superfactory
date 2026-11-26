// The weekly usage chart on the analytics page: how much of the plan's weekly limit the account has
// spent, cumulatively within each week, over the two weeks before the current one and the current one
// up to its reset. The limit resets at a fixed time each week, so the x axis runs from the reset
// fourteen days before the current week's start to the next reset.
//
// Two lines. The estimate counts every Claude Code session of the account, on this machine and on
// every host (TranscriptUsage.account), so it covers the past weeks too. It weighs each call's tokens
// by what they would cost at API prices, by model and token type, since the limit is not a count of
// raw tokens: an Opus output token uses more of it than a Haiku cache read. The weeks whose limit was
// hit, where a call came back refused by the seven_day limit, calibrate it: the cost spent from that
// week's start up to the first refusal is the limit, and their mean is the 100% line. The weekly
// figure Anthropic publishes for the plans is in hours of model use, not tokens, so the hit weeks are
// the better measure. The same points carry the raw tokens too, by type, and the hit weeks give a
// limit in tokens: an estimate as well, and a looser one, since a week of cheap cache reads spends
// more tokens on the limit than a week of output. The actual line is the plan's own weekly utilization, as /usage shows it, which
// the board samples (plan-usage.ts); each sample also says what 1% cost this week, a check on the
// estimate. What the transcripts do not hold, claude.ai and other machines' sessions, counts in the
// actual line only.
import type { Call, Hit, Read } from "./analytics.js";
import type { Sample } from "./plan-usage.js";

export const WEEK = 7 * 86_400_000;
// The estimate's step. Every UTC offset in use is a whole number of quarter hours, so a point falls
// on every local midnight, and the table's Friday and Sunday figures are exact in any time zone.
const STEP = 15 * 60_000;
// How far back the account's transcripts are read, and the oldest a hit week may start. Claude
// Code deletes a transcript not written for cleanupPeriodDays, 30 by default: a week that started
// before then may have lost its first sessions and would count short, pulling the limit down.
// Three weeks of chart fit inside it.
export const WEEKLY_SINCE = 30 * 86_400_000;

// API prices in dollars per million tokens: input, output, cache read, cache write kept 5 minutes,
// cache write kept an hour. A model not listed is priced as the first; a call with no model
// (the refusals' "<synthetic>") has no tokens.
const PRICES: [RegExp, number[]][] = [
  [/opus/, [4, 20, 0.2, 5, 8]],
  [/sonnet/, [2, 10, 0.1, 2.5, 4]],
  [/haiku/, [0.1, 0.5, 0.01, 0.125, 0.2]],
  [/fable-5-1/, [10, 50, 0.25, 12.5, 20]],
  [/fable/, [8, 40, 0.2, 10, 16]],
];

export function costOf(c: Call): number {
  const p = (PRICES.find(([re]) => re.test(c.model ?? "")) ?? (PRICES[0] as [RegExp, number[]]))[1];
  const t = c.tokens;
  const w1h = Math.min(c.write_1h, t.cache_write);
  return (t.input * p[0]! + t.output * p[1]! + t.cache_read * p[2]! + (t.cache_write - w1h) * p[3]! + w1h * p[4]!) / 1e6;
}

// A week the limit was hit: its start, when the first refusal came, and the cost spent by then.
export interface HitWeek {
  start: number;
  hit: number;
  cost: number;
  tokens: number;
}

// Tokens by type: input, output, cache read, cache write.
export type TokenSplit = [number, number, number, number];

export interface Weekly {
  now: number;
  // The chart's span, and the resets in it, start and end included; null when no reset is known yet.
  start: number | null;
  end: number | null;
  resets: number[];
  // The 100% line in dollars at API prices, from the hit weeks, and how far they spread from it.
  limit: number | null;
  spread: number | null;
  // The same limit in tokens, the mean of the hit weeks' tokens, and how far they spread from it.
  limit_tokens: number | null;
  token_spread: number | null;
  weeks: HitWeek[];
  // Points [time, percent] of the estimate every quarter hour, each what was spent before its
  // time, up to now. At each reset come two: the full week, then 0.
  estimate: [number, number][];
  // The estimate's tokens at each of its points, by type: [time, input, output, cache read, cache write].
  tokens: [number, ...TokenSplit][];
  // The plan's own samples [time, percent].
  actual: [number, number][];
  // The first refusal of each week on the chart.
  hits: number[];
  // The latest sample's cost per 1% this week, against the estimate's (limit / 100).
  check: { at: number; percent: number; cost: number; per_percent: number } | null;
  // Why there are no samples, when the last poll failed.
  actual_error: string | null;
  // The estimate's tokens and cost this week, so far.
  week_cost: number;
  week_tokens: number;
}

export function weekly(reads: Read[], samples: Sample[], now: number, actualError: string | null = null): Weekly {
  // A call is counted once, as a resumed session copies a few calls into its new transcript.
  const byId = new Map<string, Call>();
  const calls: Call[] = [];
  const hits: Hit[] = [];
  for (const r of reads) {
    hits.push(...r.hits);
    for (const c of r.calls) {
      if (!c.id) calls.push(c);
      else if (!byId.has(c.id)) byId.set(c.id, c);
    }
  }
  calls.push(...byId.values());
  calls.sort((a, b) => a.at - b.at);
  hits.sort((a, b) => a.at - b.at);

  const out: Weekly = {
    now, start: null, end: null, resets: [], limit: null, spread: null, limit_tokens: null, token_spread: null, weeks: [], estimate: [], tokens: [], actual: [],
    hits: [], check: null, actual_error: actualError, week_cost: 0, week_tokens: 0,
  };
  // The reset a sample or a refusal named last, stepped by weeks to the first one after now.
  const known = [...samples.map((s) => s.resets_at), ...hits.map((h) => h.resets)].filter((t) => t > 0);
  if (!known.length) return out;
  const named = Math.round(Math.max(...known) / 60_000) * 60_000;
  const end = named + (Math.floor((now - named) / WEEK) + 1) * WEEK;
  const start = end - 3 * WEEK;
  Object.assign(out, { start, end, resets: [start, start + WEEK, start + 2 * WEEK, end] });

  // Cumulative cost from a time to another, over the calls sorted by time.
  const prefix: number[] = [0];
  for (const c of calls) prefix.push((prefix[prefix.length - 1] as number) + costOf(c));
  // and the tokens, by type
  const kinds = ["input", "output", "cache_read", "cache_write"] as const;
  const tprefix: TokenSplit[] = [[0, 0, 0, 0]];
  for (const c of calls) {
    const p = tprefix[tprefix.length - 1] as TokenSplit;
    tprefix.push(kinds.map((k, i) => p[i]! + c.tokens[k]) as TokenSplit);
  }
  const index = (t: number) => {
    let lo = 0, hi = calls.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((calls[mid] as Call).at < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const spent = (from: number, to: number) => (prefix[index(to)] as number) - (prefix[index(from)] as number);
  const tokensIn = (from: number, to: number): TokenSplit => {
    const a = tprefix[index(from)] as TokenSplit, b = tprefix[index(to)] as TokenSplit;
    return [b[0] - a[0], b[1] - a[1], b[2] - a[2], b[3] - a[3]];
  };
  const sum = (s: TokenSplit) => s[0] + s[1] + s[2] + s[3];

  // The hit weeks: the first refusal of each week, within the span the transcripts were read for.
  const first = new Map<number, number>();
  for (const h of hits) if (!first.has(h.resets)) first.set(h.resets, h.at);
  const oldest = now - WEEKLY_SINCE;
  for (const [resets, hit] of [...first].sort((a, b) => a[0] - b[0])) {
    const wStart = resets - WEEK;
    if (wStart < oldest || hit < wStart) continue;
    out.weeks.push({ start: wStart, hit, cost: spent(wStart, hit), tokens: sum(tokensIn(wStart, hit)) });
  }
  out.weeks = out.weeks.filter((w) => w.cost > 0);
  const meanOf = (xs: number[]): [number, number] => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return [mean, Math.max(...xs.map((c) => Math.abs(c - mean))) / mean];
  };
  if (out.weeks.length) {
    [out.limit, out.spread] = meanOf(out.weeks.map((w) => w.cost));
    [out.limit_tokens, out.token_spread] = meanOf(out.weeks.map((w) => w.tokens));
  }

  const weekStart = (t: number) => start + Math.floor((t - start) / WEEK) * WEEK;
  const curStart = weekStart(Math.min(now, end - 1));
  out.week_cost = spent(curStart, now + 1);
  out.week_tokens = sum(tokensIn(curStart, now + 1));

  if (out.limit) {
    const limit = out.limit;
    const pct = (from: number, t: number) => Math.round((spent(from, t) / limit) * 1e4) / 100;
    const stop = Math.min(now, end);
    const times = new Set<number>([start, ...out.resets.filter((r) => r <= stop), stop]);
    for (let t = Math.ceil(start / STEP) * STEP; t <= stop; t += STEP) times.add(t);
    for (const t of [...times].sort((a, b) => a - b)) {
      const from = [...(t > start && (t - start) % WEEK === 0 ? [t - WEEK] : []), weekStart(t)];
      for (const f of from) {
        out.estimate.push([t, pct(f, t)]);
        out.tokens.push([t, ...tokensIn(f, t)]);
      }
    }
  }

  const shown = samples.filter((s) => s.at >= start && s.at <= now).sort((a, b) => a.at - b.at);
  out.actual = shown.map((s) => [s.at, s.percent]);
  out.hits = [...first.values()].filter((t) => t >= start && t <= now).sort((a, b) => a - b);
  // The newest sample this week with enough use to divide by.
  const last = [...shown].reverse().find((s) => s.at >= curStart && s.percent >= 5);
  if (last) {
    const cost = spent(curStart, last.at + 1);
    out.check = { at: last.at, percent: last.percent, cost, per_percent: cost / last.percent };
  }
  return out;
}
