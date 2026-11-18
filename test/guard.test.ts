import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { allowClosePath } from "../src/allow-close.js";
import { commentVerdict, type GuardContext, verdict } from "../src/hooks/guard.js";
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
  // A comment goes out under the human's login: the watcher tells the factory's from the human's by
  // the marker (superfactory#119, L2), so a protected session posts only marked or trigger bodies.
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
  for (const c of ["gh pr close 8701 -R acme/api", "gh pr close 8701 --repo Acme/api --comment '> Written by agent. Superseded by #8702'",
    "gh pr close https://github.com/acme/api/pull/8701", "gh pr close https://github.com/acme/api/pull/8701/files -c '> Written by agent. x'"])
    assert.equal(verdict(c, lead), null, c);
  // Its close comment is still a comment under the human's login (#119 round 4).
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
  };
  for (const [what, reason] of Object.entries(refused)) assert.notEqual(reason, null, `${what} should be refused`);
  assert.match(refused["an unrecorded PR"] as string, /acme\/api#8702 is not on the allow-close list; .*factory allow-close <repo-key> <n> --words/);
  assert.match(refused["a merge of the recorded PR"] as string, /^merge of a PR on a product repo/);
  assert.match(refused["no number"] as string, /needs its number or URL/);
  // the factory's own repos are unchanged
  assert.equal(verdict("gh pr close 3 -R acme/workspace", { ...pr, role: "assistant" }), null);
  // the words are the permission
  assert.notEqual(factory(dir, ["allow-close", "api", "8703"]).status, 0);
  assert.notEqual(factory(dir, ["allow-close", "nope", "8703", "--words", "x"]).status, 0);
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

// The comment rule, every shape (superfactory#119, rounds 1 to 4). Every comment the factory posts
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
  // by then it could be anything (Niilo on R6, after round 4). Variables from files are refused when
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
];

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
