import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { branchFor } from "./state.js";
import { die, realpathLoose, run } from "./util.js";

export const git = (dir: string, ...args: string[]) => run("git", ["-C", dir, ...args]);

export const HTTPS = ["-c", "url.https://github.com/.insteadOf=git@github.com:"];

export const worktreePath = (repoDir: string, ticket: string) => join(repoDir, ".claude", "worktrees", ticket);

export function registeredWorktrees(repoDir: string): Set<string> {
  const out = git(repoDir, "worktree", "list", "--porcelain").stdout;
  return new Set(out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => realpathLoose(l.slice("worktree ".length))));
}

// A worktree per ticket, on branchFor(ticket), started from origin/<base>. Never touches HEAD.
export function ensureWorktree(repoDir: string, ticket: string, base: string): { wt: string; how: string } {
  const wt = worktreePath(repoDir, ticket);
  const branch = branchFor(ticket);
  const r = git(repoDir, ...HTTPS, "fetch", "-q", "origin", base);
  if (r.status !== 0) die(`git fetch failed in ${repoDir}: ${r.stderr.trim()}`);
  // the branch may already be on origin (a resumed item, a rebuilt laptop); a missing ref is fine
  git(repoDir, ...HTTPS, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  git(repoDir, "worktree", "prune");
  if (existsSync(wt) && statSync(wt).isDirectory()) {
    if (registeredWorktrees(repoDir).has(realpathLoose(wt))) {
      pushOverHttps(repoDir, wt);
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
  let add;
  let how;
  if (haveBranch) {
    add = git(repoDir, "worktree", "add", wt, branch);
    how = `checked out existing local branch ${branch}${note}`;
  } else if (haveRemote) {
    add = git(repoDir, "worktree", "add", "--track", "-b", branch, wt, `origin/${branch}`);
    how = `tracked existing origin/${branch}`;
  } else {
    add = git(repoDir, "worktree", "add", "-b", branch, wt, `origin/${base}`);
    how = `new branch ${branch} from origin/${base}`;
  }
  if (add.status !== 0) die(`git worktree add failed: ${add.stderr.trim()}`);
  pushOverHttps(repoDir, wt);
  return { wt, how };
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
