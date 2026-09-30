import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { branchPushed, ensureWorktree, git, worktreeDirty } from "../src/worktree.js";
import { tempDir } from "./helpers.js";

const must = (dir: string, ...args: string[]) => {
  const r = git(dir, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// The https push config must land in the worktree alone: a linked worktree shares .git/config with
// the human's checkout, and changing how their pushes authenticate is the bug this avoids.
test("a worktree per item, with its own push config, and the human's clone untouched", () => {
  const root = tempDir();
  after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const clone = join(root, "web");
  must(root, "init", "-q", "--bare", "-b", "main", origin);
  must(root, "clone", "-q", origin, clone);
  must(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
  must(clone, "push", "-q", "origin", "HEAD:main");

  const { wt, how } = ensureWorktree(clone, "LOCAL-fix-db", "main");
  assert.equal(wt, join(clone, ".claude", "worktrees", "LOCAL-fix-db"));
  assert.equal(how, "new branch fix-db from origin/main");
  assert.equal(must(wt, "rev-parse", "--abbrev-ref", "HEAD"), "fix-db");
  assert.equal(must(wt, "config", "--worktree", "credential.helper"), "!gh auth git-credential");
  assert.equal(must(wt, "config", "--worktree", "url.https://github.com/.insteadOf"), "git@github.com:");
  assert.notEqual(git(clone, "config", "--get", "credential.helper").stdout.trim(), "!gh auth git-credential");
  assert.equal(ensureWorktree(clone, "LOCAL-fix-db", "main").how, "reused existing worktree");

  mkdirSync(join(clone, ".claude", "worktrees", "WEB-2"), { recursive: true });
  assert.throws(() => ensureWorktree(clone, "WEB-2", "main"), /exists but is not a git worktree/);

  assert.equal(branchPushed(wt, "main"), true, "no commits of its own yet");
  writeFileSync(join(wt, "schema.gen.ts"), "");
  writeFileSync(join(wt, "real.txt"), "");
  assert.deepEqual(worktreeDirty(wt, ["schema.gen.ts", ".tool/"]), ["real.txt"]);
  must(wt, "add", "real.txt");
  must(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
  assert.equal(branchPushed(wt, "main"), false);
  must(wt, "push", "-q", "origin", "fix-db");
  assert.equal(branchPushed(wt, "main"), true);
});
