import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { allowClosePath } from "../src/allow-close.js";
import { type GuardContext, hook, mcpVerdict, verdict } from "../src/hooks/guard.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, tempWorkspace } from "./helpers.js";

const ro: GuardContext = { role: "reviewer", policy: "readonly", writeDirs: [], ownRepos: [] };
const pr: GuardContext = { role: "builder", policy: "protect", writeDirs: [], org: "acme", ownRepos: ["acme/workspace", "alex/factory"] };

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

// The lead undrafts a product PR of the --org by hand as well as through `factory pr-send`; nobody else
// does, and nobody at all outside the org or without naming the repo.
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

// A refspec with an empty source deletes the destination; every role is refused, by remote name or URL.
test("a :branch refspec is a refused delete for every role", () => {
  // +:CL-1 is refused by the + refspec rule before it reaches the delete rule; it stays here as a pin.
  const cmds = ["git push origin :CL-1", "git push origin :refs/heads/CL-1", "git push origin HEAD:CL-1 :CL-2", "git push origin +:CL-1",
    "git push https://github.com/acme/workspace.git :CL-1", "git push https://github.com/acme/api.git :CL-1"];
  const allowed = ["lead", "assistant", "builder"].flatMap((role) =>
    cmds.filter((c) => verdict(c, { ...pr, role }) === null).map((c) => `${role}: ${c}`));
  assert.deepEqual(allowed, []);
});

// A key in lyyti-config.php reached a transcript on 2026-10-20 and again on 2026-10-21, both times
// through a grep whose redaction missed. Every role refuses to print a secret file, filtered or not.
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

// Sanchez's form, 2026-10-26: the export ran where Nomura's `PATH=… npm test` was refused.
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

// A heredoc's body is dropped, but the line after its closing delimiter is a command of its own. On
// 2026-10-28 a `gh pr close` on a product repo went through because it was read as cat's argument.
test("the command after a heredoc is checked", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const write = "cat > /tmp/close3374.md <<'EOF'\n> Written by agent.\nClosing: superseded.\nEOF\n";
  for (const c of [`${write}gh pr close 3374 -R acme/api --comment "$(cat /tmp/close3374.md)"`, `${write}gh pr merge 3374 -R acme/api`])
    assert.notEqual(verdict(c, lead), null, c);
});

// Mikael, 2026-11-12: "I allow you to close the PR". A product PR closes only when he named that exact
// PR and `factory allow-close` recorded it; a merge never does.
test("the lead closes a product PR only once the human has named it", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const r = factory(dir, ["allow-close", "api", "8701", "--words", "I allow you to close the PR"]);
  assert.equal(r.status, 0, r.stderr);
  const lead: GuardContext = { ...pr, role: "lead", allowClose: allowClosePath(openWorkspace(dir).stateDir) };
  for (const c of ["gh pr close 8701 -R acme/api", "gh pr close 8701 --repo Acme/api --comment 'Superseded by #8702'",
    "gh pr close https://github.com/acme/api/pull/8701", "gh pr close https://github.com/acme/api/pull/8701/files -c x",
    "cat > /tmp/c.md <<'EOF'\nSuperseded.\nEOF\ngh pr close 8701 -R acme/api --comment \"$(cat /tmp/c.md)\""])
    assert.equal(verdict(c, lead), null, c);
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
    // gh takes -R/--repo before pr, or before its subcommand (Marie, after round 4)
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
  const allowed = ["gh pr checkout 12", "gh pr co 12", "gh alias list", "gh alias ls", "gh ext list", "gh pr view 1", "gh --version", "gh --help", "gh help", "gh -R acme/api pr checks 1"];
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
    ["create_or_update_file", { owner: "acme", repo: "workspace", branch: "main", path: "a", content: "", message: "x" }, pr],
    ["issue_write", { ...api, method: "create", title: "t" }, pr],
  ];
  // a GitHub tool is known by its tool name whatever its server is called (Niilo's ruling on #124)
  refused.push(["issue_write", { ...api, method: "update", issue_number: 8701, state: "closed" }, pr],
    ["issue_write", { ...api, method: "update", issue_number: 8702, state: "closed" }, lead]);
  allowed.push(["issue_write", { ...api, method: "update", issue_number: 8701, state: "closed" }, lead],
    ["issue_write", { ...api, method: "update", issue_number: 8702, state: "open" }, pr]);
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
// project script, and a command word from a variable matched no check (Marie on #124). Now a path is
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
// (Marie on #124). A write that does so on a repo not the factory's own is refused.
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

