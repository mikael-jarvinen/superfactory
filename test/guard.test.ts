import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { allowClosePath } from "../src/allow-close.js";
import { hook as markedHook } from "../src/hooks/marked-comments.js";
import { commentVerdict, GITHUB_BUDGET_MS, type GuardContext, hook, mcpVerdict, verdict } from "../src/hooks/guard.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

const ro: GuardContext = { role: "reviewer", policy: "readonly", writeDirs: [], ownRepos: [] };
const pr: GuardContext = { role: "builder", policy: "protect", writeDirs: [], org: "acme", ownRepos: ["acme/workspace", "alex/factory"], defaultBranch: (r) => (r === "acme/trunk-repo" ? "trunk" : r === "acme/offline" ? null : "main") };

const REFUSE = 2;
const ALLOW = 0;

const table: [GuardContext, number, string[]][] = [
  [ro, REFUSE, [
    "command git commit -m x", "env git commit -m x", "\\git commit -m x", "git -c core.pager=cat -C /x commit -m x",
    "git --no-pager -C /x commit -m x", "(cd /x; git commit -m x)", "bash -c 'git commit -m x'", 'sh -c "git commit"', 'eval "git commit"',
    "xargs git commit", "`git commit -m x`", "{ git commit -m x; }", "if git commit -m x; then :; fi", "GIT_DIR=/x/.git git commit",
    "/usr/bin/git commit -m x", "GIT commit -m x", "git -C/x commit -m x", "git --git-dir /x/.git log", "git -p commit -m x",
    "git -c alias.ci=commit ci -m x", "git pull", "git fetch origin main:main", "git branch newbranch", "git branch -f main HEAD",
    "git config --unset user.name", "git checkout-index -a -f", "git update-index --add f", "git reflog delete HEAD@{0}", "git stash pop",
    "git -C /x branch -D main", "ls && git commit -m x", "ls || git commit -m x", "ls\ngit commit -m x", "git push origin CL-1", "git worktree add x",
    "gh api -XPOST repos/o/r/issues/1/comments -f body=x", "gh api --method DELETE repos/o/r/git/refs/heads/x", "gh api --method=DELETE repos/o/r/x",
    "gh api repos/o/r/x -fbody=x", "gh api repos/o/r/x --field=body=x", "gh pr merge 1", "gh pr review 1 --approve", "gh pr update-branch 1",
    "gh workflow run ci.yml", "gh run cancel 1", "gh label create x", "gh repo clone o/r", "gh secret set X", "command gh pr merge 1",
    "find . -delete", "find . -exec rm {} \\;", "find . -name '*.tmp' -exec rm {} +", 'python3 -c "open(\\"/Users/x/f\\",\\"w\\")"',
    'node -e "require(\\"fs\\").writeFileSync(\\"/Users/x/f\\",\\"x\\")"', "perl -pi -e 's/a/b/' /Users/x/f", "ruby -e 'File.write(1)'", "php -r 'x'",
    "cat <<EOT > /Users/x/f\nhello\nEOT", "tee -a /Users/x/f", "echo x >| /Users/x/f", "echo x >> ./f", "echo x > /tmp/../Users/x/f",
    "exec 3<>/Users/x/f", "cp a /Users/x/", "cp /tmp/a ./f", "cp /tmp/a ~/f", "cp -r /tmp/x .", "mv /tmp/x $HOME/y", "rm -rf /tmp/../Users/x",
    "ln -s /tmp/a link", "rsync -a /tmp/a/ b/", "install /tmp/a f", "chmod +x f", "sed -i '' s/a/b/ file", "sed -i'' s/a/b/ file",
    "sed -i.bak s/a/b/ file", "sed -E -i s/a/b/ file", "sed --in-place s/a/b/ file", "truncate -s0 /Users/x/f", ": > /Users/x/f",
    "dd if=/dev/zero of=/Users/x/f count=1", "ls | xargs rm", "tar -xf /tmp/a.tar", "curl -o f https://x", "npm run lint -- --fix",
    "npx prettier --write .", "npx eslint --fix .", "yarn lint --fix", "vendor/bin/pint", "vendor/bin/rector process", "dart format lib/",
    "dart fix --apply", "php artisan migrate", "flutter build apk", "composer dump-autoload", "npm install left-pad", "echo hi > /Users/x/file.txt",
    "cat foo | tee /Users/x/out", "rm -rf /Users/x/web/src", "git commit -m x", "git push origin main", "gh pr ready 1", "mkdir -p ./newdir",
    "osascript -e x", 'sqlite3 db.sqlite "delete from x"', "wget https://x", "git remote set-url origin x", "git tag v1", "git symbolic-ref HEAD refs/heads/x",
  ]],
  [ro, ALLOW, [
    "git -C /x log --format=%h -1", "git diff --stat origin/main...origin/CL-1", "git cherry -v origin/main origin/CL-1", "git show HEAD",
    "git blame f.php", "git stash list", "git worktree list", "git tag -l", "git config --get user.name", "git config user.name",
    "git -c url.https://github.com/.insteadOf=git@github.com: -C /x fetch origin", "git log --graph --format='%h -> %p' -5",
    "git diff | grep '>>>'", "grep -rn foo .", "rg foo", "cat file", "ls -la", "gh pr view 1 --json title", "gh api repos/o/r/pulls/1",
    "gh api repos/o/r/pulls/1/comments -F per_page=100", "gh api graphql -f query='query { viewer { login } }'",
    "gh api repos/o/r/pulls --jq '.[] | select(.number > 3)'", "jq '.[] | select(.n > 3)' f.json", "awk '$1 > 5' f", "echo '<a>b</a>'",
    "npm run lint", "npm test", "npx jest x.test.ts", "vendor/bin/phpstan analyse", "flutter analyze", "flutter test", "dart format --set-exit-if-changed lib/",
    "composer show", "echo hi", "cd /x && ls", "cp /Users/x/repo/a.php /tmp/a.php", "cat /Users/x/f | tee /tmp/out", "git -C /Users/x/repo diff > /tmp/d.diff",
    "echo x >/dev/stderr", "echo x 2>/dev/null", "git fetch origin", "git -C /x fetch origin +refs/heads/CL-1:refs/remotes/origin/CL-1",
    "git rev-parse --verify origin/CL-1", "git -C /x cherry -v origin/main origin/CL-1", "git branch -a --list", "git remote -v", "git status --porcelain",
    "mkdir -p /tmp/sf && cp a.html /tmp/sf/", "echo x > /tmp/plan.html", "head -50 CLAUDE.md", "wc -l file", "vendor/bin/pint --test", "php artisan test",
    "docker compose exec app vendor/bin/phpunit tests/Unit/X.php", "npm run check-types", "gh pr diff 12 --repo acme/api", "gh pr checks 12",
    "git log origin/main..origin/CL-1 --oneline", "git log -1 --format='%H %ct %s'", 'find . -name "*.php" | head', "curl -s https://api.example.com/x",
    "sed -n 1,20p file", 'sed -E "s/a/b/" file', "git reflog show refs/remotes/origin/CL-1", "date -u +%FT%TZ", "ls; git log -1", "for f in a b; do echo $f; done",
    "TOKEN=1 gh pr view 1", "HEAD=$(git rev-parse HEAD); echo $HEAD", "git diff $(git merge-base origin/main HEAD) HEAD --stat",
  ]],
  [pr, REFUSE, [
    "git push origin main", "git push origin HEAD:refs/heads/main", "git push origin CL-1:main", "git push origin HEAD~1:main", "git push origin main:main",
    "git push origin head:main", "git push origin HEAD:staging", "git push origin HEAD:production", "git push origin HEAD:dev", "git push -f origin main",
    "git push origin +main", "git push origin +CL-1:main", "git push --mirror origin", "git push --all origin", "git push --prune origin", "git push origin :main",
    "git push origin -d main", "git push origin --delete CL-1", "git push --force-with-lease=main origin CL-1", "git push -fu origin CL-1", "git push -uf origin CL-1",
    "git -c push.default=current push origin main", "git --no-pager push origin main", "git -C/x push origin main", "git -C /x -C /y push origin main",
    "GIT push origin main", "git push", "git push origin", "git branch -f main HEAD", "git update-ref refs/heads/main HEAD", "gh api -X PUT repos/o/r/pulls/1/merge",
    "gh api -X DELETE repos/o/r/git/refs/heads/main", "gh pr merge 1", "gh pr ready 1", "git checkout main", "git switch main", "command git push origin main",
    "\\git push origin main", "git push origin CL-1:refs/heads/main", "ls\ngit push origin main", "cd x && git push --force origin CL-1", "git push origin +CL-1",
    "git push origin CL-1 main", "env git push origin main", "gh api -X DELETE repos/acme/api/git/refs/heads/x",
    "gh api -X DELETE repos/o/r/git/refs/heads/master", "gh api -X DELETE repos/o/r/git/refs/heads/x -f a=b", "gh api -X POST repos/o/r/branches/x/rename -f new_name=y",
    "gh api -X POST repos/acme/api/branches/x/rename -f new_name=main", "gh api -X POST repos/acme/workspace/branches/main/rename -f new_name=x",
    "git push https://github.com/acme/api.git HEAD:main", "git push --force https://github.com/acme/workspace.git main", "git push origin HEAD:main",
    "gh api -X DELETE repos/Acme/api/git/refs/heads/x", "gh api -X POST repos/o/r/branches/a/b/rename -f new_name=y",
    "git push https://github.com/acme/workspace.git :main", "git push https://github.com/acme/workspace.git +main",
  ]],
  [pr, ALLOW, [
    "git push -u origin CL-1", "git push --force-with-lease origin MOBILE-1", "git push origin feature/main-menu", "git push origin main-fix",
    "git checkout -b CL-1 origin/main", "git switch -c CL-1 origin/main", "git rebase origin/main", "git branch -D CL-1", "git checkout origin/main -- file",
    "git log main..HEAD", "git diff main", "gh pr create --draft --title x", "gh pr ready 1 --undo", 'git reset --soft origin/main && git commit -m "MOBILE-1 x"',
    "npm install", "yarn build", "flutter pub run build_runner build --delete-conflicting-outputs --force-jit", "python3 scripts/x.py", "rm -rf node_modules",
    "git push -u origin MOBILE-1234", "git fetch origin main", "git reset --hard origin/main", "gh pr view 1", "git push origin HEAD:CL-1",
    "gh api -X DELETE repos/o/r/git/refs/heads/step-2", "gh api --method=DELETE repos/o/r/git/refs/heads/a/b",
    "gh api -X POST repos/acme/workspace/branches/workspace/rename -f new_name=main", "git push https://github.com/alex/factory.git HEAD:main",
    "git push https://github.com/acme/workspace.git main",
  ]],
  // A comment goes out under the human's login: the watcher tells the factory's from the human's by
  // the marker, so a protected session posts only marked or trigger bodies.
  // Beyond the old table. timeout is unwrapped and its command checked rather than refused; a shell's
  // -c script is checked; ");" is two operators; a quoted "|" or ">" is a word; >&1 writes no file.
  [ro, REFUSE, ["(ls); git commit -m x", "timeout 5 git commit -m x", "env GIT_DIR=/x/.git git log"]],
  [ro, ALLOW, ["timeout 5 git log -1", "npm test 2>&1", "grep '|' f", "grep '>' f"]],
  [pr, REFUSE, ["bash -c 'git push origin main'", "timeout 60 git push origin main", "(ls); git push origin main"]],
  [pr, ALLOW, ["timeout 600 npm test", "bash -lc 'npm test'"]],
  [{ ...ro, writeDirs: ["/w/logs"] }, ALLOW, ["echo x > /w/logs/a", "tee /w/logs/b"]],
  [{ ...ro, writeDirs: ["/w/logs"] }, REFUSE, ["echo x > /w/other", "echo x > /w/logs/../x"]],
];

test("the guard's allow and refuse table", () => {
  const wrong: string[] = [];
  for (const [ctx, want, cmds] of table)
    for (const c of cmds) {
      const reason = verdict(c, ctx);
      if ((reason === null ? ALLOW : REFUSE) !== want) wrong.push(`[${ctx.policy}] want ${want}: ${JSON.stringify(c)}${reason ? ` (${reason})` : ""}`);
    }
  assert.deepEqual(wrong, []);
});

// The lead may delete a merged branch of an --own-repo inside the --org, through the API only. The
// stub calls every branch merged but wip-2, so each refusal below is its own rule, not the merge check.
test("only the lead deletes a merged branch of a factory-own repo", () => {
  const isMerged = (repo: string, branch: string) => repo === "acme/workspace" && branch !== "wip-2";
  const as = (role: string): GuardContext => ({ ...pr, role, isMerged });
  const del = (repo: string, branch: string) => `gh api -X DELETE repos/${repo}/git/refs/heads/${branch}`;
  assert.equal(verdict(del("acme/workspace", "done-1"), as("lead")), null);
  assert.equal(verdict(`gh api --method=DELETE repos/acme/workspace/git/refs/heads/feature/done`, as("lead")), null);
  const refused = {
    "an assistant": verdict(del("acme/workspace", "done-1"), as("assistant")),
    "a builder": verdict(del("acme/workspace", "done-1"), as("builder")),
    "a product repo": verdict(del("acme/api", "done-1"), as("lead")),
    "an unmerged branch": verdict(del("acme/workspace", "wip-2"), as("lead")),
    "a protected branch": verdict(del("acme/workspace", "main"), as("lead")),
    "git push --delete": verdict("git push origin --delete done-1", as("lead")),
  };
  for (const [what, reason] of Object.entries(refused)) assert.notEqual(reason, null, `${what} should be refused`);
  assert.match(refused["an unmerged branch"] as string, /not merged/);
});

// The lead undrafts a product PR of the --org by hand as well as through `factory pr-open-for-review`;
// nobody else does, and nobody at all outside the org or without naming the repo.
test("only the lead undrafts a product-repo PR", () => {
  const as = (role: string): GuardContext => ({ ...pr, role });
  for (const c of ["gh pr ready 8250 -R acme/api", "gh pr ready 8250 --repo acme/api", "gh pr ready https://github.com/acme/api/pull/8250", "gh pr ready 8250 -R Acme/api"])
    assert.equal(verdict(c, as("lead")), null, c);
  const refused = {
    "a builder": verdict("gh pr ready 8250 -R acme/api", as("builder")),
    "a reviewer": verdict("gh pr ready 8250 -R acme/api", as("reviewer")),
    "an assistant": verdict("gh pr ready 8250 -R acme/api", as("assistant")),
    "outside the org": verdict("gh pr ready 1 -R other/api", as("lead")),
    "no repo named": verdict("gh pr ready 8250", as("lead")),
  };
  for (const [what, reason] of Object.entries(refused)) assert.notEqual(reason, null, `${what} should be refused`);
  // the factory's own repos are unchanged: the lead and its assistants undraft them to merge them
  assert.equal(verdict("gh pr ready 3 -R acme/workspace", as("assistant")), null);
});

// The refusal says how the lead undrafts, by where the workspace's PRs leave draft: undrafting(ws).
// With colleague review off, pr-open-for-review refuses, so the text never sends anyone there.
test("the undraft refusal names pr-open-for-review only where colleague review is on", () => {
  const builder = { ...pr, role: "builder" };
  const say = (ctx: GuardContext) => [verdict("gh pr ready 8250 -R acme/api", ctx) ?? "", verdict("gh pr ready 8250", { ...ctx, role: "lead" }) ?? ""];
  for (const r of say({ ...builder, undrafting: "colleague-review" })) {
    assert.match(r, /factory pr-open-for-review <TICKET>/, r);
    assert.doesNotMatch(r, /pr-send/, r);
  }
  for (const r of say({ ...builder, undrafting: "your-review" })) {
    assert.match(r, /gh pr ready <n> -R owner\/repo` once its item is in your-review \(colleague review is off here, so pr-open-for-review refuses\)/, r);
    assert.doesNotMatch(r, /by `factory pr-open-for-review|pr-send/, r);
  }
  for (const r of say({ ...builder, undrafting: null })) {
    assert.match(r, /by `gh pr ready <n> -R owner\/repo`/, r);
    assert.doesNotMatch(r, /pr-open-for-review|pr-send/, r);
  }
});

