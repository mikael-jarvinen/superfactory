import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { GIT_HTTPS_ENV, gitEnv } from "../src/launch.js";
import { branchPushed, ensureWorktree, git, HTTPS, overArgs, worktreeDirty } from "../src/worktree.js";
import { run } from "../src/util.js";
import { tempDir, until } from "./helpers.js";

const WORKTREE = fileURLToPath(new URL("../src/worktree.js", import.meta.url));

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

// A host with git_over = "ssh" has the key and no gh. Its origin is git@github.com:..., here mapped
// to a local bare repo by the clone's own config. A fetch given superfactory's https rewrite as well
// would go to https://github.com instead, so the fetch working shows none was given.
test("over ssh: the origin as it is, no https push config, and a worktree's old one removed", () => {
  assert.deepEqual(overArgs("ssh"), []);
  assert.deepEqual(overArgs("https"), HTTPS);
  assert.deepEqual(gitEnv("ssh"), {});
  assert.deepEqual(gitEnv("https"), GIT_HTTPS_ENV);
  assert.deepEqual(gitEnv(), GIT_HTTPS_ENV);

  const root = tempDir();
  after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const clone = join(root, "app");
  must(root, "init", "-q", "--bare", "-b", "main", origin);
  must(root, "clone", "-q", origin, clone);
  must(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
  must(clone, "push", "-q", "origin", "HEAD:main");
  must(clone, "remote", "set-url", "origin", "git@github.com:acme/origin.git");
  must(clone, "config", `url.${root}/.insteadOf`, "git@github.com:acme/");

  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };
  const { wt, how } = ensureWorktree(clone, "APP-1", "main", "ssh");
  assert.equal(how, "new branch APP-1 from origin/main");
  assert.equal(git(wt, "config", "--get", "extensions.worktreeConfig").status, 1, "no per-worktree config at all");
  assert.equal(git(wt, "config", "--local", "--get", "credential.helper").status, 1, "no gh credential helper");
  assert.equal(git(wt, "config", "--local", "--get", "url.https://github.com/.insteadOf").status, 1, "no https rewrite");
  must(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  assert.equal(run("git", ["-C", wt, "push", "-q", "origin", "APP-1"], { env }).status, 0, "pushed through the origin's own url");
  assert.equal(must(origin, "rev-parse", "APP-1"), must(wt, "rev-parse", "HEAD"));

  // made over https, then the host said ssh: reusing it takes the https config away again
  const old = ensureWorktree(clone, "APP-2", "main").wt;
  assert.equal(must(old, "config", "--worktree", "credential.helper"), "!gh auth git-credential");
  assert.equal(ensureWorktree(clone, "APP-2", "main", "ssh").how, "reused existing worktree");
  assert.equal(git(old, "config", "--worktree", "--get", "credential.helper").status, 1);
  assert.equal(git(old, "config", "--worktree", "--get", "url.https://github.com/.insteadOf").status, 1);
  // and the human's clone keeps its own config
  assert.equal(must(clone, "config", "--get", `url.${root}/.insteadOf`), "git@github.com:acme/");
  assert.equal(must(clone, "config", "--get", "remote.origin.url"), "git@github.com:acme/origin.git");
});

// A .mo that translates git's "initializing" as en_GB's langpack does, for GIT_TEXTDOMAINDIR.
function initialisingMo(): Buffer {
  const entries: [string, string][] = [
    ["", "Content-Type: text/plain; charset=UTF-8\n"],
    ["initializing", "initialising"],
  ];
  const n = entries.length;
  const strings = [...entries.map(([k]) => k), ...entries.map(([, v]) => v)].map((x) => Buffer.from(x));
  const table = Buffer.alloc(16 * n);
  let at = 28 + 16 * n;
  strings.forEach((b, i) => {
    table.writeUInt32LE(b.length, 8 * i);
    table.writeUInt32LE(at, 8 * i + 4);
    at += b.length + 1;
  });
  const head = Buffer.alloc(28);
  [0x950412de, 0, n, 28, 28 + 8 * n, 0, 0].forEach((v, i) => head.writeUInt32LE(v, 4 * i));
  return Buffer.concat([head, table, ...strings.map((b) => Buffer.concat([b, Buffer.from([0])]))]);
}

// git itself writes the lock: a checkout filter holds `git worktree add` mid-checkout, in a locale
// that translates the lock's reason, and the test SIGKILLs it there. Where en_GB.UTF-8 is not
// installed, git does not translate, and the test checks the refusal alone.
test("a worktree whose git worktree add was killed is refused, in any locale, until it is removed", async () => {
  const root = tempDir();
  after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const clone = join(root, "web");
  must(root, "init", "-q", "--bare", "-b", "main", origin);
  must(root, "clone", "-q", origin, clone);
  writeFileSync(join(clone, "a.txt"), "a\n");
  must(clone, "add", "a.txt");
  must(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "start");
  must(clone, "push", "-q", "origin", "HEAD:main");
  const kept = ensureWorktree(clone, "WEB-4", "main").wt;

  const hang = join(root, "hang");
  const held = join(root, "held");
  writeFileSync(join(root, "smudge"), `#!/bin/sh\ntouch ${held}\nwhile [ -f ${hang} ]; do sleep 0.1; done\nexec cat\n`);
  chmodSync(join(root, "smudge"), 0o755);
  must(clone, "config", "filter.slow.smudge", join(root, "smudge"));
  writeFileSync(join(clone, ".git", "info", "attributes"), "a.txt filter=slow\n");
  mkdirSync(join(root, "po", "en_GB", "LC_MESSAGES"), { recursive: true });
  writeFileSync(join(root, "po", "en_GB", "LC_MESSAGES", "git.mo"), initialisingMo());

  writeFileSync(hang, "");
  const code = `import(${JSON.stringify(WORKTREE)}).then((m) => m.ensureWorktree(${JSON.stringify(clone)}, "WEB-3", "main"))`;
  const env = { ...process.env, LC_ALL: "en_GB.UTF-8", GIT_TEXTDOMAINDIR: join(root, "po") };
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "ignore", "pipe"], env });
  let stderr = "";
  child.stderr!.on("data", (b) => (stderr += b));
  let gone = false;
  const exited = new Promise((res) => child.once("close", () => res((gone = true))));
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  };
  try {
    // A child that dies early fails the test rather than hanging it.
    await until("the filter to hold the checkout", () => existsSync(held) || gone, 30_000);
    assert.ok(existsSync(held), `ensureWorktree exited before the checkout: ${stderr}`);
    kill();
    await exited;
  } finally {
    kill();
    rmSync(hang, { force: true });
  }

  const half = join(clone, ".claude", "worktrees", "WEB-3");
  assert.throws(() => ensureWorktree(clone, "WEB-3", "main"), /was never fully checked out.*worktree remove -f -f/);
  // A worktree locked for any other reason is still reused. git lists worktrees by path, so WEB-4
  // comes after WEB-3, and a check that matched any item's lock would find WEB-3's first.
  must(clone, "worktree", "lock", "--reason", "kept", kept);
  assert.equal(ensureWorktree(clone, "WEB-4", "main").how, "reused existing worktree");
  must(clone, "worktree", "remove", "-f", "-f", half);
  assert.match(ensureWorktree(clone, "WEB-3", "main").how, /^checked out existing local branch/);
  assert.equal(readFileSync(join(half, "a.txt"), "utf8"), "a\n");
});