// gh api merged a branch into main, committed to it and transferred the repo (Marie on #124 at
// eb982692). On a product repo those are refused, and a contents write must name a feature branch.
test("gh api cannot merge, commit to main or transfer on a product repo", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const gql = (q: string) => `gh api graphql -f query='mutation { ${q} { clientMutationId } }'`;
  const put = "gh api -X PUT repos/acme/api/contents/a.txt -f message=m -f content=eA==";
  const refused = [put, `${put} -f branch=main`, `${put} -f branch=refs/heads/master`, `${put} --input body.json`,
    "gh api -X DELETE repos/acme/api/contents/a.txt -f message=m -f sha=abc", "gh api --method PUT /repos/acme/api/contents/src/a.ts -F message=m -F content=@a.b64",
    "gh api -X POST repos/acme/api/merges -f base=main -f head=feat", "gh api repos/acme/api/merges -f base=feat/x -f head=main",
    "gh api -X POST repos/acme/api/transfer -f new_owner=x",
    gql(`enqueuePullRequest(input: {pullRequestId: "x"})`), gql(`createCommitOnBranch(input: {branch: {branchName: "main"}})`)];
  const allowed = ["gh api -X PUT repos/acme/workspace/contents/a.txt -f message=m -f content=eA==", `${put} -f branch=feat/x`,
    "gh api repos/acme/api/contents/a.txt", "gh api repos/acme/api/merges"];
  const wrong: string[] = [];
  for (const ctx of [pr, lead]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// A push to a branch named by a variable or a substitution could be a push to main (Niilo on #124).
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

// Marie's third round on #124 at 7453c070: stdin by another name, env's clustered flags, find's second
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
// push (Marie and Niilo on #124, round 9). Links in a temp dir make the rows hold on any box.
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
  const refused = [`${bin}/e ${M}`, `PATH=${bin}:$PATH e ${M}`, `${bin}/r -c '${M}'`, `${bin}/git-core/git-push origin main`,
    `${bin}/git-core/git-push origin --delete x`, `${bin}/static-sh -c '${M}'`, `${bin}/busybox env ${M}`, `busybox sh -c '${M}'`,
    `nice ${bin}/e ${M}`, `ksh93 -c '${M}'`, `tcsh -c '${M}'`, `mksh-static -c '${M}'`, "git-push origin main", `env ${bin}/r -c '${M}'`];
  for (const [name, row] of [["/usr/bin/rsh", `rsh niilo '${M}'`], ["/usr/bin/rsh", `/usr/bin/rsh niilo '${M}'`], ["/usr/bin/slogin", `slogin niilo '${M}'`],
    ["/usr/bin/rbash", `rbash -c '${M}'`], ["/usr/bin/static-sh", `static-sh -c '${M}'`], ["/usr/bin/busybox", `busybox env ${M}`],
    ["/usr/lib/git-core/git-push", "/usr/lib/git-core/git-push origin main"], ["/usr/lib/git-core/git-push", "/usr/lib/git-core/git-push origin --delete x"]] as const)
    if (existsSync(name)) refused.push(row);
  const allowed = ["git status", "/usr/bin/git status", "ssh niilo uptime", "npm test", "./scripts/report", "~/agents/bin/pr-send.sh 124 abc",
    `${bin}/e npm test`, `${bin}/git-core/git-push origin feature/x`, "sh -c 'npm test'", "awk 1 x.txt", "python3 -V"];
  const wrong: string[] = [];
  for (const ctx of [pr, { ...pr, role: "lead" }]) {
    for (const c of refused) if (verdict(c, ctx) === null) wrong.push(`${ctx.role} allowed: ${c}`);
    for (const c of allowed) if (verdict(c, ctx) !== null) wrong.push(`${ctx.role} refused: ${c} (${verdict(c, ctx)})`);
  }
  assert.deepEqual(wrong, []);
});

// The command word is read by its shape, an allowlist; every trick Marie listed at ae2e8d06 goes
// through the one rule (Marie and Niilo on #124, round 8).
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

// The trusted-dir check compared how a directory was written, not where it resolves (Marie on #124
// at 4cf72e6e).
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

// A command word's directory from a variable lost its `$` to the basename, and the shell splits it
// (Marie on #124 at e6b2e171).
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
// (Marie on #124 at beb31d9e).
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

// Marie on #124 at beb31d9e, and CodeRabbit's review of eb982692: gh issue close/reopen/lock/unlock
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

// Wrappers and shells ran gh past every check (Marie on #124 at eb982692): nice, setsid, stdbuf,
// flock, env -S, find -exec, ssh, a shell reading its script from a pipe, a here-string, a heredoc or
// a <( ... ), and a substitution inside quotes or a <( ... ). Each is now read through to its command.
test("gh run through a wrapper, a substitution or a shell on stdin is checked", () => {
  const lead: GuardContext = { ...pr, role: "lead" };
  const M = "gh pr merge 1 -R acme/api";
  const refused = [`nice ${M}`, `nice -n 5 ${M}`, `nice -n5 ${M}`, `setsid ${M}`, `setsid -f ${M}`, `stdbuf -o0 ${M}`, `stdbuf -o 0 -e L ${M}`,
    `flock /tmp/l ${M}`, `flock -w 5 /tmp/l ${M}`, `flock /tmp/l -c '${M}'`, `env -S "${M}"`, `env --split-string="${M}"`, `env -S"${M}"`,
    `env -u X ${M}`, `env -C /tmp ${M}`, `nice env timeout 5 setsid ${M}`,
    `find . -exec ${M} \;`, `find . -execdir ${M} {} +`, `find . -name x -ok ${M} \;`,
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

// Mikko, 2026-11-14: the lead may merge test PRs and bug fixes again. Only on a lead_merges repo, only
// the lead, and only at the head it names; close, lock and every other role are as before.
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