// Unstubbed, the guard reads the workspace it is given, for both refusals: a builder's undraft with
// -R, and the lead's without --repo. A workspace that cannot be found or does not load is no throw:
// the guard refuses with the text that holds in both modes.
test("the undraft refusal reads the session's workspace, and refuses plainly without one", () => {
  const refusals = (workspace: string) => {
    const r = [verdict("gh pr ready 8250 -R acme/api", { ...pr, role: "builder", workspace }), verdict("gh pr ready 8250", { ...pr, role: "lead", workspace })];
    for (const v of r) assert.notEqual(v, null);
    return r as string[];
  };
  for (const r of refusals(tempWorkspace(`${TOML}\n[gate]\ncolleague_review = false\n`))) {
    assert.match(r, /by `gh pr ready <n> -R owner\/repo` once its item is in your-review \(colleague review is off here, so pr-open-for-review refuses\)/, r);
    assert.doesNotMatch(r, /by `factory pr-open-for-review|pr-send/, r);
  }
  for (const r of refusals(tempWorkspace(TOML))) {
    assert.match(r, /by `factory pr-open-for-review <TICKET>` or `gh pr ready <n> -R owner\/repo`/, r);
    assert.doesNotMatch(r, /pr-send/, r);
  }
  const broken = tempWorkspace(TOML);
  writeFileSync(join(broken, "factory.toml"), "[gate]\ncolleague_review = \"maybe\"\n");
  for (const workspace of [join(broken, "no-such-dir"), broken]) {
    let r: string[] = [];
    assert.doesNotThrow(() => { r = refusals(workspace); }, workspace);
    for (const v of r) {
      assert.match(v, /undrafting a product-repo PR is the lead's, by `gh pr ready <n> -R owner\/repo`(;|$)/, v);
      assert.doesNotMatch(v, /pr-open-for-review|your-review|pr-send/, v);
    }
  }
});

// A refspec with an empty source deletes the destination; every role is refused, by remote name or URL.
test("a :branch refspec is a refused delete for every role", () => {
  // +:CL-1 is refused by the + refspec rule before it reaches the delete rule; it stays here as a pin.
  const cmds = ["git push origin :CL-1", "git push origin :refs/heads/CL-1", "git push origin HEAD:CL-1 :CL-2", "git push origin +:CL-1",
    "git push https://github.com/acme/workspace.git :CL-1", "git push https://github.com/acme/api.git :CL-1"];
  const allowed = ["lead", "assistant", "builder"].flatMap((role) =>
    cmds.filter((c) => verdict(c, { ...pr, role }) === null).map((c) => `${role}: ${c}`));
  assert.deepEqual(allowed, []);
});

// A grep's redaction can miss a key in a config file. Every role refuses to print a secret file,
// filtered or not.
test("no role prints a secret file; checking a key is set, writing and editing one stay allowed", () => {
  const refused = [
    "grep -n UPCLOUD lyyti-classic/lyyti-config.php", "grep -rn KEY /w/lyyti-config.php | sed 's/=.*/=***/'",
    "cat .env", "cat api/.env | sed -E 's/(KEY=).*/\\1***/'", "head -5 .env.local", "tail .env.testing", "less ~/.config/superfactory/github.token",
    "awk -F= '{print $1}' .env", "sed -n 1,5p .env", "sed 's/=.*//' .env", "jq . ~/.codex/auth.json", "rg KEY .env", "grep -E KEY .env*",
    "cut -d= -f1 < .env", "while read l; do echo ${l%%=*}; done < .env", "base64 lyyti-config.php", "diff .env .env.example",
    "cp .env /tmp/env.txt", "python3 -c \"print(open('.env').read())\"", "php -r 'echo file_get_contents(\"lyyti-config.php\");'",
    "echo $(cat .env)", "cd api && cat .env",
  ];
  const allowed = [
    "grep -q '^ANTHROPIC_API_KEY=' lyyti-config.php && echo set", "grep -c KEY .env", "grep -l KEY .env .env.local", "grep -qE '^KEY=' .env",
    "test -f .env", "[ -f lyyti-config.php ] && echo present", "ls -la .env", "stat .env", "wc -l .env",
    "echo 'KEY=x' >> .env", "cat > .env <<'EOF'\nKEY=x\nEOF", "cp .env.example .env", "cp .env .env.bak", "sed -i '' 's/^A=.*/A=b/' .env",
    "cat .env.example", "grep KEY .env.example", "node -e 'console.log(process.env.HOME)'", "bash -c 'grep -q KEY .env && echo set'",
    "git check-ignore -q .env", "cat README.md",
  ];
  for (const ctx of [pr, { ...pr, role: "lead" }]) {
    assert.deepEqual(refused.filter((c) => verdict(c, ctx) === null), [], `${ctx.role} printed a secret`);
    assert.deepEqual(allowed.filter((c) => verdict(c, ctx) !== null).map((c) => `${c}: ${verdict(c, ctx)}`), [], `${ctx.role} was refused a safe command`);
  }
  // readonly sessions refuse them too; writing is theirs to refuse anyway
  assert.deepEqual(["cat .env", "grep KEY lyyti-config.php"].filter((c) => verdict(c, ro) === null), []);
  assert.equal(verdict("grep -q KEY .env", ro), null);
});

test("a [ in a grep pattern is read as the shell reads it, not as a guard failure", () => {
  const as = { ...pr, role: "assistant" };
  const patterns = [
    `grep -n -I -E "interface Stack|type Stack|stacks\\[|StackConfig" src/config.ts`,
    `grep -n -B2 -A12 "^\\[stacks" examples/factory.toml`,
    `git diff | grep -E "^[-+][^-+]"`,
    `grep -n "= \\[" factory.toml`,
  ];
  for (const c of patterns) assert.equal(verdict(c, as), verdict(c.replace(/\\?\[/g, ""), as), c);
  assert.deepEqual(patterns.map((c) => verdict(c, as)), [null, null, null, null]);
  // the same words still name a secret when the shell would expand them to one
  assert.match(verdict("cat .env[^-+]local", as) ?? "", /holds secrets/);
  assert.equal(verdict("cat .env[", as), null);
});

// The export form runs where a `PATH=… npm test` is refused.
test("an exported or declared override is refused as the prefix form is", () => {
  const sanchez = "export JAVA_HOME=/opt/homebrew/opt/openjdk PATH=/opt/homebrew/opt/openjdk/bin:$PATH && npm test";
  const prefix = verdict('PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test', pr);
  assert.equal(prefix, "environment override PATH is not allowed");
  for (const ctx of [pr, ro]) {
    assert.equal(verdict(sanchez, ctx), prefix);
    for (const cmd of [
      "export HOME=/x", "export GIT_DIR=/x/.git && git log", "declare -x PATH=/x", "typeset -gx GIT_WORK_TREE=/x",
      "declare PATH=/x", "typeset HOME=/x", "readonly PATH=/x", "local GIT_DIR=/x/.git",
    ])
      assert.match(verdict(cmd, ctx) ?? "", /^environment override (HOME|GIT_DIR|PATH|GIT_WORK_TREE) is not allowed$/, cmd);
    for (const cmd of ["export JAVA_HOME=/x && echo ok", "export PATH", "declare PATH_NOTE=x", "typeset -r X=1"]) assert.equal(verdict(cmd, ctx), null, cmd);
  }
});

// A heredoc's body is dropped, but the line after its closing delimiter is a command of its own: a
// `gh pr close` there is not cat's argument.
test("the command after a heredoc is checked", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const write = "cat > /tmp/close3374.md <<'EOF'\n> Written by agent.\nClosing: superseded.\nEOF\n";
  for (const c of [`${write}gh pr close 3374 -R acme/api --comment "$(cat /tmp/close3374.md)"`, `${write}gh pr merge 3374 -R acme/api`])
    assert.notEqual(verdict(c, lead), null, c);
});

// A product PR closes only when the human named that exact PR and `factory allow-close` recorded it; a
// merge never does.
test("the lead closes a product PR only once the human has named it", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const r = factory(dir, ["allow-close", "api", "8701", "--words", "I allow you to close the PR"]);
  assert.equal(r.status, 0, r.stderr);
  const lead: GuardContext = { ...pr, role: "lead", allowClose: allowClosePath(openWorkspace(dir).stateDir) };
  for (const c of ["gh pr close 8701 -R acme/api", "gh pr close 8701 --repo Acme/api --comment '> Written by agent. Superseded by #8702'",
    "gh pr close https://github.com/acme/api/pull/8701", "gh pr close https://github.com/acme/api/pull/8701/files -c '> Written by agent. x'"])
    assert.equal(verdict(c, lead), null, c);
  // Its close comment is still a comment under the human's login.
  for (const c of ["gh pr close 8701 --repo Acme/api --comment 'Superseded by #8702'",
    "cat > /tmp/c.md <<'EOF'\n> Written by agent. Superseded.\nEOF\ngh pr close 8701 -R acme/api --comment \"$(cat /tmp/c.md)\""])
    assert.match(verdict(c, lead) ?? "", /Written by agent/, c);
  const refused = {
    "an unrecorded PR": verdict("gh pr close 8702 -R acme/api", lead),
    "the same number in another repo": verdict("gh pr close 8701 -R acme/web", lead),
    "a merge of the recorded PR": verdict("gh pr merge 8701 -R acme/api", lead),
    "a squash merge by URL": verdict("gh pr merge https://github.com/acme/api/pull/8701 --squash", lead),
    "a lock of the recorded PR": verdict("gh pr lock 8701 -R acme/api", lead),
    "no number": verdict("gh pr close -R acme/api", lead),
    "a branch name": verdict("gh pr close CL-1 -R acme/api", lead),
    "two selectors": verdict("gh pr close 8701 8702 -R acme/api", lead),
    "a URL and --repo that disagree": verdict("gh pr close https://github.com/acme/web/pull/8701 -R acme/api", lead),
    "--delete-branch": verdict("gh pr close 8701 -R acme/api --delete-branch", lead),
    "no repo": verdict("gh pr close 8701", lead),
    "an assistant": verdict("gh pr close 8701 -R acme/api", { ...lead, role: "assistant" }),
    "a lead with no list": verdict("gh pr close 8701 -R acme/api", { ...pr, role: "lead" }),
    // gh takes -R/--repo before pr, or before its subcommand
    "a merge, -R before pr": verdict("gh -R acme/api pr merge 8701", lead),
    "a merge, --repo= before merge": verdict("gh pr --repo=acme/api merge 8701 --squash", lead),
    "a lock, --repo before pr": verdict("gh --repo acme/api pr lock 8701", lead),
    "an unrecorded PR, -R before pr": verdict("gh -R acme/api pr close 8702", lead),
  };
  for (const [what, reason] of Object.entries(refused)) assert.notEqual(reason, null, `${what} should be refused`);
  assert.match(refused["an unrecorded PR"] as string, /acme\/api#8702 is not on the allow-close list; .*factory allow-close <repo-key> <n> --words/);
  assert.match(refused["a merge of the recorded PR"] as string, /^merge of a PR on a product repo/);
  assert.match(refused["no number"] as string, /needs its number or URL/);
  assert.match(refused["a merge, -R before pr"] as string, /^merge of a PR on a product repo/);
  assert.match(refused["a lock, --repo before pr"] as string, /^lock of a PR on a product repo/);
  assert.match(refused["an unrecorded PR, -R before pr"] as string, /acme\/api#8702 is not on the allow-close list/);
  assert.equal(verdict("gh -R acme/api pr close 8701", lead), null);
  assert.equal(verdict("gh pr -R acme/api close 8701 -c '> Written by agent. superseded'", lead), null);
  // the factory's own repos are unchanged
  assert.equal(verdict("gh pr close 3 -R acme/workspace", { ...pr, role: "assistant" }), null);
  // the words are the permission
  assert.notEqual(factory(dir, ["allow-close", "api", "8703"]).status, 0);
  assert.notEqual(factory(dir, ["allow-close", "nope", "8703", "--words", "x"]).status, 0);
});

// gh runs a user alias, a shell alias or an extension as readily as its own commands, and the guard
// cannot know what one does: `gh alias set m 'pr merge'` then `gh m 8701 -R acme/api` was a product
// merge in two calls. Only gh's built-in commands pass, and aliases and extensions cannot be made.
test("a gh alias or extension is refused, and so is making one", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const refused = ["gh alias set m 'pr merge'", "gh m 8701 -R acme/api", "gh -R acme/api m 8701", "gh alias set pc 'pr comment'",
    "gh pc 1 -b hi", "gh alias set --shell x 'gh pr merge 8701 -R acme/api'", "gh x", "gh alias import a.yml", "gh alias delete co",
    "gh co 12", "gh extension install o/gh-x", "gh ext install o/gh-x", "gh extensions upgrade --all", "gh extension exec x",
    "command gh m 8701 -R acme/api", "gh -- m 8701", "bash -c 'gh m 8701 -R acme/api'"];
  const allowed = ["gh pr checkout 12", "gh pr co 12", "gh alias list", "gh alias ls", "gh ext list", "gh pr view 1", "gh --version", "gh --help", "gh help", "gh -R acme/api pr checks 1",
    // gh's own `version` and its help topics are no alias
    "gh version", "gh accessibility", "gh a11y", "gh actions", "gh environment", "gh reference", "gh exit-codes", "gh formatting",
    "gh mintty", "gh telemetry"];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (!/aliases and extensions can't be checked/.test(verdict(c, ctx) ?? "")) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// The guard's matcher was Bash|Read|Grep, so the GitHub MCP tools merged, closed and commented past
// it. Now a merge, close or undraft is checked as its gh command, a comment needs the marker, a
// commit to a protected branch is refused, an unknown write is refused, and reads pass.
test("the GitHub MCP tools are held to the gh rules", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(factory(dir, ["allow-close", "api", "8701", "--words", "I allow you to close the PR"]).status, 0);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const lead: GuardContext = { ...pr, role: "lead", leadMerges: ["acme/web"], allowClose: allowClosePath(openWorkspace(dir).stateDir) };
  const api = { owner: "acme", repo: "api" };
  const M = "> Written by agent. done";
  type Row = [string, Record<string, unknown>, GuardContext];
  const refused: Row[] = [
    ["merge_pull_request", { ...api, pullNumber: 8701 }, lead],
    ["merge_pull_request", { ...api, pullNumber: 8701, merge_method: "squash" }, pr],
    ["merge_pull_request", { owner: "acme", repo: "web", pullNumber: 506 }, lead], // no head
    ["merge_pull_request", { owner: "acme", repo: "web", pullNumber: 506, expectedHeadSha: sha }, pr],
    ["update_pull_request", { ...api, pullNumber: 8702, state: "closed" }, lead],
    ["update_pull_request", { ...api, pullNumber: 8701, state: "closed" }, pr],
    ["update_pull_request", { ...api, pullNumber: 8701, draft: false }, pr],
    ["add_issue_comment", { ...api, issue_number: 1, body: "hi" }, pr],
    ["add_reply_to_pull_request_comment", { ...api, pullNumber: 1, commentId: 2, body: "fixed" }, lead],
    ["pull_request_review_write", { ...api, pullNumber: 1, method: "create", event: "COMMENT", body: "lgtm" }, pr],
    ["update_issue_comment", { ...api, comment_id: 3, body: "edited" }, pr],
    ["push_files", { ...api, branch: "main", files: [], message: "x" }, pr],
    ["create_or_update_file", { ...api, branch: "master", path: "a", content: "", message: "x" }, lead],
    ["delete_file", { ...api, branch: "main", path: "a", message: "x" }, pr],
    // a product repo's own default branch, no branch at all, or a default the guard cannot read
    ["push_files", { owner: "acme", repo: "trunk-repo", branch: "trunk", files: [], message: "x" }, pr],
    ["create_or_update_file", { ...api, path: "a", content: "", message: "x" }, pr],
    ["delete_file", { owner: "acme", repo: "offline", branch: "fix-x", path: "a", message: "x" }, lead],
    ["create_repository", { name: "x" }, lead],
    ["delete_repository", { ...api }, lead],
    ["fork_repository", { ...api }, pr],
    ["some_future_write", {}, lead],
    ["add_issue_comment", { ...api, issue_number: 1, body: M }, ro],
    ["create_pull_request", { ...api, title: "t", head: "x", base: "main" }, ro],
  ];
  const allowed: Row[] = [
    ["get_me", {}, ro], ["pull_request_read", { ...api, pullNumber: 1, method: "get" }, ro], ["list_pull_requests", api, pr],
    ["search_code", { query: "x" }, ro], ["issue_read", { ...api, issue_number: 1, method: "get" }, pr],
    ["merge_pull_request", { owner: "acme", repo: "web", pullNumber: 506, expectedHeadSha: sha, merge_method: "squash" }, lead],
    ["merge_pull_request", { owner: "acme", repo: "workspace", pullNumber: 3 }, pr],
    ["update_pull_request", { ...api, pullNumber: 8701, state: "closed" }, lead],
    ["update_pull_request", { ...api, pullNumber: 8701, title: "t", body: "unmarked description" }, pr],
    ["update_pull_request", { ...api, pullNumber: 8701, draft: true }, pr],
    ["add_issue_comment", { ...api, issue_number: 1, body: M }, pr],
    ["add_issue_comment", { ...api, issue_number: 1, body: "@coderabbitai review" }, pr],
    ["pull_request_review_write", { ...api, pullNumber: 1, method: "resolve_thread", threadId: "PRRT_x" }, pr],
    ["create_pull_request", { ...api, title: "t", head: "x", base: "main", draft: true }, pr],
    ["push_files", { ...api, branch: "fix-x", files: [], message: "x" }, pr],
    ["push_files", { owner: "acme", repo: "trunk-repo", branch: "fix-x", files: [], message: "x" }, pr],
    ["create_or_update_file", { owner: "acme", repo: "workspace", branch: "main", path: "a", content: "", message: "x" }, pr],
    ["issue_write", { ...api, method: "create", title: "t" }, pr],
  ];
  // a GitHub tool is known by its tool name whatever its server is called
  refused.push(["issue_write", { ...api, method: "update", issue_number: 8701, state: "closed" }, pr],
    ["issue_write", { ...api, method: "update", issue_number: 8702, state: "closed" }, lead]);
  allowed.push(["issue_write", { ...api, method: "update", issue_number: 8701, state: "closed" }, lead]);
  // state=open reopens, as gh pr reopen and gh issue reopen do; updating a PR's branch writes to its
  // head, which must be a branch the role may write
  // 8704 is a PR into the factory's own repo from a product repo's default branch
  const heads: Record<string, [string, string]> = { "8701": ["acme/api", "feat/x"], "8702": ["acme/api", "main"], "8703": ["acme/workspace", "main"], "8704": ["acme/api", "main"] };
  const withHeads: GuardContext = { ...pr, prHead: (_r, n) => heads[n] ?? null };
  refused.push(["update_pull_request", { ...api, pullNumber: 8701, state: "open" }, pr],
    ["update_pull_request", { ...api, pullNumber: 8701, state: "open" }, lead],
    ["issue_write", { ...api, method: "update", issue_number: 8702, state: "open" }, pr],
    ["update_pull_request_branch", { ...api, pullNumber: 8702 }, withHeads],
    ["update_pull_request_branch", { ...api, pullNumber: 8709 }, withHeads], // head unreadable
    ["update_pull_request_branch", { owner: "acme", repo: "workspace", pullNumber: 8704 }, withHeads],
    ["update_pull_request_branch", { ...api, pullNumber: 8701 }, { ...withHeads, defaultBranch: () => null }]);
  allowed.push(["update_pull_request_branch", { ...api, pullNumber: 8701 }, withHeads],
    ["update_pull_request_branch", { ...api, pullNumber: 8703 }, withHeads],
    ["update_pull_request_branch", { owner: "acme", repo: "workspace", pullNumber: 8709 }, withHeads],
    ["update_pull_request", { owner: "acme", repo: "workspace", pullNumber: 3, state: "open" }, lead],
    // a create opens an issue whatever its state says
    ["issue_write", { ...api, method: "create", title: "t", state: "open" }, pr],
    ["issue_write", { ...api, method: "create", title: "t", state: "closed" }, pr]);
  const named: [string, Record<string, unknown>, GuardContext][] = [
    ["mcp__gh__merge_pull_request", { ...api, pullNumber: 8701 }, pr], ["mcp__GitHub__merge_pull_request", { ...api, pullNumber: 8701 }, lead],
    ["mcp__github_2__update_pull_request", { ...api, pullNumber: 8701, state: "closed" }, pr],
    ["mcp__foo__issue_write", { ...api, method: "update", issue_number: 8702, state: "closed" }, lead],
    ["mcp__claude_ai_GitHub__add_issue_comment", { ...api, issue_number: 1, body: "hi" }, pr],
    ["mcp__GitHub__some_future_write", {}, lead], ["mcp__github_2__delete_repository", api, pr]];
  const others: [string, Record<string, unknown>, GuardContext][] = [
    ["mcp__plane__update_issue", { state: "closed" }, pr], ["mcp__claude_ai_Slack__x", {}, lead], ["mcp__home-assistant__call_service", {}, pr],
    ["mcp__plane__update_issue", { state: "closed" }, ro], ["mcp__GitHub__get_me", {}, ro], ["mcp__github_2__pull_request_read", api, pr]];
  const wrong: string[] = [];
  for (const [t, tin, ctx] of named) if (mcpVerdict(t, tin, ctx) === null) wrong.push(`${ctx.role} allowed: ${t} ${JSON.stringify(tin)}`);
  for (const [t, tin, ctx] of others) if (mcpVerdict(t, tin, ctx) !== null) wrong.push(`${ctx.role} refused: ${t} (${mcpVerdict(t, tin, ctx)})`);
  for (const [t, tin, ctx] of refused) if (mcpVerdict(`mcp__github__${t}`, tin, ctx) === null) wrong.push(`${ctx.role} allowed: ${t} ${JSON.stringify(tin)}`);
  for (const [t, tin, ctx] of allowed) {
    const why = mcpVerdict(`mcp__github__${t}`, tin, ctx);
    if (why !== null) wrong.push(`${ctx.role} refused: ${t} ${JSON.stringify(tin)} (${why})`);
  }
  assert.deepEqual(wrong, []);
  // the hook routes the MCP tools to this check
  const argv = ["--role", "builder", "--policy", "protect", "--org", "acme", "--own-repo", "acme/workspace"];
  const call = (tool_name: string, tool_input: Record<string, unknown>) => hook(argv, JSON.stringify({ tool_name, tool_input }));
  const merge = call("mcp__github__merge_pull_request", { ...api, pullNumber: 8701 });
  assert.equal(merge.code, 2);
  assert.match(merge.stderr ?? "", /merge of a PR on a product repo/);
  assert.equal(call("mcp__github__add_issue_comment", { ...api, issue_number: 1, body: "hi" }).code, 2);
  assert.equal(call("mcp__github__get_me", {}).code, 0);
  assert.equal(call("mcp__GitHub__merge_pull_request", { ...api, pullNumber: 8701 }).code, 2);
  assert.equal(call("mcp__plane__update_issue", { state: "closed" }).code, 0);
});

// A gh or git run by path skipped protect, because a path outside the trusted bin dirs was taken for a
// project script, and a command word from a variable matched no check. Now a path is
// read by its basename, and a variable or substitution as the command word is refused.
test("a gh or git by path is checked as itself, and one from a variable is refused", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const refused = ["~/.local/bin/gh pr merge 8701 -R acme/api", "/home/turing/.local/bin/gh pr close 8701 -R acme/api",
    "$HOME/.local/bin/gh pr merge 8701 -R acme/api", "./gh pr merge 8701 -R acme/api", "./node_modules/.bin/gh pr merge 8701 -R acme/api",
    "$G pr merge 8701 -R acme/api", "\"$G\" pr merge 8701 -R acme/api", "${G} pr view 1", "~/.local/bin/gh m 1",
    "/usr/lib/git-core/git push origin main", "$GIT push origin main", "~/bin/bash -c \"gh pr merge 8701 -R acme/api\"",
    "/usr/bin/env gh pr merge 8701 -R acme/api", "/usr/bin/env ~/.local/bin/gh pr lock 8701 -R acme/api",
    "$(which gh) pr merge 8701 -R acme/api", "env $(which gh) pr merge 8701 -R acme/api", "\"$(which gh)\" pr merge 8701 -R acme/api", "`which gh` pr merge 8701 -R acme/api", "cd x && $G pr merge 8701 -R acme/api"];
  const allowed = ["~/.local/bin/gh pr view 1", "./scripts/test.sh", "echo $(date) done", "X=$(git rev-parse HEAD) && echo $X", "./node_modules/.bin/vitest run", "/usr/bin/git status",
    "~/.local/bin/gh pr list -R acme/api", "/usr/lib/git-core/git push -u origin fix-x", "vendor/bin/phpunit"];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
  assert.match(verdict("$G pr view 1", pr) as string, /run it by its name or its plain path/);
});

// gh api reached a product PR's state, its lock and the repo itself, and GraphQL merged and closed
//. A write that does so on a repo not the factory's own is refused.
test("gh api cannot close, lock, merge or delete on a product repo", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const gql = (q: string) => `gh api graphql -f query='mutation { ${q} { clientMutationId } }'`;
  const refused = ["gh api -X PATCH repos/acme/api/pulls/8701 -f state=closed", "gh api -X PATCH repos/acme/api/issues/8701 -f state=closed",
    "gh api repos/acme/api/issues/8701 -f state=closed", "gh api --method=PATCH /repos/acme/api/pulls/8701 -F state=closed",
    "gh api -XPATCH repos/acme/api/pulls/8701 --raw-field=state=closed", "gh api -X PATCH repos/acme/api/pulls/8701 --input body.json",
    "gh api -X PATCH 'repos/{owner}/{repo}/pulls/8701' -f state=closed", "gh api -X PUT repos/acme/api/issues/8701/lock", "gh api -X DELETE repos/acme/api/issues/8701/lock",
    "gh api -X DELETE repos/acme/api", "gh api -X PATCH repos/acme/api -f archived=true",
    gql(`mergePullRequest(input: {pullRequestId: "x"})`), gql(`closePullRequest(input: {pullRequestId: "x"})`),
    gql(`enablePullRequestAutoMerge(input: {pullRequestId: "x"})`), gql(`deleteRepository(input: {repositoryId: "x"})`),
    gql(`lockLockable(input: {lockableId: "x"})`), gql(`updatePullRequest(input: {pullRequestId: "x", state: CLOSED})`),
    "gh api graphql -F query=@m.graphql", "gh api graphql --input q.json", "gh api graphql -f query=\"$(cat m.graphql)\""];
  const allowed = ["gh api repos/acme/api/pulls/8701", "gh api -X GET repos/acme/api/pulls -f state=closed",
    "gh api repos/acme/api/issues/8701/comments -f body='> Written by agent. x'", "gh api graphql -f query='query { viewer { login } }'",
    "gh api -X PATCH repos/acme/workspace/pulls/3 -f state=closed", "gh api -X PATCH repos/acme/api/pulls/8701 -f title=x",
    gql(`addComment(input: {subjectId: "x", body: "> Written by agent. will merge after CI"})`)];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// gh api can merge a branch into main, commit to it and transfer the repo. On a product repo those are
// refused, and a contents write must name a feature branch.
test("gh api cannot merge, commit to main or transfer on a product repo", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const gql = (q: string) => `gh api graphql -f query='mutation { ${q} { clientMutationId } }'`;
  const put = "gh api -X PUT repos/acme/api/contents/a.txt -f message=m -f content=eA==";
  const refused = [put, `${put} -f branch=main`, `${put} -f branch=refs/heads/master`, `${put} --input body.json`,
    "gh api -X DELETE repos/acme/api/contents/a.txt -f message=m -f sha=abc", "gh api --method PUT /repos/acme/api/contents/src/a.ts -F message=m -F content=@a.b64",
    "gh api -X POST repos/acme/api/merges -f base=main -f head=feat", "gh api repos/acme/api/merges -f base=feat/x -f head=main",
    "gh api -X POST repos/acme/api/transfer -f new_owner=x",
    gql(`enqueuePullRequest(input: {pullRequestId: "x"})`), gql(`createCommitOnBranch(input: {branch: {branchName: "main"}})`)];
  // the repo's own default branch, whatever it is called, and one the guard cannot read
  const trunk = "gh api -X PUT repos/acme/trunk-repo/contents/a.txt -f message=m -f content=eA==";
  refused.push(`${trunk} -f branch=trunk`, `${trunk} -f branch=refs/heads/Trunk`,
    "gh api -X PUT repos/acme/offline/contents/a.txt -f message=m -f content=eA== -f branch=feat/x");
  const allowed = ["gh api -X PUT repos/acme/workspace/contents/a.txt -f message=m -f content=eA==", `${put} -f branch=feat/x`,
    "gh api repos/acme/api/contents/a.txt", "gh api repos/acme/api/merges", `${trunk} -f branch=feat/x`];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// Plain forms: a {branch} gh fills from the checkout, a PR's branch updated
// with its head on main, a `#` comment line before the command, a heredoc opened inside a comment, a
// terminator with a trailing space, and the stdin a scheduler really reads.
test("comments, placeholders, branch updates and a scheduler's stdin are read as bash and gh read them", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const heads: Record<string, [string, string]> = { "8701": ["acme/api", "feat/x"], "8702": ["acme/api", "main"], "8704": ["acme/api", "main"] };
  const M = "gh pr merge 8701 -R acme/api";
  const put = "gh api -X PUT repos/acme/api/contents/a.txt -f message=m -f content=eA==";
  const refused = [`${put} -F branch={branch}`, `${put} -f branch={branch}`, `${put} -F 'branch={owner}-x'`,
    "gh pr update-branch 8702 -R acme/api", "gh pr update-branch https://github.com/acme/api/pull/8702 --rebase",
    "gh pr update-branch 8709 -R acme/api", "gh pr update-branch 8701", "gh pr update-branch -R acme/api",
    // the same write by the API
    "gh api -X PUT repos/acme/api/pulls/8702/update-branch", "gh api --method put /repos/acme/api/pulls/8702/update-branch/",
    "gh api -XPUT https://api.github.com/repos/acme/api/pulls/8702/update-branch", "gh api repos/acme/api/pulls/8702/update-branch -f update_method=rebase",
    "gh api -X PUT repos/{owner}/{repo}/pulls/8701/update-branch", "gh api -X PUT repos/acme/api/pulls/$N/update-branch",
    "R=acme/api; gh api -X PUT repos/$R/pulls/8701/update-branch", "gh api -X PUT repos/acme/api/pulls/8709/update-branch",
    // and by GraphQL, whose node id the guard cannot read a head from; a PR into the factory's repo
    // from a product repo's default branch; a URL gh takes over a --repo that names another repo
    `gh api graphql -f query='mutation { updatePullRequestBranch(input: {pullRequestId: "PR_x"}) { clientMutationId } }'`,
    "gh pr update-branch 8704 -R acme/workspace", "gh api -X PUT repos/acme/workspace/pulls/8704/update-branch",
    "gh pr update-branch -R acme/workspace https://github.com/acme/api/pull/8702",
    "gh pr close -R acme/workspace https://github.com/acme/api/pull/8701", "gh pr merge --repo=acme/workspace https://github.com/acme/api/pull/8701",
    // a ) in a comment does not end a $( ... ); \<< opens no heredoc; an unquoted heredoc's EO\ and F end it
    `echo "$(true # )\n${M})"`, `echo x \\<<EOF\n${M}\nEOF`, `cat <<EOF\nEO\\\nF\n${M}\nEOF`,
    `# Merge it\n${M}`, `#!/bin/sh\n${M}`, `ls  # a\n${M}`, `ls \\\n# x\n${M}`, `echo a#b; ${M}`,
    `# see <<EOF\n${M}\nEOF`, `echo x # <<EOF\n${M}\nEOF`,
    `echo '<<EOF'\n${M}\nEOF`, `printf '%s' "cat <<'E'"\n${M}\nE`, `echo "$(echo ')')" '<<EOF'\n${M}\nEOF`,
    `cat <<EOF\nEOF \n${M}\nEOF\n${M}`, `echo '${M}' | at now`, `at now <<< true <<< '${M}'`,
    'echo "`date`"', "echo a`date`", "ssh h 'echo `date`'"];
  const allowed = [`${put} -F branch=feat/x`, `at now <<< true < /dev/null`,
    "gh pr update-branch 8701 -R acme/api", "gh pr update-branch 3 -R acme/workspace",
    "gh api -X PUT repos/acme/api/pulls/8701/update-branch", "gh api -X PUT repos/acme/api/pulls/8701/update-branch -f update_method=rebase",
    "gh api repos/acme/api/pulls/8702/update-branch", "gh api -X PUT repos/acme/workspace/pulls/3/update-branch",
    "gh pr merge 3 -R acme/workspace -t https://github.com/acme/api/pull/8701", `ls \\\n# it's\nls`,
    `cat <<'EOF'\nEO\\\nF\nit's\nEOF`, `echo "$(true # it's (x\n)"`,
    "# Run the checks\nnpm test", `ls # ; ${M}`, `echo '#'; ls`, `echo "a #b"`, `echo a\\#b`,
    `printf 'cat <<EOF\\n$(date\\nEOF\\n'`, `x="$(cat <<'E'\nit's\nE\n)"; echo "$x"`,
    `cat <<EOF\nEOF \nit's\nEOF`, `echo "#" <<EOF\nit's\nEOF`, `echo "it's" | at now <<< true`, `echo "it's" | at now < job.txt`,
    // a backtick in single quotes is a letter
    "echo '`date`'", "echo \\`date\\`", `ssh h 'python3 - <<"E"\nprint("\`x\`")\nE'`];
  const wrong: string[] = [];
  for (const base of [pr, lead]) {
    const ctx = { ...base, prHead: (_r: string, n: string) => heads[n] ?? null };
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${JSON.stringify(c)}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${JSON.stringify(c)} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
  // a heredoc opened in real code before a comment is still a heredoc
  assert.notEqual(verdict(`cat <<EOF # x\nhi\nEOF\n${M}`, lead), null);
});

// An escaped blank inside a $(...) never ends a word, so the # after it is no comment and cannot
// swallow the ). Read as one, it let a push to main through.
test("an escaped blank before a # inside $(...) starts no comment", () => {
  const P = "git push origin main";
  const refused = [
    `echo "$(echo \\ # )"; ${P}; exit #\n)"`, // Marie's
    `echo $(echo \\ # ); ${P}; exit #\n)`, // without the outer double quotes
    `echo "$(echo \\\t# )"; ${P}; exit #\n)"`, // an escaped tab
    `echo \\ # x; ${P}`, // outside $(...)
    `echo "$(echo $(echo \\ # ); ${P}; exit #\n))"`, // nested: the push runs in the outer substitution
    `echo $(echo $(echo \\ # )); ${P}; exit #\n))`, // nested, unquoted
    `echo "$(true # )\n${P})"`, // a real comment still ends at its line
  ];
  // inside double quotes, what follows the substitution is text
  const allowed = [`echo "$(ls # c )\n)"`, `echo "$(echo \\ #x)"`, `echo "$(ls \\\n# c )\n)"`, `echo "$(echo $(echo \\ # )); ${P}; exit #\n))"`];
  const wrong: string[] = [];
  for (const c of refused) if (verdict(c, pr) === null) wrong.push(`allowed: ${JSON.stringify(c)}`);
  for (const c of allowed) if (verdict(c, pr) !== null) wrong.push(`refused: ${JSON.stringify(c)} (${verdict(c, pr)})`);
  assert.deepEqual(wrong, []);
});

// Claude Code lets a call through when its hook times out (10 s), so a GitHub that does not answer
// must end the guard's lookups in time for it to refuse.
test("a GitHub that does not answer is a refusal inside the hook's timeout", () => {
  const dir = mkdtempSync(join(tmpdir(), "slow-gh-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const started = join(dir, "started");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho x >> ${started}\nexec sleep 30\n`, { mode: 0o755 });
  const argv = ["--role", "builder", "--policy", "protect", "--org", "acme", "--own-repo", "acme/workspace"];
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    for (const command of ["gh api -X PUT repos/acme/api/contents/a.txt -f message=m -f content=eA== -f branch=feat/x", "gh pr update-branch 8701 -R acme/api"]) {
      const t0 = Date.now();
      const r = hook(argv, JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
      const took = Date.now() - t0;
      assert.equal(r.code, 2, command);
      // refused by the budget running out on a gh that started and stalled, not by a gh that failed
      assert.ok(existsSync(started) && took >= GITHUB_BUDGET_MS - 300, `${command}: refused after ${took} ms, gh ${existsSync(started) ? "" : "never "}started`);
      rmSync(started, { force: true });
      assert.ok(took < GITHUB_BUDGET_MS + 1_000 && GITHUB_BUDGET_MS + 1_000 < 10_000, `${command}: refused after ${took} ms`);
    }
  } finally {
    process.env.PATH = path;
  }
});

// A push to a branch named by a variable or a substitution could be a push to main.
test("a git push whose ref the guard cannot read is refused", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const refused = ["git push origin $B", "git push -u origin \"$B\"", "git push origin ${B}", "git push origin $(echo main)",
    "git push origin \"$(git branch --show-current)\"", "git push origin HEAD:\"$B\"", "git push origin HEAD:$(echo main)",
    "git push origin feat $(echo main)", "git push origin `echo main`", "git push \"$R\" feat", "git push --force-with-lease origin \"$B\""];
  const allowed = ["git push -u origin feat/x", "git push origin HEAD:feat/x", "git commit -m \"$(date)\"", "B=feat/x && git push -u origin feat/x",
    "echo $(git rev-parse HEAD)"];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
  assert.match(verdict("git push -u origin \"$B\"", pr) as string, /name the branch/);
});

// Stdin by another name, env's clustered flags, find's second
// action, ssh fed on stdin, an unresolvable contents branch; and a heredoc header with a redirect
// after it, whose body was read as commands.
test("stdin by any name, a clustered env flag, every find action and ssh on stdin are checked", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const M = "gh pr merge 1 -R acme/api";
  const put = "gh api -X PUT repos/acme/api/contents/a.txt -f message=m -f content=eA==";
  const refused = [`echo '${M}' | bash -s < /dev/stdin`, `bash /dev/stdin <<< '${M}'`, `echo '${M}' | bash /dev/fd/0`, `echo '${M}' | sh /proc/self/fd/0`,
    `bash - <<< '${M}'`, `env -vS '${M}'`, `env -iS '${M}'`, `env -iS'${M}'`, `env -i -u X ${M}`,
    `find . -exec true \\; -exec ${M} \\;`, `find . -name x -exec true {} + -execdir ${M} {} +`,
    `echo '${M}' | ssh localhost`, `ssh localhost <<< '${M}'`, `ssh localhost < cmds.sh`, `ssh -T localhost <<'E'\n${M}\nE`,
    `${put} -f branch=$B`, `${put} -f "branch=$(echo main)"`, "bash <<E > out\n" + M + "\nE"];
  const allowed = ["cat <<'EOF' > notes.md\ngh pr merge is how we ship\nEOF", "cat <<'EOF' >> n.md\ngh pr merge is how we ship\nEOF",
    "tee n.md <<'EOF' >/dev/null\ngh pr merge is how we ship\nEOF", "cat > notes.md <<'EOF'\ngh pr merge is how we ship\nEOF",
    "bash scripts/x.sh < /dev/null", "env -i LANG=C npm test", "find . -exec true \\; -exec wc -l {} +", "ssh niilo uptime < /dev/null",
    "ssh niilo", "ssh -T niilo <<'E'\nuptime\nE"];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// The program is the file that runs, not its spelling: rsh is ssh, rbash is bash, git-push is git
// push. Links in a temp dir make the rows hold on any box.
test("a command is named by the file that runs", () => {
  const M = "gh pr merge 1 -R acme/api";
  const bin = mkdtempSync(join(tmpdir(), "guard-bin-"));
  after(() => rmSync(bin, { recursive: true, force: true }));
  const env = ["/usr/bin/env", "/bin/env"].find(existsSync) as string;
  const sh = ["/usr/bin/bash", "/bin/bash"].find(existsSync) as string;
  symlinkSync(env, join(bin, "e"));
  symlinkSync(sh, join(bin, "r"));
  symlinkSync(sh, join(bin, "gpush"));
  mkdirSync(join(bin, "git-core"));
  writeFileSync(join(bin, "git-core", "git"), "", { mode: 0o755 });
  symlinkSync("git", join(bin, "git-core", "git-push"));
  writeFileSync(join(bin, "busybox"), "", { mode: 0o755 });
  symlinkSync("busybox", join(bin, "static-sh"));
  // link/.. is the link target's parent, as the kernel walks it, not bin
  mkdirSync(join(bin, "real", "child"), { recursive: true });
  symlinkSync(join(bin, "real", "child"), join(bin, "link"));
  symlinkSync(env, join(bin, "real", "e2"));
  writeFileSync(join(bin, "e2"), "", { mode: 0o755 });
  const refused = [`'${bin}/e' ${M}`, `PATH='${bin}':$PATH e ${M}`, `'${bin}/r' -c '${M}'`, `'${bin}/git-core/git-push' origin main`,
    `'${bin}/git-core/git-push' origin --delete x`, `'${bin}/static-sh' -c '${M}'`, `'${bin}/busybox' env ${M}`, `busybox sh -c '${M}'`,
    `nice '${bin}/e' ${M}`, `ksh93 -c '${M}'`, `tcsh -c '${M}'`, `mksh-static -c '${M}'`, "git-push origin main", `env '${bin}/r' -c '${M}'`,
    `'${bin}/link/../e2' ${M}`];
  for (const [name, row] of [["/usr/bin/rsh", `rsh niilo '${M}'`], ["/usr/bin/rsh", `/usr/bin/rsh niilo '${M}'`], ["/usr/bin/slogin", `slogin niilo '${M}'`],
    ["/usr/bin/rbash", `rbash -c '${M}'`], ["/usr/bin/static-sh", `static-sh -c '${M}'`], ["/usr/bin/busybox", `busybox env ${M}`],
    ["/usr/lib/git-core/git-push", "/usr/lib/git-core/git-push origin main"], ["/usr/lib/git-core/git-push", "/usr/lib/git-core/git-push origin --delete x"]] as const)
    if (existsSync(name)) refused.push(row);
  const allowed = ["git status", "/usr/bin/git status", "ssh niilo uptime", "npm test", "./scripts/report", "~/agents/bin/pr-send.sh 124 abc",
    `'${bin}/e' npm test`, `'${bin}/git-core/git-push' origin feature/x`, "sh -c 'npm test'", "awk 1 x.txt", "python3 -V"];
  const wrong: string[] = [];
  for (const ctx of [pr, { ...pr, role: "lead" }]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// A program the guard does not read may run its arguments, so any later word naming gh, git, ssh, a
// shell or busybox is checked from there; only a program that can never run another, and docker
// run's image word, are skipped.
test("an argument that names a checked program is checked as a command", () => {
  const M = "gh pr merge 1 -R acme/api";
  const bin = mkdtempSync(join(tmpdir(), "guard-argv-"));
  after(() => rmSync(bin, { recursive: true, force: true }));
  const refused = [`ionice -c3 ${M}`, `taskset -c 0 ${M}`, `prlimit ${M}`, `setpriv ${M}`, `unshare -U ${M}`, `strace -o /dev/null ${M}`,
    `chrt -o 0 ${M}`, `setarch x86_64 ${M}`, `linux64 ${M}`, `systemd-run --user --pipe -q ${M}`, `docker exec c ${M}`,
    // the escape forms of the exceptions, and the programs kept scanned
    "man -P gh git", `man -P gh ${M}`, "rg --pre gh x .", "rg --pre=gh x .", "rg --pre-glob '*' --pre gh x .", `command ${M}`,
    `less -f ${M}`, `more ${M}`, `vi -c '!${M}' x`, `view -c ':!${M}' x`, `awk 1 ${M}`, `sed -n p ${M}`, `find . -exec ${M} \\;`,
    `xargs ${M}`, "tar -I gh -cf x.tar .", "tar --to-command=gh -xf x.tar", "rsync -e gh a b:", `make -f x ${M}`,
    `git -c 'core.pager=${M}' log`, `git -c core.sshCommand='${M}' fetch`, `git -c 'diff.x.textconv=${M}' diff`, `docker run --rm img ${M}`, `docker run --rm --name w img sh -c '${M}'`,
    `docker run --rm --entrypoint gh img pr merge 1 -R acme/api`, `docker container create img ${M}`, `watch '${M}'`,
    // a data-only program's arguments are skipped only when it is the command word
    `ionice -c3 echo ${M}`, `strace -f grep x ${M}`,
    // the systemd-run and docker exec forms the transcripts hit stay refused
    'systemd-run --user bash -c "PATH=$P npm test"', 'systemd-run --user --collect bash -c "$SC"',
    "systemd-run --user bash -c 'exec npm test'", "docker exec c sh -c 'head $f/*'"];
  const ionice = ["/usr/bin/ionice", "/bin/ionice"].find(existsSync);
  if (ionice) {
    symlinkSync(ionice, join(bin, "w"));
    refused.push(`'${bin}/w' ${M}`);
  }
  const allowed = ["which gh", "which -a gh hub", "ls ~/.local/bin/gh /usr/local/bin/gh", "ls -l /usr/bin/gh /usr/local/bin/gh", "command -v gh",
    "command -V gh", "type gh", "man git", "grep -rn 'gh pr merge' .", "rg 'gh pr merge' .", "rg -n gh src", "apt-cache show git",
    "dpkg-query -W git", "timeout 5 git status", "ionice -c3 git status", "systemd-run --user --pipe -q npm test", "echo git push origin main",
    "printf '%s\\n' gh git", "readlink -f /bin/sh", "realpath /bin/sh", "stat /usr/bin/gh", "file /bin/sh", "ps aux | grep bash",
    "cat ~/.local/bin/gh | head", "docker run -d --name w busybox sleep 120", "docker create --name w --label x=1 busybox true",
    "docker run --rm -e A=1 -v /x:/y bash:5 true", "docker exec c npm test", "git -c core.pager=cat log", "git -c 'core.pager=less -R' log"];
  const wrong: string[] = [];
  for (const ctx of [pr, { ...pr, role: "lead" }]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// The argv scan starts at any program the guard reads specially, past its wrappers; a string run as a
// shell line is parsed in full, and a string holding shell syntax is read for the commands in it.
// Text into crontab, at and batch is checked as the commands it schedules.
test("strings a program runs and lines it schedules are checked as commands", () => {
  const M = "gh pr merge 1 -R acme/api";
  const refused = [`echo pr merge 1 -R acme/api | ionice -c3 xargs gh`, `ionice -c3 env -S'${M}'`, `ionice -c3 watch -x ${M}`,
    `tmux new-session -d 'true; ${M}'`, `ionice -c3 watch 'true; ${M}'`, `tmux new -d 'echo x && ${M}'`, `ionice -c3 sh -c 'true; ${M}'`,
    `tmux split-window 'cd /x; ${M}'`, `tmux run-shell '${M}'`, `su -c 'true; ${M}' bot`, `runuser -u bot --command='${M}'`,
    `foo 'true; ${M}'`, `foo --cmd='x && ${M}'`, `foo "$(${M})"`, `foo 'cat x | sh'`, `tmux new -d 'echo "x'`,
    // crontab, at and batch
    `echo '* * * * * ${M}' | crontab -`, `crontab - <<'E'\n@reboot ${M}\nE`,
    `printf '# c\\nPATH=/usr/bin\\n*/5 * * * * cd /x && ${M}\\n' | crontab -`, `at now <<< '${M}'`, `echo 'true; ${M}' | batch`,
    `echo '0 1 * * * ${M}' | crontab -u bot -`, `echo '${M}' | at -m now`, `printf '%s\\n' '@daily ${M}' | crontab`,
    `crontab <<< '0 1 * * * x; ${M}'`,
    // escapes and formats printedText cannot read
    `printf '* * * * * \\x67h pr merge 1 -R acme/api\\n' | crontab -`, `printf '* * * * * \\147h pr merge 1 -R acme/api\\n' | crontab -`,
    `echo -e '* * * * * \\x67h pr merge 1 -R acme/api' | crontab -`, `printf '* * * * * %.2s pr merge 1 -R acme/api\\n' ghx | crontab -`,
    `printf '* * * * * %b pr merge 1 -R acme/api\\n' '\\x67h' | crontab -`, `printf '\\x67h pr merge 1 -R acme/api\\n' | at now`,
    // git's relocating options stay refused
    "git --exec-path=/tmp/x status", "git --git-dir=/x push origin main", "git -C /x --exec-path=/tmp/x log",
    // printf's --, a substitution in any word the line
    // consumes (a redirect target, a here-string), an unquoted heredoc's body, the last input on fd 0,
    // and what a group or a compound command prints into the pipe after it
    `printf -- '* * * * * ${M}\\n' | crontab -`, `printf -- '%s\\n' '${M}' | at now`,
    `echo x > "$(${M})"`, `cat < "$(${M})"`, `echo x 2> "\`${M}\`"`, `echo x >> "$(${M})"`, `cat <<< "$(${M})"`, `cat 0< "$(${M})"`,
    `cat <<E\n$(${M})\nE`, `cat <<E\n\`${M}\`\nE`, `cat <<E > out.md\nrun $(true) then $(${M})\nE`, `bash <<'A' <<'B'\ntrue\nA\n${M}\nB`,
    `bash <<'END-DATA'\n${M}\nEND-DATA`, `bash 3<<'A' <<'B'\ntrue\nA\n${M}\nB`,
    `{ echo '${M}'; echo true; } | at now`, `if true; then echo '${M}'; fi | at now`, `while true; do echo '${M}'; done | at now`,
    // a partly quoted delimiter, and what a group's stdin carries
    `bash <<EN'D-DATA'\n${M}\nEND-DATA`, `bash <<\\E\n${M}\nE`, `echo '${M}' | { echo b; cat | at now; }`,
    `{ echo '${M}'; } | { echo c; cat | at now; }`, `{ echo '${M}'; { echo true; }; } | at now`];
  const allowed = ["tmux new -d 'npm test; echo done'", "docker run img sh -c 'npm test && echo ok'", "tmux new -s w", "tmux attach -t w",
    "crontab -l", "(crontab -l; echo '30 3 * * 1 ~/agents/bin/agent-compact.sh warren') | crontab -",
    "printf '%s\\n' '30 3 * * 1 ~/agents/bin/agent-compact.sh warren' | crontab -", "echo '0 * * * * npm test' | crontab -",
    "printf '%s\\n' 'a\\x41' | crontab -", "printf '\\x41\\n' | grep A", "crontab /tmp/cron.new",
    "echo 'npm test' | at now + 1 hour", "at -f /tmp/job.sh now", "echo '5 * * * * echo 50% done' | crontab -", "at -l", "crontab -r",
    // prose and code that only look like commands
    `./bin/delegations.sh done drake abc "draft, CLEAN; gh confirms head+base"`, `node -e "x.then(m => { const sh = m.d(1); f(sh) })"`,
    `sed -e 's#^const x = a;#const SH = Number(SHIFT) * DAY;#' f`, `awk '$4 ~ /gh +(-R|--repo)|gh +pr/' f`,
    `tg-notify.sh "run sudo usermod -aG docker bot; then watch the trial"`, `until [ "$(ssh h 'pgrep -fc x || true')" = "" ]; do sleep 2; done`,
    // git's global options that only print
    "git --version", "git --help", "git --help push", "git --exec-path", "git --html-path", "git --man-path", "git --info-path",
    "bash -c 'git --version'", "git --no-pager --version", "git --exec-path /tmp/x status",
    // a literal $ before a quoted (, a quoted heredoc's body, an input fd 0 no longer reads,
    // a hyphenated delimiter, and what an earlier pipeline printed
    `echo '$'"(USD"`, `echo '$'"(USD)"`, `echo x > "$(true)"`, "echo x > out.txt", `cat <<'E'\n$(${M})\nE`, `cat <<E\n\\$(${M})\nE`,
    "cat <<E > README.md\nrun `npm test`, then $(date)\nE", `cat <<'END-DATA'\na "b\nEND-DATA`, `bash <<'A' <<'B'\necho "x\nA\ntrue\nB`,
    `bash <<'A' < /dev/null\n${M}\nA`, `echo 'unmatched " quote'; echo true | at now`, `echo '${M}' && echo true | at now`,
    `(echo '${M}'); echo true | at now`,
    // the last round: a delimiter quoted in part, and a pipeline in a group, loop, if or subshell
    `cat <<EN'D-DATA'\na "b\nEND-DATA`, `cat <<\\E\na "b\nE`, `cat <<-"E"x\n\ta "b\n\tEx`,
    `{ echo 'unmatched " quote'; echo true | at now; }`, `( echo 'unmatched " quote'; echo true | at now )`,
    `if true; then echo 'unmatched " q'; echo true | at now; fi`, `{ echo '${M}' && echo true | at now; }`,
    `while true; do echo '${M}'; echo true | at now; done`];
  const wrong: string[] = [];
  for (const ctx of [pr, { ...pr, role: "lead" }]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// The command word is read by its shape, an allowlist; every trick goes through the one rule.
test("a command word is a bare name, a plain path or refused", () => {
  const M = "gh pr merge 1 -R acme/api";
  const refused = [`/usr/bin/e[n]v ${M}`, `/usr/bin/e?v ${M}`, `/usr/*/env ${M}`, `/usr/bin/en* ${M}`, "{env,gh,pr,merge,1,-R,acme/api}",
    "{/usr/bin/env,gh,pr,merge,1,-R,acme/api}", `/usr/bin/{env,} ${M}`, `~+/bin/env ${M}`, `cd /usr && ~+/bin/env ${M}`, `~-/bin/env ${M}`,
    `~root/../usr/bin/env ${M}`, `env -C /usr bin/env ${M}`, `env --chdir=/ usr/bin/nice ${M}`,
    `find /usr/bin -maxdepth 0 -execdir bin/env ${M} \\;`, `e[n]v ${M}`, `'/usr/bin/e*v' ${M}`, `{ ${M}; }`, `../bin/env ${M}`, `nice ~+/gh pr view 1`];
  const allowed = ["./scripts/env PATH=report", "./node_modules/.bin/tsc -p .", "/usr/bin/env npm test", "~/agents/bin/pr-send.sh 124 abc",
    '"./scripts/a b.sh"', "npm test", "/usr/bin/git status", "[ -f x ] && echo y", "[[ -f x ]] && echo y", ": > out.log", "{ ls; echo x; } > out",
    "scripts/report", "~/agents/bin/pr-send.sh 124 abc", "env -C sub npm test"];
  const wrong: string[] = [];
  for (const ctx of [pr, { ...pr, role: "lead" }]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// The trusted-dir check compares where a directory resolves, not how it was written.
test("a wrapper by any path that resolves to a system bin dir is the wrapper", () => {
  const M = "gh pr merge 1 -R acme/api";
  const refused = [`/usr/bin/../bin/env ${M}`, `/usr//bin/env ${M}`, `/bin/./nice ${M}`, `/usr/bin/../bin/timeout 5 ${M}`,
    `/proc/self/root/usr/bin/env ${M}`, `~/../../../../../../usr/bin/env ${M}`, `$HOME/../../../../../../usr/bin/env ${M}`,
    `cd /usr && bin/env ${M}`, `cd /; usr/bin/nice ${M}`];
  // /usr/bin/X11 is a link to . on Ubuntu
  if (existsSync("/usr/bin/X11")) refused.push(`/usr/bin/X11/env ${M}`, `/usr/bin/X11/X11/nice ${M}`);
  const allowed = ["./scripts/env PATH=report", "./node_modules/.bin/tsc -p .", "/usr/bin/env npm test", "~/agents/bin/pr-send.sh 124 abc",
    "/usr/bin/../bin/env npm test", "cd sub && ./scripts/report"];
  const wrong: string[] = [];
  for (const ctx of [pr, { ...pr, role: "lead" }]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// On ubuntu-26.04 /usr/bin/env, nice, timeout and nohup are links to Rust coreutils' files in
// /usr/lib/cargo/bin/coreutils, outside the bin dirs, and a path to one must still be a wrapper, or
// what comes after it runs unchecked. Here a bin dir of the fixture's own holds the
// same links: a name in it is the program it is written as, and a link to its file is that program.
test("a system program whose file lies outside the bin dirs is still that program", () => {
  const M = "gh pr merge 1 -R acme/api";
  const root = mkdtempSync(join(tmpdir(), "guard-cargo-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const [bin, cargo, other] = ["bin", "cargo", "other"].map((d) => join(root, d)) as [string, string, string];
  for (const d of [bin, cargo, other]) mkdirSync(d);
  for (const n of ["env", "nice", "timeout", "nohup", "ls"]) {
    writeFileSync(join(cargo, n), "", { mode: 0o755 });
    symlinkSync(join(cargo, n), join(bin, n));
  }
  symlinkSync(join(cargo, "env"), join(other, "e"));
  symlinkSync(join(bin, "env"), join(other, "e2"));
  const ctx: GuardContext = { ...pr, binDirs: [bin] };
  const refused = [`'${bin}/env' ${M}`, `'${bin}/env' git push origin main`, `'${bin}/nice' ${M}`, `'${bin}/timeout' 5 ${M}`,
    `'${bin}/nohup' git push origin main`, `'${bin}/../bin/env' ${M}`, `'${other}/e' ${M}`, `'${other}/e2' ${M}`,
    `PATH='${bin}' env ${M}`, `PATH='${other}':$PATH e ${M}`, `'${bin}/env' '${bin}/nice' ${M}`];
  const allowed = [`'${bin}/env' npm test`, `'${bin}/ls' -la`, `'${other}/e' npm test`, `'${bin}/timeout' 5 npm test`];
  const wrong: string[] = [];
  for (const c of [ctx, { ...ctx, role: "lead" }]) {
    for (const r of refused) if (verdict(r, c) === null) wrong.push(`${c.role} allowed: ${r}`);
    for (const r of allowed) if (verdict(r, c) !== null) wrong.push(`${c.role} refused: ${r} (${verdict(r, c)})`);
  }
  assert.deepEqual(wrong, []);
});

// A command word's directory from a variable lost its `$` to the basename, and the shell splits it
//.
test("a command word from a variable is refused, except a plain path under $HOME", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const refused = ["$G/x", "${G}/x a", "$G/gh pr view 1", "$D/../x", "HOME='/usr/bin/gh pr merge 1 -R acme/api #'; $HOME/x",
    "export HOME=/x; $HOME/gh pr view 1", "$HOME/.local/bin/gh pr merge 1 -R acme/api", "$HOME/$X/gh pr view 1", "`echo x`/y"];
  const allowed = ["$HOME/.local/bin/gh pr view 1", '"$HOME/.local/bin/gh" pr list', "${HOME}/agents/bin/pr-send.sh 124 abc",
    "~/agents/bin/pr-send.sh 124 abc", "$HOME/agents/bin/pr-send.sh 124 abc"];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// A heredoc's body was tied to the last command on its header line, not to the one whose << it is
//.
test("a heredoc is the stdin of the command that opens it", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const M = "gh pr merge 1 -R acme/api";
  const refused = [`bash < x.sh <<'E' | cat\n${M}\nE`, `ssh niilo <<'E' | cat\n${M}\nE`, `cat <<'A' | bash <<'B'\nx\nA\n${M}\nB`,
    `bash <<'E' >out 2>&1 | cat\n${M}\nE`];
  const allowed = ["bash <<'E' | tee log\nnpm test\nE", "bash <<'E' && echo ok\nnpm test\nE", "cat <<'E' | grep x\ngh pr merge\nE",
    "bash < x.sh | cat", `cat <<'A' | bash <<'B'\n${M}\nA\nnpm test\nB`];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// gh issue close/reopen/lock/unlock
// act on a PR; GraphQL closes issues; HEAD is a read; a query cannot mutate; a wrapper's name on a
// project script is not the wrapper.
test("gh issue state changes are checked as gh pr, and the review's false refusals pass", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const r = factory(dir, ["allow-close", "api", "8701", "--words", "I allow you to close the PR"]);
  assert.equal(r.status, 0, r.stderr);
  const recorded: GuardContext = { ...lead, allowClose: allowClosePath(openWorkspace(dir).stateDir) };
  const gql = (q: string) => `gh api graphql -f query='mutation { ${q} { clientMutationId } }'`;
  const refused = ["gh issue close 8702 -R acme/api", "gh issue reopen 8701 -R acme/api", "gh issue lock 8701 -R acme/api", "gh issue unlock 8701 -R acme/api",
    "gh issue close https://github.com/acme/api/issues/8702", "gh pr reopen 8701 -R acme/api", "gh issue close 8702", gql(`closeIssue(input: {issueId: "x"})`),
    gql(`reopenIssue(input: {issueId: "x"})`), gql(`updateIssue(input: {id: "x", state: CLOSED})`),
    "gh api graphql -f query='mutation M { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "/usr/bin/env PATH=x ls", "/usr/bin/env gh pr merge 1 -R acme/api", "/usr/bin/nice gh pr merge 1 -R acme/api", "$D/env gh pr merge 1 -R acme/api"];
  const allowed = ["gh issue close 3 -R acme/workspace", "gh issue lock 3 -R acme/workspace", "gh issue comment 8701 -R acme/api -b '> Written by agent. x'",
    "gh issue view 8701 -R acme/api", "gh issue create -R acme/api -t x -b y", "gh api -X HEAD repos/acme/api", "gh api -X HEAD repos/acme/api/contents/a.txt",
    "gh api graphql -f query='query closePullRequest { viewer { login } }'", "gh api graphql -f query='{ repository(owner: \"acme\", name: \"api\") { mergeCommitAllowed } }'",
    "./scripts/env PATH=report", "./bin/nice report"];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  for (const c of ["gh issue close 8701 -R acme/api", "gh issue close 8701 -R acme/api -r 'not planned'"]) if (verdict(c, recorded) !== null) wrong.push(`recorded lead refused: ${c} (${verdict(c, recorded)})`);
  for (const c of ["gh issue close 8701 -R acme/api"]) if (verdict(c, pr) === null) wrong.push(`builder allowed: ${c}`);
  assert.deepEqual(wrong, []);
});

// Wrappers and shells ran gh past every check: nice, setsid, stdbuf,
// flock, env -S, find -exec, ssh, a shell reading its script from a pipe, a here-string, a heredoc or
// a <( ... ), and a substitution inside quotes or a <( ... ). Each is now read through to its command.
test("gh run through a wrapper, a substitution or a shell on stdin is checked", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const M = "gh pr merge 1 -R acme/api";
  const refused = [`nice ${M}`, `nice -n 5 ${M}`, `nice -n5 ${M}`, `setsid ${M}`, `setsid -f ${M}`, `stdbuf -o0 ${M}`, `stdbuf -o 0 -e L ${M}`,
    `flock /tmp/l ${M}`, `flock -w 5 /tmp/l ${M}`, `flock /tmp/l -c '${M}'`, `env -S "${M}"`, `env --split-string="${M}"`, `env -S"${M}"`,
    `env -u X ${M}`, `env -C /tmp ${M}`, `nice env timeout 5 setsid ${M}`,
    `find . -exec ${M} \\;`, `find . -execdir ${M} {} +`, `find . -name x -ok ${M} \\;`,
    `echo '${M}' | bash`, `echo '${M}' | sh`, `cat x | bash -s`, `bash <<< '${M}'`, `bash <(echo '${M}')`, `sh -s <<'E'\n${M}\nE`, `bash -l <<E\necho hi\n${M}\nE`,
    `ssh localhost ${M}`, `ssh -p 22 -o BatchMode=yes localhost '${M}'`, `ssh -tt host -- ${M}`, `ssh host -p 22 ${M}`,
    `echo "$(${M})"`, `X="$(${M})"`, `cat <(${M})`, `tee >(${M}) < x`, `echo "a $(echo "$(${M})") b"`, `flock /tmp/l $(which gh) pr view 1`];
  const allowed = ["nice -n 5 npm test", "flock /tmp/l make build", "find . -name '*.ts' -exec wc -l {} +", "bash scripts/x.sh", "bash -e scripts/x.sh a b",
    "bash < scripts/x.sh", "ssh niilo 'systemctl --user status gh-runner-ci@2'", "echo hi | cat", "bash -c 'npm test'", "setsid -f npm run dev",
    "stdbuf -oL npm test | tee /tmp/log", `git commit -m "$(cat <<'EOF'\nfix: merge the gh pr merge rows\nEOF\n)"`, "echo \"$((1 + 2))\"",
    "diff <(git show HEAD:a) <(cat a)", "sh -s <<'E'\nnpm test\nE", `grep "\\$(" src/a.ts`, `echo "$(date) and $(git rev-parse HEAD)"`];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
  assert.match(verdict(`echo '${M}' | bash`, pr) as string, /reading its script from a pipe/);
});

// The lead may merge test PRs and bug fixes: only on a lead_merges repo, only the lead, and only at
// the head it names; close, lock and every other role are refused as before.
test("the lead merges a product PR on a lead_merges repo at a named head", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const lead: GuardContext = { ...pr, role: "lead", leadMerges: ["acme/web"] };
  for (const c of [`gh pr merge 506 -R acme/web --match-head-commit ${sha}`, `gh pr merge 506 --repo Acme/web --squash --match-head-commit=${sha}`,
    `gh pr merge 506 -R acme/web -s -d --match-head-commit ${sha} --subject "Fix x (#506)" --body ""`])
    assert.equal(verdict(c, lead), null, c);
  const refused = {
    "a builder": verdict(`gh pr merge 506 -R acme/web --match-head-commit ${sha}`, { ...lead, role: "builder" }),
    "an assistant": verdict(`gh pr merge 506 -R acme/web --match-head-commit ${sha}`, { ...lead, role: "assistant" }),
    "no --match-head-commit": verdict("gh pr merge 506 -R acme/web --squash", lead),
    "a short sha": verdict("gh pr merge 506 -R acme/web --match-head-commit 0123456", lead),
    "a repo not listed": verdict(`gh pr merge 506 -R acme/api --match-head-commit ${sha}`, lead),
    "no -R, by URL": verdict(`gh pr merge https://github.com/acme/web/pull/506 --match-head-commit ${sha}`, lead),
    "no repo at all": verdict(`gh pr merge 506 --match-head-commit ${sha}`, lead),
    "--admin": verdict(`gh pr merge 506 -R acme/web --admin --match-head-commit ${sha}`, lead),
    "a branch name": verdict(`gh pr merge fix-x -R acme/web --match-head-commit ${sha}`, lead),
    "two PRs": verdict(`gh pr merge 506 507 -R acme/web --match-head-commit ${sha}`, lead),
    "a close": verdict("gh pr close 506 -R acme/web", lead),
    "a lock": verdict("gh pr lock 506 -R acme/web", lead),
    "a merge through the API": verdict("gh api -X PUT repos/acme/web/pulls/506/merge", lead),
  };
  for (const [what, reason] of Object.entries(refused)) assert.notEqual(reason, null, `${what} should be refused`);
  assert.match(refused["a builder"] as string, /^merge of a PR on a product repo/);
  assert.match(refused["no --match-head-commit"] as string, /needs --match-head-commit/);
  assert.match(refused["a repo not listed"] as string, /^merge of a PR on a product repo/);
  assert.match(refused["--admin"] as string, /^--admin is not allowed/);
});

// A lead launched before --allow-close was rendered into its settings has none; its guard finds the
// list through the workspace instead, and the flag still wins when given.
test("the lead's guard finds the allow-close list through its workspace when the flag is missing", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(factory(dir, ["allow-close", "api", "8701", "--words", "I allow you to close the PR"]).status, 0);
  const lead: GuardContext = { ...pr, role: "lead", workspace: dir };
  assert.equal(verdict("gh pr close 8701 -R acme/api", lead), null);
  assert.match(verdict("gh pr close 8702 -R acme/api", lead) ?? "", /acme\/api#8702 is not on the allow-close list/);
  assert.match(verdict("gh pr merge 8701 -R acme/api", lead) ?? "", /^merge of a PR on a product repo/);
  assert.notEqual(verdict("gh pr close 8701 -R acme/api", { ...lead, role: "builder" }), null);
  // the flag overrides the workspace: a list that names nothing closes nothing
  assert.notEqual(verdict("gh pr close 8701 -R acme/api", { ...lead, allowClose: `${dir}/nothing.jsonl` }), null);
});

// The comment rule, every shape. Every comment the factory posts
// goes out under the human's login, so its body must start with the marker, or be a bot trigger, and
// be checkable in the command. gh's arguments are read as gh reads them: the last of a repeated flag
// wins, a short flag's value may be attached, `=` forms work, and -- ends the options. Only a gh
// that runs as a command is checked. Each row runs through the marked-comments hook, and each gh row
// that names no file through the protect guard too, which must agree on a comment it refuses.
const M = "> Written by agent.";
const NO = "refused";
const OK = "allowed";
const ADD = (body: string) => `gh api graphql -f query='mutation { addComment(input: {subjectId: "X", body: ${body}}) { clientMutationId } }'`;
const REPLY = "gh api graphql -f query='mutation($b: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: \"T\", body: $b}) { clientMutationId } }'";
const SUBMIT = "gh api graphql -f query='mutation($i: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $i) { clientMutationId } }'";
const ADD_IN = "gh api graphql -f query='mutation($i: AddCommentInput!) { addComment(input: $i) { clientMutationId } }'";
const COMMENT_SHAPES: [string, string, string][] = [
  // gh pr/issue comment
  [OK, "marked", `gh pr comment 1 --body '${M}\n\nFixed in abc'`],
  [OK, "marked, -b", `gh pr comment 1 -b "${M} Fixed"`],
  [OK, "a bot trigger", "gh pr comment 1 --body '@coderabbitai review'"],
  [OK, "marked, -R before the number", `gh pr comment -R o/r 1 --body '${M}'`],
  [OK, "marked, attached", `gh pr comment 1 '-b${M} ok'`],
  [OK, "marked, = form", `gh issue comment 1 '--body=${M} ok'`],
  [OK, "the last body is marked", `gh pr comment 1 -b hi -b '${M} ok'`],
  [OK, "--web: the human writes it", "gh pr comment 1 --web"],
  [OK, "--delete-last posts nothing", "gh pr comment 1 --delete-last --yes"],
  [NO, "unmarked", "gh pr comment 1 --body hi"],
  [NO, "unmarked, -b", "gh pr comment 1 -b 'Fixed in abc'"],
  [NO, "unmarked, = form", "gh issue comment 1 --body=hi"],
  [NO, "unmarked, attached", "gh pr comment 1 -bhi"],
  [NO, "unmarked, -R before the number", "gh pr comment -R o/r 1 -b hi"],
  [NO, "the last body is unmarked", `gh pr comment 1 -b '${M}' -b hi`],
  [NO, "the last body is unmarked, = form", `gh pr comment 1 --body '${M}' --body=hi`],
  [NO, "--edit-last, unmarked", "gh pr comment 1 --edit-last -b hi"],
  [NO, "no body", "gh pr comment 1"],
  [NO, "after --, -b is not a flag", `gh pr comment 1 -- -b '${M}'`],
  [NO, "a body from $(...)", 'gh pr comment 1 --body "$(cat f)"'],
  [NO, "a body from a variable", 'gh pr comment 1 --body "$BODY"'],
  [NO, "--body-file", "gh pr comment 1 --body-file f"],
  [NO, "-F", "gh pr comment 1 -F f"],
  [NO, "-F attached", "gh pr comment 1 -Ff.md"],
  [NO, "-e", "gh pr comment 1 -e"],
  [NO, "--editor", "gh issue comment 1 --editor"],
  // pr's and issue's -R/--repo before the subcommand, or before pr/issue itself
  [NO, "gh -R o/r pr comment", "gh -R o/r pr comment 1 -b hi"],
  [NO, "gh --repo o/r pr comment", "gh --repo o/r pr comment 1 -b hi"],
  [NO, "gh --repo=o/r issue comment", "gh --repo=o/r issue comment 2 -b hi"],
  [NO, "gh pr -R o/r comment", "gh pr -R o/r comment 1 -b hi"],
  [NO, "gh -Ro/r pr comment", "gh -Ro/r pr comment 1 -b hi"],
  [NO, "gh issue --repo o/r close -c", "gh issue --repo o/r close 2 -c hi"],
  [NO, "gh pr --repo=o/r review", "gh pr --repo=o/r review 1 -c -b hi"],
  [OK, "gh -R o/r pr comment, marked", `gh -R o/r pr comment 1 -b '${M} ok'`],
  [OK, "gh -R o/r pr view", "gh -R o/r pr view 1"],
  // gh pr review
  [OK, "an approval", "gh pr review 1 --approve"],
  [OK, "marked", `gh pr review 1 --comment -b '${M} ok'`],
  [OK, "marked, attached after a boolean cluster", `gh pr review 1 -c '-b${M} ok'`],
  [NO, "unmarked", "gh pr review 1 --request-changes -b 'please fix'"],
  [NO, "unmarked, attached", "gh pr review 1 --comment -bhi"],
  [NO, "the last body is unmarked", `gh pr review 1 -c -b '${M}' --body=hi`],
  [NO, "--body-file", "gh pr review 1 --comment --body-file f"],
  [NO, "-F attached", "gh pr review 1 --comment -Ff.md"],
  // close and reopen with a comment
  [OK, "close, no comment", "gh pr close 1"],
  [OK, "close, marked", `gh pr close 1 -c '${M} superseded'`],
  [OK, "issue close with a reason", "gh issue close 2 -r completed"],
  [OK, "reopen, no comment", "gh issue reopen 2"],
  [NO, "pr close -c", "gh pr close 1 -c hi"],
  [NO, "pr close --comment=", "gh pr close 1 --comment=hi"],
  [NO, "pr close, attached", "gh pr close 1 -chi"],
  [NO, "pr close, after a boolean", "gh pr close 1 -d -c hi"],
  [NO, "issue close --comment", "gh issue close 2 --comment hi"],
  [NO, "issue close, a reason and a comment", "gh issue close 2 -r completed -c hi"],
  [NO, "pr reopen -c", "gh pr reopen 1 -c hi"],
  [NO, "issue reopen -c", "gh issue reopen 2 -c hi"],
  // REST
  [OK, "a read", "gh api repos/o/r/pulls/1/comments"],
  [OK, "a read with -X GET and fields", "gh api -X GET repos/o/r/issues/1/comments -f per_page=100"],
  [OK, "a delete", "gh api -X DELETE repos/o/r/issues/comments/5"],
  [OK, "not a comment", "gh api repos/o/r/issues/1/labels -f 'labels[]=x'"],
  [OK, "a marked reply", `gh api repos/o/r/pulls/1/comments/2/replies -f body='${M}\n\nFixed in abc'`],
  [OK, "a marked review and its comments", `gh api repos/o/r/pulls/1/reviews -f body='${M} ok' -f 'comments[][path]=a.ts' -f 'comments[][body]=${M} nit'`],
  [NO, "an unmarked reply", "gh api repos/o/r/pulls/1/comments/2/replies -f body='Fixed in abc'"],
  [NO, "attached -f", "gh api repos/o/r/pulls/1/comments/2/replies -fbody=hi"],
  [NO, "an issue comment", "gh api -X POST repos/o/r/issues/1/comments -f body=hi"],
  [NO, "a leading slash", "gh api /repos/o/r/issues/1/comments -f body=hi"],
  [NO, "a full URL", "gh api https://api.github.com/repos/o/r/issues/1/comments -f body=hi"],
  [NO, "a review body", "gh api repos/o/r/pulls/1/reviews -f event=COMMENT -f body=hi"],
  [NO, "a review's comment", `gh api repos/o/r/pulls/1/reviews -f 'body=${M} ok' -f 'comments[][path]=a.ts' -f 'comments[][body]=nit'`],
  [NO, "a submitted review", "gh api repos/o/r/pulls/1/reviews/5/events -f event=COMMENT -f body=hi"],
  [NO, "an edit", "gh api -X PATCH repos/o/r/issues/comments/5 -f body=hi"],
  [NO, "a commit comment", "gh api repos/o/r/commits/abc/comments -f body=hi"],
  [NO, "a second body field", `gh api repos/o/r/issues/1/comments -f 'body=${M}' -f body=hi`],
  [NO, "a body from a file", "gh api repos/o/r/pulls/1/comments/2/replies -F body=@f"],
  [NO, "--input", "gh api repos/o/r/issues/1/comments --input f.json"],
  // GraphQL
  [OK, "a read", "gh api graphql -f query='query { viewer { login } }'"],
  [OK, "a mutation that posts nothing", "gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: \"T\"}) { clientMutationId } }'"],
  [OK, "a marked literal", ADD(`"${M} ok"`)],
  [OK, "a marked block string", ADD(`"""${M} ok"""`)],
  [OK, "a marked $variable", `${REPLY} -f 'b=${M} ok'`],
  [OK, "a trigger $variable", `${REPLY} -f 'b=@coderabbitai resolve'`],
  [OK, "an approval through input", `${SUBMIT} -f 'i[pullRequestReviewId]=R' -f 'i[event]=APPROVE'`],
  [OK, "a marked body in input", `${ADD_IN} -f 'i[subjectId]=X' -f 'i[body]=${M} ok'`],
  [NO, "an unmarked literal", ADD('"hi"')],
  [NO, "an unmarked block string", ADD('"""hi"""')],
  [NO, "an unmarked $variable", `${REPLY} -f b=hi`],
  [NO, "a $variable not given", REPLY],
  [NO, "submit, no input", SUBMIT],
  [NO, "submit, an unmarked body in input", `${SUBMIT} -f 'i[pullRequestReviewId]=R' -f 'i[body]=hi'`],
  [NO, "an input body from a file", `${ADD_IN} -f 'i[subjectId]=X' -F 'i[body]=@note.md'`],
  [NO, "the input as one value", `${ADD_IN} -f 'i={"body":"hi"}'`],
  [NO, "a query from $(...)", "gh api graphql -f query=\"$(cat <<'EOF'\nmutation{addComment(input:{subjectId:\"x\",body:\"hi\"}){clientMutationId}}\nEOF\n)\""],
  [NO, "a query from a variable", 'gh api graphql -f query="$Q"'],
  // A query or request body from a file is refused, whatever it holds: gh reads it when it runs, and
  // by then it could be anything. Variables from files are refused when
  // the mutation uses them as a body.
  [NO, "-F query=@f", "gh api graphql -F query=@read.graphql"],
  [NO, "-f query=@f", "gh api graphql -f query=@read.graphql"],
  [NO, "--field query=@f", "gh api graphql --field query=@read.graphql"],
  [NO, "--raw-field=query=@f", "gh api graphql --raw-field=query=@read.graphql"],
  [NO, "-Fquery=@f", "gh api graphql -Fquery=@read.graphql"],
  [NO, "-F query=@-", "gh api graphql -F query=@-"],
  [NO, "an absolute query file", "gh api graphql -F query=@/abs/read.graphql"],
  [NO, "--input f", "gh api graphql --input read.json"],
  [NO, "--input=f", "gh api graphql --input=read.json"],
  [NO, "--input -", "gh api graphql --input -"],
  [NO, "a body variable from a file", `${REPLY} -F b=@body.txt`],
  [NO, "an input body from a file, -F i[body]=@f", `${ADD_IN} -f 'i[subjectId]=X' -F 'i[body]=@f'`],
  [NO, "a file-backed query beside a $(...)", 'gh api graphql -F query=@read.graphql -f x="$(cp a b)"'],
  [NO, "a file-backed query after cd", "cd sub && gh api graphql -F query=@read.graphql"],
  [OK, "a marked -F variable", `${REPLY} -F 'b=${M} ok'`],
  [OK, "an @ inside a marked literal", ADD(`"${M} @someone"`)],
  [OK, "an @ inside a marked variable", `${REPLY} -f 'b=${M} cc @x'`],
  [OK, "a read beside a cd", "cd sub && gh api graphql -f query='query { viewer { login } }'"],
  [OK, "after cd, a marked inline comment", `cd sub && gh pr comment 1 -b '${M} ok'`],
  // where gh runs: behind wrappers, in other commands' bodies, by path
  [NO, "sudo", "sudo gh pr comment 1 -b hi"],
  [NO, "sudo -u", "sudo -u x gh pr comment 1 -b hi"],
  [NO, "env", "env A=1 gh pr comment 1 -b hi"],
  [NO, "an assignment", "A=1 gh pr comment 1 -b hi"],
  [NO, "timeout", "timeout 5 gh pr comment 1 -b hi"],
  [NO, "nice", "nice -n 5 gh pr comment 1 -b hi"],
  [NO, "xargs", "printf 1 | xargs -I{} gh pr comment {} -b hi"],
  [NO, "command", "command gh pr comment 1 -b hi"],
  [NO, "nohup", "nohup gh pr comment 1 -b hi"],
  [NO, "exec", "exec gh pr comment 1 -b hi"],
  [NO, "by path", "/usr/bin/gh pr comment 1 -b hi"],
  [NO, "by a linuxbrew path", "/home/linuxbrew/.linuxbrew/bin/gh pr comment 1 -b hi"],
  [NO, "bash -c", 'bash -c "gh issue comment 3 -b hi"'],
  [NO, "sh -lc", "sh -lc 'gh issue comment 3 -b hi'"],
  [NO, "eval", "eval gh pr comment 1 -b hi"],
  [NO, "after &&", "cd /x && gh pr comment 1 -b hi"],
  [NO, "after ;", "ls; gh pr comment 1 -b hi"],
  [NO, "a subshell", "(gh pr comment 1 -b hi)"],
  [NO, "inside $(...)", "echo $(gh pr comment 1 -b hi)"],
  [NO, "a for body", "for i in 1; do gh pr comment $i -b hi; done"],
  [NO, "an if body", "if true; then gh pr comment 1 -b hi; fi"],
  [OK, "echo prints it", "echo gh pr comment 1 -b hi"],
  [OK, "printf prints it", "printf '%s\\n' gh pr comment 1"],
  [OK, "grep searches for it", 'grep "gh api" f'],
  [OK, "a commit message names it", 'git commit -m "gh pr comment 1 -b hi"'],
  [OK, "a heredoc prints it", "cat <<'EOF'\ngh pr comment 1 -b hi\nEOF"],
  [OK, "gh reads", "gh pr view 1 --comments"],
  [OK, "gh checks", "gh pr checks 1"],
  [OK, "xargs, no gh", "printf x | xargs echo"],
  [OK, "sudo, no gh", "sudo ls"],
  [OK, "watch, no gh", "watch ls"],
  // gh runs an alias or an extension as readily as its own commands, and either could post anything
  [NO, "a gh alias", "gh co 5"],
  [NO, "a gh alias past -R", "gh -R o/r xyz 1"],
  [NO, "a gh alias behind a wrapper", "env gh co 5"],
  [NO, "making a gh alias", "gh alias set c 'pr comment 1 -b hi'"],
  [NO, "getting an extension", "gh extension install o/gh-x"],
  [NO, "running an extension", "gh ext exec x"],
  [NO, "an alias in sh -c", "sh -c 'gh co 5'"],
  [OK, "gh's version", "gh --version"],
  [OK, "listing aliases", "gh alias list"],
  // an unquoted heredoc's $(...) runs as the shell reads the body; a quoted one's is text
  [NO, "a heredoc body's substitution", "cat <<EOF\n$(gh pr comment 1 -b hi)\nEOF"],
  [OK, "a quoted heredoc's substitution", "cat <<'EOF'\n$(gh pr comment 1 -b hi)\nEOF"],
  // a $'...' body is what bash gives gh, decoded
  [OK, "an ANSI-C quoted marked body", "gh pr comment 5 -R acme/api --body $'> Written by agent.'"],
  [OK, "an ANSI-C quoted body with the CodeRabbit trigger", "gh pr comment 5 -R acme/api --body $'> Written by agent.\\n\\n@coderabbitai review'"],
  [OK, "an ANSI-C body marked through a hex escape", "gh pr comment 5 -R acme/api --body $'\\x3e Written by agent.'"],
  [NO, "an ANSI-C body with the mark on its second line", "gh pr comment 5 -R acme/api --body $'hi\\n> Written by agent.'"],
  [NO, "an escaped $ before a quoted body", "gh pr comment 5 -R acme/api --body \\$'> Written by agent.'"],
  [NO, "an ANSI-C body with a control character", "gh pr comment 5 -R acme/api --body $'> Written by agent.\\c'"],
  // command -v and -V look a name up and run nothing; without them, command runs it
  [OK, "looking gh up", "command -v gh git-gh"],
  [OK, "describing gh", "command -V gh"],
  [NO, "an alias run through command", "command gh co 5"],
];

// The protect guard refused these two shapes from the merged comment rule.
test("protect allows a $'...' marked body and a command -v lookup", () => {
  for (const cmd of ["gh pr comment 5 -R acme/api --body $'> Written by agent.'", "gh pr comment 5 -R acme/api --body $'> Written by agent.\\n\\n@coderabbitai review'",
    "command -v gh git-gh", "command -V gh"])
    assert.equal(verdict(cmd, pr), null, cmd);
  assert.notEqual(verdict("command gh co 5", pr), null);
});

test("the comment rule: every shape a gh comment takes, refused or allowed", () => {
  // The file rows run where their files exist and hold only reads, so a refusal is the rule's, not
  // a missing file's: nothing reads them.
  const dir = mkdtempSync(join(tmpdir(), "comment-rule-"));
  const here = process.cwd();
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "read.graphql"), "query { viewer { login } }");
  writeFileSync(join(dir, "read.json"), JSON.stringify({ query: "query { viewer { login } }" }));
  process.chdir(dir);
  const wrong: string[] = [];
  try {
    for (const [want, name, cmd] of COMMENT_SHAPES) {
      const hook = commentVerdict(cmd);
      if ((hook === null ? OK : NO) !== want) wrong.push(`hook ${want === OK ? "refused" : "allowed"} ${name}: ${cmd}${hook ? ` (${hook})` : ""}`);
      // The protect guard runs the same rule over the line; its own policy may refuse more, so it is
      // held only to refusing what the rule refuses.
      if (want === NO && /^gh /.test(cmd) && verdict(cmd, pr) === null) wrong.push(`protect allowed ${name}: ${cmd}`);
    }
  } finally {
    process.chdir(here);
  }
  assert.deepEqual(wrong, []);
});

// Each row is a bypass (an unmarked body that gets through) or a false refusal of a looser reading. A
// NO row is refused by the hook and by
// protect; an OK row is allowed by the hook.
const ROUND_128: [string, string, string][] = [
  // KJHv: an empty "" between the $ and the ' leaves the $ a letter, so the body starts with "$>"
  [NO, "a $ before an empty quote and a marked '...'", `gh pr comment 5 -R acme/api --body $""'> Written by agent. x'`],
  [OK, "an empty $'' then a marked \"...\"", `gh pr comment 5 -R acme/api --body $''"> Written by agent. x"`],
  [OK, "an empty $'' then a marked $'...'", `gh pr comment 5 -R acme/api --body $''$'> Written by agent. x'`],
  [OK, "a $'...' after a line continuation", "gh pr comment 5 -R acme/api --body $\\\n'> Written by agent. x'"],
  // KJH3: a boolean's value is read; --web=false and --delete-last=false post the --body inline
  [NO, "--web=false", "gh pr comment 5 -R acme/api --web=false --body hi"],
  [NO, "-w=false", "gh pr comment 5 -R acme/api -w=false --body hi"],
  [NO, "--delete-last=false", "gh pr comment 5 -R acme/api --delete-last=false --body hi"],
  [NO, "--web then --web=0", "gh issue comment 5 -R acme/api --web --web=0 --body hi"],
  [NO, "--web=maybe, which gh refuses", "gh pr comment 5 -R acme/api --web=maybe --body hi"],
  [OK, "--web=true opens the browser", "gh pr comment 5 -R acme/api --web=true --body hi"],
  [OK, "--web=false then --web", "gh pr comment 5 -R acme/api --web=false --web"],
  [OK, "--web=false with a marked body", "gh pr comment 5 -R acme/api --web=false --body '> Written by agent. ok'"],
  // KJH8: -b=VALUE is VALUE, as pflag reads it; -bVALUE and -b VALUE as before
  [OK, "-b= with a marked body", "gh pr comment 5 -R acme/api -b='> Written by agent. ok'"],
  [NO, "-b= with an unmarked body", "gh pr comment 5 -R acme/api -b=hi"],
  [OK, "-b with a marked body attached", "gh pr comment 5 -R acme/api '-b> Written by agent. ok'"],
  [OK, "-b then a marked body", "gh issue comment 5 -R acme/api -b '> Written by agent. ok'"],
  [NO, "gh api -f=body=", "gh api repos/acme/api/issues/5/comments -f=body=hi"],
  [OK, "gh api -f=body= marked", "gh api repos/acme/api/issues/5/comments '-f=body=> Written by agent. ok'"],
  // KJID: GraphQL's ignored tokens (# comments, commas) between a field and its arguments or body: and its value
  [NO, "a # comment before a mutation's arguments", `gh api graphql -f query='mutation{addComment #c\n(input:{subjectId:"X",body:"hi"}){clientMutationId}}'`],
  [NO, "a # comment between body: and its value", `gh api graphql -f query='mutation{addComment(input:{subjectId:"X",body: #c\n"hi"}){clientMutationId}}'`],
  [NO, "a comma before a mutation's arguments", `gh api graphql -f query='mutation{addComment,(input:{subjectId:"X",body:"hi"}){clientMutationId}}'`],
  [NO, "a comma after body:", `gh api graphql -f query='mutation{addComment(input:{subjectId:"X",body:,"hi"}){clientMutationId}}'`],
  [OK, "a body: in a # comment is no input", `gh api graphql -f query='mutation{addComment(input:{subjectId:"X",body:"> Written by agent. ok"}){clientMutationId}} # body: "hi"'`],
  [OK, "a # inside a marked body is a letter", `gh api graphql -f query='mutation{addComment(input:{subjectId:"X",body:"> Written by agent. #1, done"}){clientMutationId}}'`],
  // KJIQ: GitHub's GraphQL endpoint by its URL or a path is GraphQL too
  [NO, "the GraphQL URL", `gh api https://api.github.com/graphql -f query='mutation{addComment(input:{subjectId:"X",body:"hi"}){clientMutationId}}'`],
  [NO, "a GHE's GraphQL URL", `gh api https://ghe.acme.dev/api/graphql -f query='mutation{addComment(input:{subjectId:"X",body:"hi"}){clientMutationId}}'`],
  [NO, "/graphql", `gh api /graphql -f query='mutation{addComment(input:{subjectId:"X",body:"hi"}){clientMutationId}}'`],
  [NO, "the GraphQL URL with --input", "gh api https://api.github.com/graphql --input q.json"],
  [OK, "the GraphQL URL with a marked body", `gh api https://api.github.com/graphql -f query='mutation{addComment(input:{subjectId:"X",body:"> Written by agent. ok"}){clientMutationId}}'`],
  [OK, "a read by the GraphQL URL", `gh api https://api.github.com/graphql -f query='query{viewer{login}}'`],
  // KJId: an issue number, or a whole route, from the shell
  [NO, "a $N comments path", `gh api "repos/acme/api/issues/$N/comments" -f body=hi`],
  [NO, "a \${N} reviews path", "gh api repos/acme/api/pulls/\${N}/reviews -f body=hi -f event=COMMENT"],
  [NO, "a route from a variable", `gh api "$P" -f body=hi`],
  [NO, "an issue route ending in a variable", `gh api "repos/acme/api/issues/$N" -f body=hi`],
  [OK, "a $N comments path with a marked body", `gh api "repos/acme/api/issues/$N/comments" -f body='> Written by agent. ok'`],
  [OK, "a $R PR edit", `gh api -X PATCH "repos/$R/pulls/5" -f title=x -f body=y`],
  [OK, "a $N read", `gh api "repos/acme/api/issues/$N/comments"`],
  // KJIn: gh spelled with quotes, which bash removes before it names the command
  [NO, `g"h"`, `g"h" pr comment 5 -R acme/api --body hi`],
  [NO, `'g'h`, `'g'h pr comment 5 -R acme/api --body hi`],
  [NO, "g\\h", "g\\h pr comment 5 -R acme/api --body hi"],
  [NO, "g$'h'", "g$'h' pr comment 5 -R acme/api --body hi"],
  [NO, `g""h behind env`, `env g""h pr comment 5 -R acme/api --body hi`],
  [OK, `g"h" with a marked body`, `g"h" pr comment 5 -R acme/api --body '> Written by agent. ok'`],
  // KJIz: env -S, whose value is the command line it runs
  [NO, "env -S", `env -S 'gh pr comment 5 -R acme/api --body hi'`],
  [NO, "env -S with the value attached", `env '-Sgh pr comment 5 -R acme/api --body hi'`],
  [NO, "env --split-string=", `env '--split-string=gh pr comment 5 -R acme/api' --body hi`],
  [NO, "env -iS after -u", `env -u X -iS 'gh pr comment 5 -R acme/api --body hi'`],
  [OK, "env -S with a marked body", `env -S 'gh pr comment 5 -R acme/api --body "> Written by agent. ok"'`],
  [OK, "env -u then a command", `env -u X gh pr comment 5 -R acme/api --body '> Written by agent. ok'`],
  // KJI8: a backtick's command is checked, not refused, in the comment-only path
  [OK, "a status line with a backtick date", "echo \"gh: `date`\""],
  [OK, "a marked comment with a backtick date", "gh pr comment 5 -R acme/api --body \"> Written by agent. at `date`\""],
  [NO, "a gh comment inside backticks", "echo `gh pr comment 5 -R acme/api --body hi`"],
  [NO, "a gh comment in backticks in double quotes", "echo \"x `gh pr comment 5 -R acme/api --body hi`\""],
  // KJJM: a shell runs its stdin, a quoted heredoc's too
  [NO, "a quoted heredoc to bash", "bash <<'EOF'\ngh pr comment 5 -R acme/api --body hi\nEOF"],
  [NO, "a heredoc to sh -s", "sh -s <<EOF\ngh pr comment 5 -R acme/api --body hi\nEOF"],
  [NO, "a here-string to bash", "bash <<< 'gh pr comment 5 -R acme/api --body hi'"],
  [NO, "an echo piped to bash", "echo 'gh pr comment 5 -R acme/api --body hi' | bash"],
  [OK, "a quoted heredoc to cat is data", "cat <<'EOF'\ngh pr comment 5 -R acme/api --body hi\nEOF"],
  [OK, "a heredoc to bash with a marked body", "bash <<'EOF'\ngh pr comment 5 -R acme/api --body '> Written by agent. ok'\nEOF"],
  // the comment rule applies no protect policy to the rest of the line
  [OK, "a PATH export before a read", "export PATH=/x:$PATH; gh pr view 5"],
  [OK, "a HOME override on a read", "HOME=/h gh pr view 5"],
  [OK, "a GIT_SSH_COMMAND override on a read", "GIT_SSH_COMMAND='ssh -i k' gh pr view 5"],
  [OK, "xargs after gh", "gh pr list | xargs -n1 echo"],
  [OK, "xargs kill then gh", "ls | xargs -r kill; gh pr view 5"],
  [OK, "a PATH export before a marked comment", "export PATH=/x:$PATH; gh pr comment 5 -R acme/api --body '> Written by agent. ok'"],
  [NO, "a PATH export before an unmarked comment", "export PATH=/x:$PATH; gh pr comment 5 -R acme/api --body hi"],
  [NO, "an env-prefixed echo piped to bash", "HOME=/h echo 'gh pr comment 5 -R acme/api --body hi' | bash"],
  // printed text piped into xargs, which runs gh or a shell with it
  [NO, "echo into xargs -0 bash -c", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -0 bash -c"],
  [NO, "echo into xargs gh", "echo 'pr comment 5 -R acme/api --body hi' | xargs gh"],
  [NO, "printf into xargs -n1 gh pr comment", "printf '5\\n' | xargs -n1 gh pr comment -R acme/api --body hi"],
  [NO, "unknown input into xargs gh", "cat args | xargs gh"],
  [NO, "unknown input into xargs sh -c beside gh", "gh pr view 5; cat cmds | xargs -0 sh -c"],
  [OK, "echo into xargs gh with a marked comment", "echo \"pr comment 5 -R acme/api --body '> Written by agent. ok'\" | xargs gh"],
  [NO, "unknown input into xargs -I gh pr comment", "cat prs | xargs -I{} gh pr comment {} -R acme/api --body hi"],
  [NO, "unknown input into xargs -I sh -c with a comment", "ls | xargs -I{} sh -c 'gh pr comment {} -R acme/api --body hi'"],
  [OK, "unknown input into xargs -I gh api read", "gh run list -q .[0].id | xargs -I{} gh run view {} --log-failed"],
  [OK, "unknown input into xargs -I sh -c read", "ls -d */ | xargs -I{} sh -c 'git -C {} remote get-url origin'; gh repo view acme/api"],
  // under -I the shown input goes into the replace string's slots
  [NO, "echo into xargs -I{} bash -c {}", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -I{} bash -c {}"],
  [NO, "echo into xargs -I{} sh -c '{}'", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -I{} sh -c '{}'"],
  [NO, "echo into xargs -I % sh -c %", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -I % sh -c %"],
  [NO, "echo into xargs -IX sh -c X", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -IX sh -c X"],
  [NO, "echo into xargs -i bash -c {}", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -i bash -c {}"],
  [NO, "echo into xargs -ri: -i in a cluster, last (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -ri bash -c {}"],
  [NO, "echo into xargs -0i: -i after -0 (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -0i bash -c {}"],
  [NO, "echo into xargs -ti: -i after -t (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -ti bash -c {}"],
  [NO, "echo into xargs -r0i: -i after -r0 (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -r0i bash -c {}"],
  [NO, "echo into xargs -dI: an I that is -d's value, then -I{} (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -dI -I{} sh -c {}"],
  [NO, "echo into xargs -EI: an I that is -E's value, then -I{} (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -EI -I{} sh -c {}"],
  [NO, "echo into xargs -rI: -I ending a cluster takes the next word (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -rI {} bash -c {}"],
  [NO, "echo into xargs -rd: -d ending a cluster takes the next word (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -rd , -I{} sh -c {}"],
  [NO, "echo into xargs -ei: -e's optional value is no slot (Marie on #128)", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -ei -I{} sh -c {}"],
  [OK, "xargs -rI {} on a read", "echo 5 | xargs -rI {} gh pr view {} -R acme/api"],
  [NO, "echo into xargs --replace bash -c {}", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs --replace bash -c {}"],
  [NO, "echo into a slot after a first command", "echo 'gh pr comment 5 -R acme/api --body hi' | xargs -I{} sh -c 'echo start; {}'"],
  [NO, "a quote break through a slot", "echo \"x' ; gh pr comment 5 -R acme/api --body hi ; '\" | xargs -I{} sh -c \"git -C '{}' status\""],
  [NO, "a here-string into xargs -I{} sh -c", "xargs -I{} sh -c '{}' <<< 'gh pr comment 5 -R acme/api --body hi'"],
  [NO, "a heredoc into xargs -I{} sh -c", "xargs -I{} sh -c '{}' <<'E'\ngh pr comment 5 -R acme/api --body hi\nE"],
  [NO, "the second line into a slot", "printf 'a\\ngh pr comment 5 -R acme/api --body hi\\n' | xargs -I{} sh -c '{}'"],
  [NO, "a printed second line piped to sh", "printf 'a\\ngh pr comment 5 -R acme/api --body hi\\n' | sh"],
  [NO, "gh spelt in octal, piped to sh", "printf '\\147h pr comment 5 -R acme/api --body hi' | sh"],
  [NO, "gh spelt in hex, piped to sh", "echo -e '\\x67h pr comment 5 -R acme/api --body hi' | sh"],
  [OK, "an escape that goes to no shell", "printf '\\033[1mbold\\033[0m\\n'"],
  [OK, "an unreadable printf in another pipe", "printf '  %-24s %s\\n' a b; git diff --name-only | xargs -I{} sh -c 'echo {}'; gh pr view 5"],
  // xargs -I takes a line's quotes in its default mode, so sh gets
  // --body > Written by agent. ok, a redirection; -d '\n' passes the line as it is
  [NO, "a marked body whose quotes xargs takes", "echo \"gh pr comment 5 -R acme/api --body '> Written by agent. ok'\" | xargs -I{} sh -c '{}'"],
  [OK, "a marked comment through a slot", "echo \"gh pr comment 5 -R acme/api --body '> Written by agent. ok'\" | xargs -d '\\n' -I{} sh -c '{}'"],
  // and xargs' input fills the slots of a command that is also checked as written, so --body {} is
  // refused whatever the input: the line's input is not read as all there is (a reading that took it
  // as whole would let unmarked comments through)
  [NO, "a marked line into --body {}", "echo '> Written by agent. ok' | xargs -I{} gh pr comment 5 -R acme/api --body {}"],
  [NO, "a marked here-string into --body {}", "xargs -I{} gh pr comment 5 -R acme/api --body {} <<< '> Written by agent. ok'"],
  [NO, "an unmarked line into --body {}", "echo hi | xargs -I{} gh pr comment 5 -R acme/api --body {}"],
  [NO, "a marked line and a file into --body {}", "{ echo '> Written by agent. ok'; cat f; } | xargs -I{} gh pr comment 5 -R acme/api --body {}"],
  [NO, "a file after the here-string on fd 0", "xargs -I{} gh pr comment 5 -R acme/api --body {} <<< '> Written by agent. ok' < f"],
  [NO, "a file into --body {}", "cat f | xargs -I{} gh pr comment 5 -R acme/api --body {}"],
  [NO, "a marked line and a file from a subshell", "(echo '> Written by agent. ok'; cat f) | xargs -I{} gh pr comment 5 -R acme/api --body {}"],
  [NO, "a file piped into a group past a marked line", "cat f | { echo '> Written by agent. ok'; xargs -I{} gh pr comment 5 -R acme/api --body {}; }"],
  [NO, "a here-string on fd 3 and a file on fd 0", "xargs -I{} gh pr comment 5 -R acme/api --body {} 3<<< '> Written by agent. ok' < f"],
  [NO, "a file in place of the pipe", "echo '> Written by agent. ok' | xargs -I{} gh pr comment 5 -R acme/api --body {} < f"],
  // probes as a harness runs them: each posts an unmarked comment in bash
  [NO, "M1 a here-string that expands $(...)", "xargs -I{} gh pr comment 5 --body {} <<< \"> Written by agent.$(cat evil2)\""],
  [NO, "M1 a here-string that expands a backtick", "xargs -I{} gh pr comment 5 --body {} <<< \"> Written by agent.`cat evil2`\""],
  [NO, "M1 a here-string with an unquoted $(...)", "xargs -I{} gh pr comment 5 --body {} <<< '> Written by agent.'$(cat evil2)"],
  [NO, "M1 a heredoc that expands", "xargs -I{} gh pr comment 5 --body {} <<EOF\n> Written by agent.$(cat evil2)\nEOF"],
  [NO, "M2 fd 0 duplicated after the here-string", "xargs -I{} gh pr comment 5 --body {} 3<evil <<< '> Written by agent. ok' <&3"],
  [NO, "M3 echo redefined", "echo() { cat evil; }; echo '> Written by agent. ok' | xargs -I{} gh pr comment 5 --body {}"],
  [NO, "M3 echo redefined on the line before", "echo() { cat evil; }\necho '> Written by agent. ok' | xargs -I{} gh pr comment 5 --body {}"],
  [NO, "M3 function echo", "function echo { cat evil; }; echo '> Written by agent. ok' | xargs -I{} gh pr comment 5 --body {}"],
  [NO, "M3 builtin redefined", "builtin() { cat evil; }; builtin echo '> Written by agent. ok' | xargs -I{} gh pr comment 5 --body {}"],
  [NO, "M3 echo disabled and found on PATH", "enable -n echo; PATH=.:$PATH; printf '#!/bin/sh\\ncat evil\\n' > echo; chmod +x echo; echo '> Written by agent. ok' | xargs -I{} gh pr comment 5 --body {}"],
  // a backtick after a # still runs where the # starts no comment, so none is skipped as one
  [NO, "M4 a # after a backslash-newline", "echo a\\\n#`gh pr comment 5 --body Fixed`"],
  [NO, "M4 a # in a $(...) in double quotes", "echo \"$(echo \" #\")`gh pr comment 5 --body Fixed`\""],
  [NO, "M4 a # after a carriage return", "x\r#`gh pr comment 5 --body Fixed`"],
  [NO, "M4 a # after a vertical tab", "echo x\u000b#`gh pr comment 5 --body Fixed`"],
  [NO, "M4 a # after a form feed", "echo x\f#`gh pr comment 5 --body Fixed`"],
  [NO, "M4 a # after a non-breaking space", "echo x #`gh pr comment 5 --body Fixed`"],
  [NO, "a backtick in a trailing comment is still read", "gh pr view 5 # it`s"],
  [NO, "a backtick after a # inside ${...}", "echo ${x/ #/`gh pr comment 5 -R acme/api --body hi`}"],
  [NO, "a backtick after a # inside a word", "echo a#`gh pr comment 5 -R acme/api --body hi`"],
  [NO, "a backtick after a quoted #", "echo '#' `gh pr comment 5 -R acme/api --body hi`"],
  [NO, "a backtick on the line after a comment", "gh pr view 5 # x\necho `gh pr comment 5 -R acme/api --body hi`"],
  // GNU xargs drops -I for a -L, -l, -n or --max-* with it, and {} is posted as written or the input
  // appended, where the last --body wins
  [NO, "M5 -I then -L1, {} posted as written", "echo '> Written by agent. ok' | xargs -I{} -L1 gh pr comment 5 --body {}"],
  [NO, "M5 -I then -L 1", "echo '> Written by agent. ok' | xargs -I{} -L 1 gh pr comment 5 --body {}"],
  [NO, "M5 -I then -l", "echo '> Written by agent. ok' | xargs -I{} -l gh pr comment 5 --body {}"],
  [NO, "M5 -I then --max-lines=1", "echo '> Written by agent. ok' | xargs -I{} --max-lines=1 gh pr comment 5 --body {}"],
  [NO, "M5 -I then -L1, the input appended", "echo '5 --body Fixed' | xargs -I{} -L1 gh pr comment --body '> Written by agent. x'"],
  [NO, "M5 -IX then -L1", "echo '5 --body Fixed' | xargs -IX -L1 gh pr comment --body '> Written by agent. x'"],
  [NO, "M5 -I then -n2", "echo '5 --body Fixed' | xargs -I{} -n2 gh pr comment --body '> Written by agent. x'"],
  [NO, "M5 -I then -L1 from a file", "xargs -I{} -L1 gh pr comment --body '> Written by agent. x' < evil"],
  [NO, "M5 -I then -L1 with {} as the number", "echo '5 --body Fixed' | xargs -I{} -L1 gh pr comment {} --body '> Written by agent. x'"],
  [NO, "M5 -I then -L1 from a here-string", "xargs -I{} -L1 gh pr comment {} --body '> Written by agent. x' <<< '5 --body Fixed'"],
  [NO, "M5 -I then -L1 with {} in the marked body", "echo '--body Fixed' | xargs -I{} -L1 gh pr comment 5 --body '> Written by agent. {}'"],
  [NO, "M5 -L1 then -I", "echo '5 --body Fixed' | xargs -L1 -I{} gh pr comment --body '> Written by agent. x'"],
  [NO, "M5 --max-args=1 then --replace", "echo '5 --body Fixed' | xargs --max-args=1 --replace gh pr comment --body '> Written by agent. x'"],
  // a $'...' takes \' as a letter, so the backtick after it runs
  [NO, "M6 a backtick after $'\\''", "echo $'\\'' `gh pr comment 5 --body Fixed`"],
  [NO, "M6 a backtick after $'...' in a comment, refused though bash runs nothing", "echo $'\\'' #`gh pr comment 5 --body Fixed`"],
  [NO, "an arithmetic # before a backtick", "echo $(( 2#1 ))`gh pr comment 5 --body Fixed`"],
  [OK, "xargs -I alone on a marked -c", "echo 5 | xargs -I{} gh pr view {} -R acme/api"],
  [OK, "gh output into xargs echo", "gh pr list | xargs -n1 echo"],
  [OK, "xargs kill then a gh read", "ls | xargs -r kill; gh pr view 5"],
  // a filter between printf and a shell, xargs batches, -d items
  [NO, "printf through sed into sh", "printf '%s\\n' \"gh pr comment 5 -R acme/api --body '> Written by agent. hi'\" | sed 's/Written by agent/posted/' | sh"],
  [NO, "echo through tr into bash", "echo \"gh pr comment 5 -R acme/api --body '> Written by agent. hi'\" | tr W w | bash"],
  [OK, "printf straight into sh with a marked comment", "printf '%s\\n' \"gh pr comment 5 -R acme/api --body '> Written by agent. hi'\" | sh"],
  [NO, "xargs -n1 runs gh on 5 alone", "printf '%s\\n' \"5 --body '> Written by agent. ok'\" | xargs -n1 gh pr comment -R acme/api --body hi"],
  [NO, "xargs --max-args=1 runs gh on 5 alone", "echo \"5 --body '> Written by agent. ok'\" | xargs --max-args=1 gh pr comment -R acme/api --body hi"],
  [NO, "xargs -L1 runs gh on its first line alone", "printf \"5\\n--body '> Written by agent. ok'\\n\" | xargs -L1 gh pr comment -R acme/api --body hi"],
  [OK, "xargs -n3 with a marked body in each run", "echo \"5 --body '> Written by agent. ok'\" | xargs -n3 gh pr comment -R acme/api"],
  [NO, "xargs -s cuts runs where this cannot tell", "echo \"5 --body '> Written by agent. ok'\" | xargs -s 40 gh pr comment -R acme/api"],
  [NO, "xargs -d keeps an item's quotes", "printf '%s\\n' \"--body='> Written by agent. ok'\" | xargs -d '\\n' gh pr comment 5 -R acme/api --body hi"],
  [NO, "xargs --delimiter=, keeps an item's quotes", "echo \"--body='> Written by agent. ok'\" | xargs --delimiter=, gh pr comment 5 -R acme/api --body hi"],
  [OK, "xargs -d with a marked item", "printf '%s\\n' '--body=> Written by agent. ok' | xargs -d '\\n' gh pr comment 5 -R acme/api"],
  // xargs -a takes its items from a file the line does not show
  [NO, "xargs -a beside marked stdin", "echo \"5 --body '> Written by agent. ok'\" | xargs -a prs gh pr comment -R acme/api"],
  [NO, "xargs -aFILE beside marked stdin", "echo \"5 --body '> Written by agent. ok'\" | xargs -aprs gh pr comment -R acme/api"],
  [NO, "xargs --arg-file beside marked stdin", "echo \"5 --body '> Written by agent. ok'\" | xargs --arg-file prs gh pr comment -R acme/api"],
  [NO, "xargs --arg-file= beside marked stdin", "echo \"5 --body '> Written by agent. ok'\" | xargs --arg-file=prs gh pr comment -R acme/api"],
  [NO, "xargs -r -a into a -I slot of a marked command", "echo 5 | xargs -r -a prs -I{} gh pr comment {} -R acme/api --body '> Written by agent. ok'"],
  // long options' values as GNU takes them, and the eof word
  [NO, "xargs --max-lines takes no next word", "echo 5 | xargs --max-lines gh pr comment -R acme/api --body hi"],
  [NO, "xargs --eof takes no next word", "echo 5 | xargs --eof gh pr comment -R acme/api --body hi"],
  [NO, "xargs --max-l, a prefix of --max-lines", "echo 5 | xargs --max-l gh pr comment -R acme/api --body hi"],
  [NO, "xargs --max-a 1, a prefix of --max-args", "echo 5 | xargs --max-a 1 gh pr comment -R acme/api --body hi"],
  [NO, "xargs --process-slot-var takes the next word", "echo 5 | xargs --process-slot-var X gh pr comment -R acme/api --body hi"],
  [NO, "xargs -E END hides a marked --body after END", "echo \"5 END --body '> Written by agent. ok'\" | xargs -E END gh pr comment -R acme/api --body hi"],
  [NO, "xargs -eEND hides a marked --body after END", "echo \"5 END --body '> Written by agent. ok'\" | xargs -eEND gh pr comment -R acme/api --body hi"],
  [NO, "xargs --eof=END hides a marked --body after END", "echo \"5 END --body '> Written by agent. ok'\" | xargs --eof=END gh pr comment -R acme/api --body hi"],
  // every wrapper's long options as getopt_long reads them, and one
  // none of them has refuses a line that may run gh after it
  [NO, "timeout --sig, a prefix of --signal", "timeout --sig KILL 5 gh pr comment 5 -R acme/api --body hi"],
  [NO, "timeout --k, a prefix of --kill-after", "timeout --k 1 5 gh pr comment 5 -R acme/api --body hi"],
  [NO, "nice --adj, a prefix of --adjustment", "nice --adj 5 gh pr comment 5 -R acme/api --body hi"],
  [NO, "env --spl, a prefix of --split-string", "env --spl 'gh pr comment 5 -R acme/api --body hi'"],
  [NO, "env --ch, a prefix of --chdir", "env --ch /tmp gh pr comment 5 -R acme/api --body hi"],
  [NO, "env --un, a prefix of --unset", "env --un X gh pr comment 5 -R acme/api --body hi"],
  [NO, "env --argv0 takes the next word", "env --argv0 x gh pr comment 5 -R acme/api --body hi"],
  [NO, "sudo --us, a prefix of --user", "sudo --us root gh pr comment 5 -R acme/api --body hi"],
  [NO, "stdbuf --outp, a prefix of --output", "stdbuf --outp L gh pr comment 5 -R acme/api --body hi"],
  [NO, "time --form, a prefix of --format", "/usr/bin/time --form x gh pr comment 5 -R acme/api --body hi"],
  [NO, "an option sudo has not, before gh", "sudo --frob x gh pr comment 5 -R acme/api --body hi"],
  [NO, "an option exec has not, before gh", "exec --frob x gh pr comment 5 -R acme/api --body hi"],
  [OK, "timeout --signal=KILL on a gh read", "timeout --signal=KILL 5 gh pr view 5"],
  [OK, "sudo --us root on a marked comment", "sudo --us root gh pr comment 5 -R acme/api --body '> Written by agent. ok'"],
  [OK, "an option nice has not, with no gh after it", "nice --frob x ls; gh pr view 5"],
  // short-option groups as getopt reads them, a short letter no table
  // has, and a command word bash makes from a variable or a substitution
  [NO, "sudo -nu: u takes the next word", "sudo -nu root gh pr comment 5 -R acme/api --body hi"],
  [NO, "sudo -Eu: u takes the next word", "sudo -Eu root gh pr comment 5 -R acme/api --body hi"],
  [NO, "sudo -iu: u takes the next word", "sudo -iu root gh pr comment 5 -R acme/api --body hi"],
  [NO, "timeout -vs: s takes the next word", "timeout -vs KILL 5 gh pr comment 5 -R acme/api --body hi"],
  [NO, "timeout -vk: k takes the next word", "timeout -vk 1 5 gh pr comment 5 -R acme/api --body hi"],
  [NO, "time -qo: o takes the next word", "/usr/bin/time -qo f gh pr comment 5 -R acme/api --body hi"],
  [NO, "time -af: f takes the next word", "/usr/bin/time -af x gh pr comment 5 -R acme/api --body hi"],
  [NO, "exec -ca: a takes the next word", "exec -ca x gh pr comment 5 -R acme/api --body hi"],
  [NO, "env -, its -i", "env - gh pr comment 5 -R acme/api --body hi"],
  [NO, "a short letter sudo has not, before gh", "sudo -z x gh pr comment 5 -R acme/api --body hi"],
  [NO, "a command word from a variable", "G=gh; $G pr comment 5 -R acme/api --body hi"],
  [NO, "a command word from a substitution", "$(echo gh) pr comment 5 -R acme/api --body hi"],
  [NO, "a command word from a backtick", "`echo gh` pr comment 5 -R acme/api --body hi"],
  [NO, "a variable after an option sudo has not", "G=gh; sudo --frob x $G pr comment 5 -R acme/api --body hi"],
  [NO, "a substitution after an option sudo has not", "sudo --frob x $(echo gh) pr comment 5 -R acme/api --body hi"],
  [OK, "sudo -nu root on a marked comment", "sudo -nu root gh pr comment 5 -R acme/api --body '> Written by agent. ok'"],
  [OK, "nice --10, a negative adjustment, on a marked comment", "nice --10 gh pr comment 5 -R acme/api --body '> Written by agent. ok'"],
  [OK, "a short letter sudo has not, with no gh after it", "sudo -z x ls; gh pr view 5"],
  [OK, "gh by a plain path under $HOME", "\"$HOME/.local/bin/gh\" pr view 5"],
  // gh lines as this machine's sessions run them: a variable the line sets to a
  // literal, a session directory, and a dynamic word before a read are read, not refused
  [OK, "gh from a variable set to a path under $HOME", "G=$HOME/.local/bin/gh; $G pr view 5"],
  [OK, "a script under $CLAUDE_JOB_DIR on a gh line", "$CLAUDE_JOB_DIR/tmp/x.sh; gh pr view 5"],
  [OK, "a script from a variable set to a path under ~", "D=~/agents/bin/delegations.sh; $D open; gh pr view 5"],
  [OK, "gh from a variable set twice to gh paths", "G=~/.local/bin/gh; [ -x $G ] || G=~/agents/bin/gh; $G pr view 5"],
  [OK, "a variable set to words with blanks", "P=\"node $CLAUDE_JOB_DIR/tmp/p.mjs\"; $P 'gh pr comment 5 --body hi'; gh pr view 5"],
  [OK, "a case subject on a gh line", "case \"$st\" in open) gh pr view 5;; esac"],
  [OK, "a dynamic word before a gh read", "G=$(echo gh); $G pr view 5"],
  [OK, "a dynamic word on a git ref write", "GH=${GH_BIN:-gh}; $GH api -X POST repos/a/b/git/refs -f ref=refs/heads/x -f sha=\"$M\"; gh pr view 5"],
  [NO, "gh from a variable set to a path under $HOME, on a comment", "G=$HOME/.local/bin/gh; $G pr comment 5 -R acme/api --body hi"],
  [NO, "a variable whose value has blanks", "G=\"gh pr\"; $G comment 5 -R acme/api --body hi"],
  [NO, "a variable set to gh and then to ls", "G=gh; G=ls; $G pr comment 5 -R acme/api --body hi"],
  [NO, "a variable from a substitution, on a comment", "G=$(echo gh); $G pr comment 5 -R acme/api --body hi"],
  [NO, "a variable from a default, on a reply", "GH=${GH_BIN:-gh}; $GH api -X POST repos/a/b/pulls/5/comments/1/replies -f body=hi; gh pr view 5"],
  [NO, "a variable set to a read and then to a comment", "G=\"gh pr view\"; G=\"gh pr comment\"; $G 5 -R a/b --body hi"],
  [NO, "a variable set to a read and then to an issue comment", "G=\"gh issue view\"; G=\"gh issue comment\"; $G 5 -R a/b --body hi"],
  [NO, "a variable set to a read and then to an api reply", "G=\"gh api repos/a/b/pulls/5/comments\"; G=\"gh api -X POST repos/a/b/pulls/5/comments/1/replies\"; $G -f body=hi"],
  [NO, "a substitution on a GraphQL query from a file", "G=$(command -v gh); $G api graphql -F query=@m.graphql"],
  [NO, "a variable from a default, on a close with a comment", "GH=${GH_BIN:-gh}; $GH pr close 5 -R acme/api -c hi"],
  [NO, "xargs -d with a delimiter this cannot read", "echo 5 | xargs -d ab gh pr comment -R acme/api --body '> Written by agent. ok'"],
];

test("the shapes CodeRabbit found in #128 at 5332c327 are read as bash and gh read them", () => {
  const wrong: string[] = [];
  for (const [want, name, cmd] of ROUND_128) {
    const hook = commentVerdict(cmd);
    if ((hook === null ? OK : NO) !== want) wrong.push(`hook ${want === OK ? "refused" : "allowed"} ${name}: ${cmd}${hook ? ` (${hook})` : ""}`);
    if (want === NO && verdict(cmd, pr) === null) wrong.push(`protect allowed ${name}: ${cmd}`);
  }
  assert.deepEqual(wrong, []);
});

// KJJa: the review tools other GitHub MCP releases name, and a review's inline comments[].body, are
// comments to both the marked-comments hook and the protect guard
test("the MCP review tools CodeRabbit found in #128 hold their bodies to the marker", () => {
  const A = { owner: "acme", repo: "api", pullNumber: 5 };
  const rows: [string, string, Record<string, unknown>][] = [
    [NO, "create_pull_request_review", { ...A, event: "COMMENT", body: "lgtm" }],
    [NO, "add_pull_request_review_comment_to_pending_review", { ...A, path: "a.ts", line: 1, body: "nit" }],
    [NO, "add_pull_request_review_comment", { ...A, path: "a.ts", line: 1, body: "nit" }],
    [NO, "create_pull_request_review_comment", { ...A, path: "a.ts", line: 1, body: "nit" }],
    [NO, "create_pull_request_review", { ...A, event: "COMMENT", body: `${M} ok`, comments: [{ path: "a.ts", line: 1, body: "nit" }] }],
    [NO, "pull_request_review_write", { ...A, method: "create", event: "COMMENT", body: `${M} ok`, comments: [{ path: "a", line: 1, body: "x" }] }],
    [OK, "create_pull_request_review", { ...A, event: "COMMENT", body: `${M} ok`, comments: [{ path: "a.ts", line: 1, body: `${M} nit` }] }],
    [OK, "create_pull_request_review", { ...A, event: "APPROVE" }],
  ];
  const wrong: string[] = [];
  for (const [want, name, tin] of rows) {
    const tool = `mcp__github__${name}`;
    const r = markedHook([], JSON.stringify({ tool_name: tool, tool_input: tin }));
    if ((r.code === 0 ? OK : NO) !== want) wrong.push(`hook ${want === OK ? "refused" : "allowed"} ${name} ${JSON.stringify(tin)}`);
    if (want === NO && mcpVerdict(tool, tin, pr) === null) wrong.push(`protect allowed ${name} ${JSON.stringify(tin)}`);
  }
  assert.deepEqual(wrong, []);
});
