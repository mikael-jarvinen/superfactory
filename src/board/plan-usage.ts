// The plan's own weekly utilization, as Claude Code's /usage shows it, sampled for the weekly usage
// chart (weekly.ts). The board asks the same endpoint /usage does, with the login Claude Code keeps,
// read afresh on each poll, since Claude Code refreshes it: on macOS its Keychain item, read with
// `security` as Claude Code reads it, else .credentials.json in its config dir. The board never
// refreshes the login itself, as a refresh replaces the token Claude Code holds, and it keeps no copy:
// the token goes in the request's header and nowhere else, and no error carries it. An expired login
// waits for Claude Code's next refresh.
//
// Each sample is appended to state/plan-usage.jsonl: when, the weekly percent, and the reset it names.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { claudeConfigDir } from "../claude-bin.js";
import type { Workspace } from "../workspace.js";

export interface Sample {
  at: number;
  percent: number;
  resets_at: number;
}

// One read of the weekly utilization; it rejects with a reason that never holds the token.
export type PlanFetch = () => Promise<{ percent: number; resets_at: number }>;

// Gently: the figure moves by a percent or so an hour.
export const POLL_EVERY = 12 * 60_000;
const URL = "https://api.anthropic.com/api/oauth/usage";

// The Keychain item Claude Code keeps its login in on macOS: the service carries a hash of the
// config dir when one is set apart from the default, and the account is the user's name.
export function keychainItem(env: NodeJS.ProcessEnv = process.env): { service: string; account: string } {
  const apart = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = apart !== undefined ? apart : env.CLAUDE_CONFIG_DIR ?? "";
  const hash = dir ? "-" + createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8) : "";
  let user = "";
  try {
    user = env.USER || userInfo().username;
  } catch {
    // no user name
  }
  return { service: `Claude Code-credentials${hash}`, account: /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user" };
}

// The Keychain item's text, or null when there is none; `security` prints it to its stdout only.
// Any other failure rejects with a reason that holds its exit code, never its output: a locked
// keychain (36, 51) when the board runs over ssh or from launchd, or a timeout, most likely an
// access prompt nobody answered.
export type Keychain = () => Promise<string | null>;
const NO_ITEM = 44;
const macKeychain: Keychain = () =>
  new Promise((resolve, reject) => {
    const { service, account } = keychainItem();
    execFile("security", ["find-generic-password", "-a", account, "-w", "-s", service], { encoding: "utf8", timeout: 10_000 }, (err, out) => {
      if (!err) return resolve(out.trim() || null);
      if (err.killed) return reject(new Error("reading Claude Code's Keychain item timed out, perhaps on an access prompt nobody answered"));
      if (err.code === NO_ITEM) return resolve(null);
      reject(new Error(`Claude Code's Keychain item could not be read (security exited ${typeof err.code === "number" ? err.code : "abnormally"})`));
    });
  });

export function oauthUsage(
  configDir: () => string = claudeConfigDir,
  fetchFn: typeof fetch = fetch,
  keychain: Keychain | null = process.platform === "darwin" ? macKeychain : null,
): PlanFetch {
  return async () => {
    let token: unknown, expires: unknown;
    let text: string | null = null;
    let keychainError: string | null = null;
    if (keychain)
      text = await keychain().catch((e: unknown) => {
        keychainError = e instanceof Error ? e.message : "Claude Code's Keychain item could not be read";
        return null;
      });
    try {
      text ??= readFileSync(join(configDir(), ".credentials.json"), "utf8");
      const c = JSON.parse(text)?.claudeAiOauth;
      token = c?.accessToken;
      expires = c?.expiresAt;
    } catch {
      throw new Error(keychainError ?? "there is no Claude Code login to read here");
    }
    if (typeof token !== "string" || !token) throw new Error("the Claude Code login has no access token");
    if (typeof expires === "number" && expires < Date.now()) throw new Error("the Claude Code login has expired; it is read again after Claude Code refreshes it");
    let res: Response;
    try {
      res = await fetchFn(URL, {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error(`the usage endpoint could not be reached (${e instanceof Error ? e.name : "error"})`);
    }
    if (!res.ok) throw new Error(`the usage endpoint answered ${res.status}`);
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new Error("the usage endpoint's answer is not JSON");
    }
    const w = body?.seven_day;
    const resets = typeof w?.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    if (typeof w?.utilization !== "number" || Number.isNaN(resets)) throw new Error("the usage endpoint's answer has no weekly utilization");
    return { percent: w.utilization, resets_at: resets };
  };
}

export class PlanUsage {
  error: string | null = null;
  private busy = false;
  constructor(private file: string) {}

  static of(ws: Workspace): PlanUsage {
    return new PlanUsage(join(ws.stateDir, "plan-usage.jsonl"));
  }

  // One poll; a failure is kept as the error, and a poll asked while one runs is skipped.
  async poll(read: PlanFetch, now = Date.now): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await read();
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify({ at: now(), percent: r.percent, resets_at: r.resets_at }) + "\n");
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "the usage read failed";
    } finally {
      this.busy = false;
    }
  }

  samples(since = -Infinity): Sample[] {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out: Sample[] = [];
    for (const line of text.split("\n")) {
      try {
        const s = JSON.parse(line);
        if (typeof s?.at === "number" && typeof s.percent === "number" && typeof s.resets_at === "number" && s.at >= since) out.push(s);
      } catch {
        // a torn line
      }
    }
    return out;
  }
}
