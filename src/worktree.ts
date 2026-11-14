import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import type { GitOver } from "./config.js";
import { branchFor } from "./state.js";
import { die, realpathLoose, run } from "./util.js";

export const git = (dir: string, ...args: string[]) => run("git", ["-C", dir, ...args]);

export const HTTPS = ["-c", "url.https://github.com/.insteadOf=git@github.com:"];
// The -c arguments a git that talks to GitHub takes: none when the checkout's origin is used as it is.
export const overArgs = (over: GitOver): string[] => (over === "ssh" ? [] : HTTPS);

// Where a checkout's worktrees go, on this machine or a host: <checkout>/.claude/worktrees/<item>.
export const worktreesDir = (repoDir: string) => posix.join(repoDir, ".claude", "worktrees");
export const worktreePath = (repoDir: string, ticket: string) => posix.join(worktreesDir(repoDir), ticket);

// `git worktree list --porcelain`, one record per worktree: its realpath, and its lock reason
// ("" for a lock without one), or null when it is not locked.
export function worktreeList(repoDir: string): { path: string; locked: string | null }[] {
  const out = git(repoDir, "worktree", "list", "--porcelain").stdout;
  return out
    .split("\n\n")
    .map((b) => b.split("\n"))
    .filter((ls) => ls[0]?.startsWith("worktree "))
    .map((ls) => {
      const lock = ls.find((l) => l === "locked" || l.startsWith("locked "));
      return { path: realpathLoose(ls[0]!.slice("worktree ".length)), locked: lock === undefined ? null : lock.slice("locked ".length) };
    });
}

export const registeredWorktrees = (repoDir: string): Set<string> => new Set(worktreeList(repoDir).map((w) => w.path));

// A worktree per ticket, on branchFor(ticket), started from origin/<base>. Never touches HEAD.
export function ensureWorktree(repoDir: string, ticket: string, base: string, over: GitOver = "https"): { wt: string; how: string } {
  const wt = worktreePath(repoDir, ticket);
  const branch = branchFor(ticket);
  const via = overArgs(over);
  const r = git(repoDir, ...via, "fetch", "-q", "origin", base);
  if (r.status !== 0) die(`git fetch failed in ${repoDir}: ${r.stderr.trim()}`);
  // the branch may already be on origin (a resumed item, a rebuilt laptop); a missing ref is fine
  git(repoDir, ...via, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  git(repoDir, "worktree", "prune");
  if (existsSync(wt) && statSync(wt).isDirectory()) {
    const registered = worktreeList(repoDir).find((w) => w.path === realpathLoose(wt));
    if (registered) {
      // git locks a worktree as "initializing" while it checks it out, and a SIGKILL leaves that
      // lock and a partial checkout.
      if (registered.locked === "initializing")
        die(`${wt} was never fully checked out: its git worktree add was interrupted. Remove it with \`git -C ${repoDir} worktree remove -f -f ${wt}\`, then dispatch again.`);
      pushConfig(repoDir, wt, over);
      return { wt, how: "reused existing worktree" };
    }
    // A plain directory here is inside the human's clone: a session started in it would work on
    // their checkout. Refuse rather than guess.
    die(`${wt} exists but is not a git worktree. Remove or rename it, then dispatch again.`);
  }
  mkdirSync(dirname(wt), { recursive: true });
  const haveBranch = git(repoDir, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).status === 0;
  const haveRemote = git(repoDir, "rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`).status === 0;
  let note = "";
  if (haveBranch && haveRemote) {
    const local = git(repoDir, "rev-parse", branch).stdout.trim();
    const remote = git(repoDir, "rev-parse", `origin/${branch}`).stdout.trim();
    if (local !== remote) {
      if (git(repoDir, "merge-base", "--is-ancestor", local, remote).status === 0) {
        git(repoDir, "branch", "-f", branch, remote);
        note = `; local ${branch} was behind origin and was moved forward`;
      } else {
        note = `; WARNING local ${branch} and origin/${branch} have diverged, checked out the local one`;
      }
    }
  }
  // git translates the lock reason (en_GB writes "initialising"), and the check above expects "initializing".
  const worktreeAdd = (...args: string[]) => run("git", ["-C", repoDir, "worktree", "add", ...args], { env: { ...process.env, LC_ALL: "C" } });
  let add;
  let how;
  if (haveBranch) {
    add = worktreeAdd(wt, branch);
    how = `checked out existing local branch ${branch}${note}`;
  } else if (haveRemote) {
    add = worktreeAdd("--track", "-b", branch, wt, `origin/${branch}`);
    how = `tracked existing origin/${branch}`;
  } else {
    add = worktreeAdd("-b", branch, wt, `origin/${base}`);
    how = `new branch ${branch} from origin/${base}`;
  }
  if (add.status !== 0) die(`git worktree add failed: ${add.stderr.trim()}`);
  pushConfig(repoDir, wt, over);
  return { wt, how };
}

// How the worktree's pushes reach GitHub. Over ssh it is the origin as the human set it up, so a
// worktree made over https before the host said ssh loses the https config it was given.
export function pushConfig(repoDir: string, wt: string, over: GitOver): void {
  if (over === "https") return pushOverHttps(repoDir, wt);
  // Only with per-worktree config on: otherwise --worktree is the shared .git/config, the human's.
  if (git(repoDir, "config", "--get", "extensions.worktreeConfig").stdout.trim() !== "true") return;
  git(wt, "config", "--worktree", "--unset-all", "url.https://github.com/.insteadOf");
  git(wt, "config", "--worktree", "--unset-all", "credential.helper");
}

// Push over https through gh, so no session needs the ssh key. Scoped with --worktree: a linked
// worktree shares .git/config with the main checkout, and this must not change how the human's own
// pushes authenticate. The remote keeps its name, so a bare --force-with-lease still checks
// refs/remotes/origin/<branch>.
export function pushOverHttps(repoDir: string, wt: string): void {
  if (git(repoDir, "config", "extensions.worktreeConfig", "true").status !== 0) return;
  git(wt, "config", "--worktree", "url.https://github.com/.insteadOf", "git@github.com:");
  git(wt, "config", "--worktree", "credential.helper", "!gh auth git-credential");
}

// The paths in `git status --porcelain` output, split on whitespace rather than by column.
export function porcelainPaths(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (m) paths.push((m[2] as string).split(" -> ").pop()!.trim().replace(/^"+|"+$/g, ""));
  }
  return paths;
}

// Dirt that is not the builder's work: files that tools rewrite just by running. An entry ending
// in "/" is a directory prefix; any other matches the end of a path.
export function worktreeDirty(wt: string, toolWritten: string[] = []): string[] {
  const dirs = toolWritten.filter((x) => x.endsWith("/"));
  const files = toolWritten.filter((x) => !x.endsWith("/"));
  return porcelainPaths(git(wt, "status", "--porcelain").stdout)
    .filter((p) => !files.some((f) => p.endsWith(f)) && !dirs.some((d) => p.startsWith(d)));
}

// Nothing would be lost by removing this worktree: either the branch is on origin at this head, or
// it has no commits of its own beyond origin/<base> yet.
export function branchPushed(wt: string, base = "main"): boolean {
  const br = git(wt, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (!br || br === "HEAD") return false;
  if (git(wt, "rev-parse", "--verify", "-q", `refs/remotes/origin/${br}`).status === 0 &&
    git(wt, "diff", "--quiet", `origin/${br}`, "HEAD").status === 0) return true;
  return git(wt, "rev-list", "--count", `origin/${base}..HEAD`).stdout.trim() === "0";
}
