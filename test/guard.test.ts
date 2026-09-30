import assert from "node:assert/strict";
import { test } from "node:test";
import { type GuardContext, verdict } from "../src/hooks/guard.js";

const ro: GuardContext = { role: "reviewer", policy: "readonly", writeDirs: [] };
const pr: GuardContext = { role: "builder", policy: "protect", writeDirs: [] };

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
    "git push origin CL-1 main", "env git push origin main",
  ]],
  [pr, ALLOW, [
    "git push -u origin CL-1", "git push --force-with-lease origin MOBILE-1", "git push origin feature/main-menu", "git push origin main-fix",
    "git checkout -b CL-1 origin/main", "git switch -c CL-1 origin/main", "git rebase origin/main", "git branch -D CL-1", "git checkout origin/main -- file",
    "git log main..HEAD", "git diff main", "gh pr create --draft --title x", "gh pr ready 1 --undo", 'git reset --soft origin/main && git commit -m "MOBILE-1 x"',
    "npm install", "yarn build", "flutter pub run build_runner build --delete-conflicting-outputs --force-jit", "python3 scripts/x.py", "rm -rf node_modules",
    "git push -u origin MOBILE-1234", "git fetch origin main", "git reset --hard origin/main", "gh pr view 1", "git push origin HEAD:CL-1",
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
