// PreToolUse hook for Claude Code's Bash tool, run as `factory hook guard --role R --policy P`.
//
// Reads {"tool_input":{"command": "..."}} on stdin. Exit 0 lets the call through, exit 2 blocks it
// and feeds the reason back to the model. Any trouble blocks (fail closed), including a missing
// --role or --policy: the rendered settings name both, and a guard that guessed its role is the
// one that once told a lead it was a builder.
//
// readonly: DEFAULT DENY. The command is tokenised with shell quoting rules, split into simple
// commands, and every simple command must match a known read-only shape. Writes are allowed only
// under /tmp and the --write-dir directories.
//
// protect (sessions in bypass permissions, where deny rules do not apply): default allow, but no
// push to a protected branch by any spelling, no force push without a lease, no wholesale pushes,
// no branch deletes on origin, no merging through gh, no closing through gh except by the lead on a
// product PR the human named (the --allow-close list), no undrafting through gh except by the lead on
// a PR of the --org, no checkout of a protected branch. The --own-repo repos have main as their only branch and no PRs: a push to main is allowed
// when it names one of them by URL, and so is renaming a branch of one to main. Deleting a branch
// through the API is allowed outside the --org, and for the lead in an --own-repo when GitHub says
// the branch is merged into the default branch.
//
// Why a parser and not regexes: a blocklist cannot enumerate a shell (`command git commit`, a
// newline before the command, `git -c x=y push origin main`, `git push origin CL-1:main`,
// `--mirror`, `find -delete`, `python3 -c "open(...,'w')"`). An allowlist of shapes can be read and
// audited; test/guard.test.ts is the contract.
//
// Its limit: the guard checks the commands it can parse, through exec wrappers (env, nice, timeout,
// find -exec, ssh <host> ...) and a shell reading its script from a heredoc or a here-string. Code it
// cannot read is outside it: python/node/perl/ruby -c or -e, an editor's command (vi -c '!...'),
// make, npm scripts, a script file. It stops habits and mistakes, not a session set on getting
// around it.
//
// A command word is read by its shape, an allowlist (commandWord): a bare name, an absolute or ~/
// path, or a relative path with no `..`. Any other word (a glob, a brace, ~+, a variable) is
// refused. The program is then named by the file that runs: PATH, then realpath, then basename.
//
// The argv rule fails closed on programs the guard does not read: any later argument that names gh,
// git, ssh, a shell or busybox (ionice gh ..., strace -o x bash -c ...), any option value that does
// (--pre=gh), and any argument holding a line that starts with one (watch 'gh ...', vi -c '!gh ...')
// is checked as a command. Skipped: the arguments of a program that never runs another (DATA_ONLY:
// echo, grep, ls, which, cat, ...; rg without --pre; command -v), and docker run's image word. A git
// -c setting git runs as a command (core.pager, core.sshCommand, *.textconv, ...) is checked too.
// The trigger is any argument whose program, past wrappers (env, nice, timeout, watch, xargs, sudo,
// ...), commandWord names as one the guard reads specially. A string argument run as a shell line
// (tmux new-session/new-window/split-window/run-shell/..., su/runuser -c) is parsed in full like
// bash -c, and a failed parse refuses. Any other string argument holding shell syntax is read for its
// commands that reach gh, git, ssh or a shell (foo 'true; gh pr merge ...'): prose that only looks
// like one (a gh word that is no gh command, a cut that does not parse) is left as text.
//
// Scheduled commands: the lines piped, heredoc'd or here-stringed into `crontab` or `crontab -` (each
// line's command after its five time fields or @word, up to an unescaped %), `at` and `batch` are
// checked as commands. Text the guard cannot see is outside it, like a script file: `crontab <file>`,
// `at -f <file>`, and a pipe from anything but echo or printf (cat cron.txt | crontab -).
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { parseArgs } from "node:util";
import { allowClosePath, closable } from "../allow-close.js";
import { MARKER } from "../gate/comment.js";
import type { HookResult } from "../settings.js";
import { chars, run } from "../util.js";
import { openWorkspace, resolveWorkspace } from "../workspace.js";

export const POLICIES = ["readonly", "protect"] as const;
export type Policy = (typeof POLICIES)[number];

export interface GuardContext {
  role: string;
  // the system bin dirs, for tests only: a fixture's links stand for a box's (never set from argv)
  binDirs?: readonly string[];
  // set by checkCommand when the command line names HOME other than as $HOME or ${HOME}: then a
  // $HOME/... command word may hold anything
  homeAssigned?: boolean;
  // set by checkCommand when the line changes directory, so a relative path cannot be resolved
  // (cd, pushd, popd, env -C or --chdir, find -execdir or -okdir)
  cwdChanged?: boolean;
  policy: Policy;
  writeDirs: string[];
  org?: string;
  ownRepos: string[];
  // [github] lead_merges: product repos where the lead, and only the lead, may `gh pr merge` a PR at a
  // head it names with --match-head-commit. Which PRs it merges is its own call, not the guard's.
  leadMerges?: string[];
  // Whether a branch of owner/repo is merged into the default branch. Tests stub it; the hook asks GitHub.
  isMerged?: (repo: string, branch: string) => boolean;
  // owner/repo's default branch, or null when it cannot be read. Tests stub it; the hook asks GitHub.
  defaultBranch?: (repo: string) => string | null;
  // tests only: a PR's head repo and branch, in place of GitHub's
  prHead?: (repo: string, n: string) => [string, string] | null;
  // state/allow-close.jsonl: the product PRs the human has named for the lead to close. Without it the
  // lead's guard finds the file through its workspace, so a lead launched before the flag existed
  // needs no restart.
  allowClose?: string;
  // The workspace `factory --workspace` named, if any.
  workspace?: string;
}

export const PROTECTED = new Set(["main", "master", "staging", "production", "dev"]);
// Platform paths, not anyone's: macOS first, as the design says.
export const TMP_ROOTS = ["/tmp", "/private/tmp"];
const TRUSTED_BIN_DIRS = new Set(["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/opt/coreutils/libexec/gnubin"]);

// Where a directory resolves on this box, the one the command runs on: /usr/bin/../bin,
// /usr/bin/X11 (a link to .) and /proc/self/root/usr/bin are all /usr/bin. One that does not exist
// runs nothing, so its normal form is kept. ~ is the home directory; a relative one is from cwd.
function resolveDir(dir: string): string {
  const abs = unresolved(dir === "~" || dir.startsWith("~/") ? homedir() + dir.slice(1) : dir);
  try {
    return realpathSync.native(abs);
  } catch {
    return posix.normalize(abs);
  }
}
// A path from cwd with its `..` left in: the kernel takes link/.. as the link target's parent, where
// posix.resolve (and realpathSync, which calls it) drops both (CodeRabbit on #124: link/../tool).
function unresolved(p: string): string {
  return p.startsWith("/") ? p : `${process.cwd()}/${p}`;
}
const trustedReal = new Map<readonly string[] | Set<string>, Set<string>>();
function trustedDir(dir: string, dirs: readonly string[] | Set<string> = TRUSTED_BIN_DIRS): boolean {
  let real = trustedReal.get(dirs);
  if (!real) trustedReal.set(dirs, (real = new Set([...dirs].map(resolveDir))));
  return real.has(resolveDir(dir));
}

class Refused extends Error {}

const refuse = (reason: string): never => {
  throw new Refused(reason);
};

// ---------------------------------------------------------------- tokenising

interface Tok {
  t: string;
  op: boolean;
  // the command substitutions inside a double-quoted word, "$(...)", each a command line of its own
  subs?: string[];
}

const PUNCT = ";&|<>()";
const SPACE = " \t\r\n";

// Python's shlex in posix mode with whitespace_split and punctuation_chars ";&|<>()", which is what
// this guard was written against. A token made of punctuation is marked op, so a quoted "|" or ";"
// stays a word.
export function tokenize(cmd: string): Tok[] {
  // a newline ends a command as ";" does, and ends a comment: it is kept until a token reads it
  const text = cmd.replace(/\r/g, "\n");
  const out: Tok[] = [];
  const back: string[] = [];
  let pos = 0;
  const next = () => back.pop() ?? text[pos++] ?? "";
  // the body of a $( ... ) up to its closing parenthesis, with the quoting inside it kept
  const sub = (): string => {
    let depth = 1;
    let q = "";
    let body = "";
    for (;;) {
      const c = next();
      if (c === "") refuse("cannot parse quoting (No closing parenthesis)");
      if (c === "\\" && q !== "'") {
        body += c + next();
        continue;
      }
      if (q) {
        if (c === q) q = "";
      } else if (c === "'" || c === '"') q = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return body;
      body += c;
    }
  };
  for (;;) {
    let tok = "";
    let quoted = false;
    let op = false;
    let state = " ";
    let esc = "a";
    let escaped = -1;
    // where the current double-quoted span began: only a `$` inside it opens a "$(...)", so the `$`
    // of '$'"(USD" is a letter (CodeRabbit on #124)
    let dq = -1;
    const subs: string[] = [];
    for (;;) {
      const c = next();
      if (state === " ") {
        if (c === "") break;
        if (c === "\n") {
          [tok, state, op] = [";", "c", true];
          continue;
        }
        // an unquoted # at the start of a word starts a comment, to the end of the line (bash's
        // interactive_comments, on in a non-interactive shell); a # inside a word is a letter
        if (c === "#") {
          let d = next();
          while (d !== "" && d !== "\n") d = next();
          if (d) back.push(d);
          continue;
        }
        if (SPACE.includes(c)) {
          if (tok || quoted) break;
          continue;
        }
        if (c === "\\") [esc, state] = ["a", "\\"];
        else if (PUNCT.includes(c)) [tok, state, op] = [c, "c", true];
        else if (c === "'" || c === '"') [state, dq] = [c, tok.length];
        else [tok, state] = [c, "a"];
        continue;
      }
      if (state === "'" || state === '"') {
        quoted = true;
        if (c === "") refuse("cannot parse quoting (No closing quotation)");
        if (c === state) state = "a";
        else if (c === "\\" && state === '"') [esc, state] = [state, "\\"];
        else if (c === "(" && state === '"' && tok.endsWith("$") && tok.length > dq && escaped !== tok.length) {
          const body = sub();
          tok += `(${body})`;
          subs.push(body);
        } else tok += c;
        continue;
      }
      if (state === "\\") {
        if (c === "") refuse("cannot parse quoting (No escaped character)");
        // a backslash-newline outside single quotes joins the lines
        if (c === "\n") {
          state = esc;
          continue;
        }
        // inside double quotes only the quote and the backslash itself are escaped
        if (esc === '"' && c !== "\\" && c !== esc) tok += "\\";
        tok += c;
        if (esc === '"') escaped = tok.length;
        state = esc;
        continue;
      }
      if (c === "") break;
      if (SPACE.includes(c)) {
        state = " ";
        if (c === "\n") back.push(c);
        if (tok || quoted) break;
        continue;
      }
      if (state === "c") {
        if (PUNCT.includes(c)) {
          tok += c;
          continue;
        }
        back.push(c);
        break;
      }
      if (c === "'" || c === '"') [state, dq] = [c, tok.length];
      else if (c === "\\") [esc, state] = ["a", "\\"];
      else if (!PUNCT.includes(c)) tok += c;
      else {
        back.push(c);
        state = " ";
        if (tok || quoted) break;
      }
    }
    if (!tok && !quoted) return out;
    out.push(subs.length ? { t: tok, op, subs } : { t: tok, op });
  }
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "|&", "(", ")", ";;"]);
// Longest first. A run such as ");" is two operators, not a word: read as one, `(ls); git commit`
// would be a single command named ls.
const OPS = ["<<<", "&>>", ";;", "&&", "||", "|&", ">>", "<<", ">&", "<&", "<>", ">|", "&>", ";", "&", "|", "(", ")", "<", ">"];

function splitOps(run: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < run.length;) {
    const op = OPS.find((o) => run.startsWith(o, i)) as string;
    out.push(op);
    i += op.length;
  }
  return out;
}

interface Simple {
  words: string[];
  writes: string[];
  reads: string[];
  // what the command reads on stdin that the guard can see: a here-string, a heredoc's body
  stdin?: string[];
  // whether its stdin is the pipe from the command before it
  piped?: boolean;
  // whether a <, <<, <<< or <> on fd 0 replaces that pipe as its stdin
  redirected0?: boolean;
  // what echo and printf earlier in the line print, which a pipe may carry to it
  upstream?: string[];
  // the groups, loops, ifs and subshells it is inside, outermost first, each by its own number; 0 is the line
  scope?: number[];
  // the scopes a ;, &&, || or & closed a pipeline in just before it: what was printed in such a scope before
  // it reaches no pipe after it (CodeRabbit on #124: `echo 'a " b'; echo true | at now`, and the same in a { })
  cuts?: number[];
}

// Simple commands with the files their redirects write. `2>` arrives as "2" then ">", and the
// bare fd is not a word. `>&1` duplicates a descriptor and writes no file. What runs inside a $( ... ),
// a <( ... ) or a >( ... ), quoted or not, is a simple command of its own, and the word it stood for
// stays in the command around it as `$(`, `<(` or `>(`.
function simpleCommands(toks: Tok[], bodies: string[] = []): Simple[] {
  const flat = toks.flatMap((k) => (k.op ? splitOps(k.t).map((t) => ({ t, op: true })) : [k]));
  const out: Simple[] = [];
  let cur: string[] = [];
  let writes: string[] = [];
  let reads: string[] = [];
  let stdin: string[] = [];
  // fd 0's input: the last <, <<, <<< or <> on it is the one the command reads
  let in0: string | null = null;
  let redirected0 = false;
  let piped = false;
  // open groups, compound commands ({ }, if/while/until/for/case/select) and subshells, for `cuts`
  const scope: number[] = [0];
  let scopes = 0;
  let cuts: number[] = [];
  let substitutions = 0;
  const outer: ({ cur: string[]; writes: string[]; reads: string[]; stdin: string[]; in0: string | null; redirected0: boolean } | null)[] = [];
  const flush = () => {
    if (in0 !== null) stdin.push(in0);
    if (cur.length || writes.length || reads.length || stdin.length) {
      out.push({ words: cur, writes, reads, stdin, piped, redirected0, scope: [...scope], cuts });
      cuts = [];
    }
    [cur, writes, reads, stdin, in0, piped, redirected0] = [[], [], [], [], null, false, false];
  };
  // what runs inside a substitution in a word: a quoted "$(...)" here, a backtick is refused
  const inner = (k: Tok | undefined) => {
    for (const body of k?.subs ?? []) if (!/^\(.*\)$/s.test(body)) out.push(...simpleCommands(tokenize(body), bodies)); // $((...)) is arithmetic
    if (k && !k.op && k.t.includes("`")) refuse("backtick command substitution");
  };
  const open = () => {
    substitutions++;
    outer.push({ cur, writes, reads, stdin, in0, redirected0 });
    [cur, writes, reads, stdin, in0, redirected0] = [[], [], [], [], null, false];
  };
  for (let i = 0; i < flat.length; i++) {
    const { t, op, subs } = flat[i] as Tok;
    const paren = flat[i + 1]?.op === true && flat[i + 1]?.t === "(";
    inner(flat[i]);
    if (op && (t === "<" || t === ">") && paren) {
      cur.push(`${t}(`);
      i++;
      open();
    } else if (op && t === "(") {
      flush();
      outer.push(null); // a subshell
      scope.push(++scopes);
    } else if (op && t === ")") {
      flush();
      const o = outer.pop();
      if (o) {
        ({ cur, writes, reads, stdin, in0, redirected0 } = o);
        substitutions--;
      } else if (o === null && scope.length > 1) scope.pop();
    } else if (op ? SEPARATORS.has(t) : t === "{" || t === "}") {
      flush();
      if (!op && t === "{") scope.push(++scopes);
      else if (!op && scope.length > 1) scope.pop();
      piped = t === "|" || t === "|&";
      // in a substitution the cut is not tracked, and what was printed stays (over-checks)
      if (!piped && op && substitutions === 0) cuts.push(scope[scope.length - 1] as number);
    } else if (op) {
      // the target is a word too, and a substitution in it runs: `echo x > "$(gh ...)"` (Marie on #124)
      const next = flat[i + 1];
      inner(next);
      const target = next?.t ?? "";
      const fd = cur.length && /^\d$/.test(cur[cur.length - 1] as string) ? (cur.pop() as string) : null;
      if (t.includes(">") && !(t === ">&" && /^(\d+|-)$/.test(target))) writes.push(target);
      if (t === "<" || t === "<>") reads.push(target);
      const input = t === "<<<" ? target : t === "<<" && /^HEREDOC\d+$/.test(target) ? (bodies[Number(target.slice(7))] ?? "") : null;
      // on fd 0 a later input replaces an earlier one, and a file (in reads) leaves no text; on another
      // fd a text is kept, which over-checks (CodeRabbit on #124: `bash <<'A' <<'B'` runs only B)
      const onZero = (fd ?? "0") === "0";
      if (onZero && (input !== null || t === "<" || t === "<>")) [in0, redirected0] = [input, true];
      else if (input !== null) stdin.push(input);
      i++;
    } else if (t.endsWith("$") && paren) {
      // `$(` or `X=$(`: what is inside is its own simple command, and a `$(` word stands for its output
      cur.push(t === "$" ? "$(" : t);
      i++;
      open();
    } else {
      if (!cur.length && /^(if|while|until|for|case|select)$/.test(t)) scope.push(++scopes);
      if (!cur.length && /^(fi|done|esac)$/.test(t) && scope.length > 1) scope.pop();
      cur.push(t);
    }
  }
  flush();
  return out;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "!", "time", "{", "}"]);
const REFUSED_WRAPPERS = new Set(["sudo", "doas", "exec", "eval", "source", ".", "xargs", "parallel", "watch", "caffeinate", "script"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"]);

function checkEnvName(n: string) {
  if (n.startsWith("GIT_") || ["PATH", "HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(n))
    refuse(`environment override ${n} is not allowed`);
}

// `export PATH=…` overrides the environment as surely as the `PATH=…` prefix does. Sanchez's tests
// ran through the export form on 2026-10-26 while Nomura's prefix form was refused. The other
// builtins that assign change PATH, HOME and GIT_* just the same, since those are already exported.
const ASSIGNERS = new Set(["export", "declare", "typeset", "readonly", "local"]);
function checkExport(words: string[]) {
  const [w, ...args] = words;
  if (!ASSIGNERS.has(w as string)) return;
  for (const a of args) if (/^[A-Za-z_]\w*=/.test(a)) checkEnvName(a.split("=", 1)[0] as string);
}

// The index of a wrapper's command: past its options, and the next word too for those in `vals`
// (`nice -n 5`; an attached value, `-n5` or `--adjustment=5`, is one word).
function pastOptions(words: string[], vals: string[]): number {
  let j = 1;
  for (; j < words.length && (words[j] as string).startsWith("-") && words[j] !== "-"; j++) {
    if (words[j] === "--") return j + 1;
    if (vals.includes(words[j] as string)) j++;
  }
  return j;
}

// Drop shell keywords, env assignments and wrappers so the real command name is first. A wrapper
// whose command cannot be read off the line is refused; timeout's, nice's, setsid's, stdbuf's,
// flock's and env -S's can, so theirs is checked.
const GIT_COMMAND_CONFIG = new RegExp("^(core\\.(pager|sshcommand|editor|askpass|gitproxy)|sequence\\.editor|pager\\.[^=]+|diff\\.external|" +
  "(diff|difftool|mergetool|man|browser)\\.[^=]+\\.(textconv|command|cmd)|merge\\.[^=]+\\.driver|filter\\.[^=]+\\.(clean|smudge|process)|" +
  "credential(\\.[^=]+)?\\.helper|gpg(\\.[^=]+)?\\.program|remote\\.[^=]+\\.(uploadpack|receivepack)|uploadpack\\.packobjectshook|" +
  "sendemail\\.[^=]*cmd|web\\.browser|instaweb\\.httpd)=");

function stripPrefixes(words: string[]): string[] {
  if (["for", "select", "case", "function"].includes(words[0] ?? "")) return [];
  while (words.length && KEYWORDS.has(words[0] as string)) words = words.slice(1);
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0] as string)) {
    checkEnvName((words[0] as string).split("=", 1)[0] as string);
    words = words.slice(1);
  }
  for (;;) {
    const w = words[0];
    if (w === undefined) return words;
    if (w.startsWith("\\")) words = [w.slice(1), ...words.slice(1)];
    else if (["command", "nohup", "builtin"].includes(w)) words = words.slice(1);
    else if (w === "env") {
      let j = 1;
      let split: string | undefined;
      for (; j < words.length && ((words[j] as string).startsWith("-") || (words[j] as string).includes("=")); j++) {
        const a = words[j] as string;
        if (a === "--") continue;
        if (a.startsWith("--")) {
          const [opt, value] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
          const takes = ["--unset", "--chdir", "--split-string"].includes(opt);
          const v = takes && value === undefined ? (words[++j] ?? "") : value;
          if (opt === "--split-string") split = v;
        } else if (a.startsWith("-")) {
          // a cluster of short options, -iv0; -u, -C and -S take the rest of it or the next word
          const k = [...a.slice(1)].findIndex((c) => "uCS".includes(c));
          if (k >= 0) {
            const v = a.length > k + 2 ? a.slice(k + 2) : (words[++j] ?? "");
            if (a[k + 1] === "S") split = v;
          }
        } else checkEnvName(a.split("=", 1)[0] as string);
        if (split !== undefined) break;
      }
      // env -S "gh pr merge 1": the string is split into the command's words
      words = split === undefined ? words.slice(j) : ["env", ...tokenize(split).filter((k) => !k.op).map((k) => k.t), ...words.slice(j + 1)];
    } else if (w === "nice") words = words.slice(pastOptions(words, ["-n", "--adjustment"]));
    else if (w === "setsid") words = words.slice(pastOptions(words, []));
    else if (w === "stdbuf") words = words.slice(pastOptions(words, ["-i", "-o", "-e", "--input", "--output", "--error"]));
    else if (w === "flock") {
      // flock [options] <lock file> <command>, or <lock file> -c '<command line>'
      const j = pastOptions(words, ["-w", "--timeout", "-E", "--conflict-exit-code"]) + 1;
      const c = words[j];
      words = c === "-c" || c === "--command" ? ["sh", "-c", words[j + 1] ?? ""] : words.slice(j);
    } else if (w === "timeout") {
      let j = 1;
      for (; j < words.length && (words[j] as string).startsWith("-"); j++) if (["-s", "-k", "--signal", "--kill-after"].includes(words[j] as string)) j++;
      words = words.slice(j + 1);
    } else if (REFUSED_WRAPPERS.has(w)) refuse(`'${w}' is not allowed in this session`);
    else {
      checkExport(words);
      return words;
    }
  }
}

const LOCAL_BIN = ["vendor/bin/", "./vendor/bin/", "node_modules/.bin/"];

function cmdName(words: string[]): [string, string[]] {
  const w = words[0] as string;
  if (!w.includes("/")) return [w.toLowerCase(), words];
  const local = LOCAL_BIN.some((p) => w.startsWith(p));
  if (!TRUSTED_BIN_DIRS.has(posix.dirname(w)) && !local) refuse(`executable by path '${w}' is not allowed`);
  const b = posix.basename(w);
  return local ? [b.toLowerCase(), words] : [b.toLowerCase(), [b, ...words.slice(1)]];
}

// os.path.normpath: no trailing slash.
function normpath(p: string): string {
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

function writable(p: string, ctx: GuardContext): boolean {
  if (!p || p.startsWith("-")) return true; // flags are not paths
  if (p.startsWith("$") || p.startsWith("~")) return false;
  if (p.split("/").includes("..")) return false;
  const n = normpath(p);
  if (TMP_ROOTS.some((r) => n.startsWith(r + "/")) || ["/dev/null", "/dev/stdout", "/dev/stderr"].includes(n)) return true;
  return ctx.writeDirs.some((d) => n.startsWith(d.replace(/\/+$/, "") + "/"));
}

const flagsOf = (args: string[]) => args.filter((a) => a.startsWith("-"));
const posOf = (args: string[]) => args.filter((a) => !a.startsWith("-"));

// ---------------------------------------------------------------- git

const GIT_BARE_FLAGS = new Set(["--no-pager", "-p", "--paginate", "--no-replace-objects", "--bare", "--literal-pathspecs",
  "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks"]);

// --exec-path with no value prints the path; with =value it relocates git and is refused
const GIT_INFO_FLAGS = new Set(["--version", "--exec-path", "--html-path", "--man-path", "--info-path"]);

// The subcommand and its arguments after global options. Blocks alias definitions and relocation.
function gitParts(words: string[], ctx: GuardContext): [string, string[]] {
  for (let i = 1; i < words.length;) {
    const w = words[i] as string;
    if (GIT_BARE_FLAGS.has(w)) {
      i++;
      continue;
    }
    // options git answers and exits on, reading nothing after them: --help is `git help` with the rest
    if (w === "--help") return ["help", words.slice(i + 1)];
    if (GIT_INFO_FLAGS.has(w)) return ["version", []];
    if (["--git-dir", "--work-tree", "--namespace", "--exec-path"].some((p) => w.startsWith(p))) refuse("git --git-dir/--work-tree is not allowed");
    if (w === "-C") {
      i += 2;
      continue;
    }
    if (w.startsWith("-C")) {
      i++;
      continue;
    }
    if (w.startsWith("-c")) {
      const val = w === "-c" ? (words[i + 1] ?? "") : w.slice(2);
      const low = val.toLowerCase();
      const pager = low.startsWith("core.pager") && ctx.policy === "readonly" && val.includes("=") && !["=cat", "=less", "="].some((e) => val.endsWith(e));
      if (low.startsWith("alias.") || low.startsWith("core.hookspath") || low.startsWith("core.fsmonitor") || pager) refuse(`git -c ${val} is not allowed`);
      // a setting whose value git runs as a command is checked as that command (#124, round 9)
      if (GIT_COMMAND_CONFIG.test(low) && val.includes("=")) checkCommand(val.slice(val.indexOf("=") + 1).replace(/^!/, ""), ctx);
      i += w === "-c" ? 2 : 1;
      continue;
    }
    if (w.startsWith("-")) refuse(`unknown git global option ${w}`);
    return [w, words.slice(i + 1)];
  }
  return ["", []];
}

const READONLY_GIT = new Set(["log", "show", "diff", "status", "rev-parse", "cherry", "blame", "ls-files", "ls-tree", "ls-remote", "grep",
  "cat-file", "merge-base", "rev-list", "describe", "name-rev", "shortlog", "whatchanged", "diff-tree",
  "diff-index", "diff-files", "count-objects", "for-each-ref", "show-ref", "var", "version", "--version", "help",
  "range-diff", "check-ignore", "check-attr", "show-branch", "annotate", "verify-commit", "fsck"]);

function checkGitReadonly(words: string[], ctx: GuardContext): void {
  const [sub, args] = gitParts(words, ctx);
  const flags = flagsOf(args);
  const pos = posOf(args);
  if (READONLY_GIT.has(sub)) return;
  switch (sub) {
    case "fetch":
      for (const a of pos)
        if (a.includes(":") && !(a.split(":", 2)[1] as string).startsWith("refs/remotes/")) refuse("git fetch with a refspec that updates a local branch is not allowed");
      return;
    case "reflog":
      if (pos.length && pos[0] !== "show") refuse("git reflog may only show");
      return;
    case "remote":
      if (!pos.length || ["show", "get-url"].includes(pos[0] as string) || (flags.length === 1 && flags[0] === "-v")) return;
      return refuse("git remote may only list or show");
    case "config":
      if (flags.some((f) => ["--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e", "--file", "-f", "--rename-section", "--remove-section"].includes(f)))
        refuse("git config may only read");
      if (pos.length >= 2) refuse("git config may only read (a value was given)");
      return;
    case "branch": {
      const bad = new Set(["-f", "--force", "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "--set-upstream-to", "-u", "--unset-upstream", "--edit-description"]);
      if (flags.some((f) => bad.has(f.split("=")[0] as string))) refuse("git branch may only list");
      const listing = flags.some((f) => ["-l", "--list", "-a", "-r", "-v", "-vv", "--contains", "--merged", "--no-merged", "--points-at"].includes(f) ||
        ["--format", "--sort", "--contains=", "--merged=", "--no-merged="].some((p) => f.startsWith(p)));
      if (pos.length && !listing) refuse("git branch <name> creates a branch; use --list");
      return;
    }
    case "tag":
      if (pos.length && !flags.some((f) => ["-l", "--list", "-n", "--contains", "--points-at"].includes(f) || f.startsWith("-n"))) refuse("git tag <name> creates a tag; use -l");
      if (flags.some((f) => ["-d", "--delete", "-f", "--force", "-a", "-s", "-m"].includes(f))) refuse("git tag may only list");
      return;
    case "stash":
      if (!pos.length || ["list", "show"].includes(pos[0] as string)) return;
      return refuse("git stash may only list or show");
    case "worktree":
      if (pos[0] === "list") return;
      return refuse("git worktree may only list");
    case "symbolic-ref":
      if (pos.length <= 1 && !flags.some((f) => f === "-d" || f === "--delete")) return;
      return refuse("git symbolic-ref may only read");
  }
  refuse(`git ${sub || "(no subcommand)"} is not read-only`);
}

function protectedRef(a: string): boolean {
  a = a.replace(/^\+/, "");
  const dst = a.includes(":") ? (a.split(":", 2)[1] as string) : a;
  if (dst === "" && a.includes(":")) return true;
  return PROTECTED.has(dst.replace(/^refs\/heads\//, "").toLowerCase());
}

function checkGitProtect(words: string[], ctx: GuardContext): void {
  const [sub, args] = gitParts(words, ctx);
  const flags = flagsOf(args);
  const pos = posOf(args);
  const isProtected = (p: string) => PROTECTED.has(p.toLowerCase());
  if (sub === "push") {
    // a ref the guard cannot read could be main (Niilo on #124: `git push origin "$B"`)
    if (pos.some((p) => /[$`]/.test(p)))
      refuse("a push whose remote or branch comes from a variable or a substitution cannot be checked: name the branch, git push -u origin <branch>");
    if (!pos.length || (pos.length === 1 && pos[0] === "origin") || ["--all", "--mirror", "--prune", "--tags"].some((f) => flags.includes(f)))
      refuse("push exactly one branch by name: git push -u origin <branch>");
    for (const f of flags) {
      if (f === "-d" || f === "--delete") refuse("deleting a remote branch is not allowed");
      if (f.startsWith("--force-with-lease=") || f.startsWith("--force-if-includes=")) refuse("--force-with-lease takes no value here; use bare --force-with-lease");
      if (f === "--force" || f === "-f" || (/^-[a-zA-Z]+$/.test(f) && f.slice(1).includes("f"))) refuse("force pushes need --force-with-lease, never --force or -f");
    }
    for (const a of pos[0] === "origin" ? pos.slice(1) : pos) {
      if (a.startsWith("+")) refuse("a + refspec is a force push; use --force-with-lease");
      // `:branch` is a delete: an empty source pushes nothing over the destination.
      if (a.startsWith(":") || (a.includes(":") && a.split(":", 2)[1] === "")) refuse("deleting a remote branch is not allowed");
      // By URL only: the guard cannot see which repo a remote called origin is. `:main` deletes, so never.
      const ownRepo = ctx.ownRepos.some((r) => pos[0] === `https://github.com/${r}` || pos[0] === `https://github.com/${r}.git`);
      if (protectedRef(a) && (!ownRepo || a.startsWith(":"))) refuse(`pushing to a protected branch (${a}) is not allowed`);
    }
    return;
  }
  if (sub === "checkout" || sub === "switch") {
    if (flags.some((f) => ["-b", "-B", "-c", "-C", "--orphan", "--detach"].includes(f)) || args.includes("--")) return;
    if (pos.length && isProtected(pos[0] as string)) refuse(`checking out ${pos[0]} in a shared clone is not allowed`);
    return;
  }
  if (sub === "branch") {
    if (flags.some((f) => ["-f", "--force", "-m", "-M", "--move", "-d", "-D", "--delete"].includes(f)) && pos.some(isProtected))
      refuse("moving, forcing or deleting a protected branch is not allowed");
    return;
  }
  if ((sub === "update-ref" || sub === "symbolic-ref") && pos.some((p) => isProtected(p.replace(/^refs\/heads\//, ""))))
    refuse("rewriting a protected ref is not allowed");
}

// ---------------------------------------------------------------- gh

const READ_FIELDS = new Set(["per_page", "page", "state", "sort", "direction", "since", "q", "head", "base"]);

// True when a `gh api` call would write: a non-GET method, or fields or input other than paging.
function ghApiWrites(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-X" || a === "--method") {
      if (i + 1 < args.length && (args[i + 1] as string).toUpperCase() !== "GET") return true;
    } else if (a.startsWith("-X") && a.length > 2 && a.slice(2).toUpperCase() !== "GET") {
      return true;
    } else if (a.startsWith("--method=") && (a.split("=", 2)[1] as string).toUpperCase() !== "GET") {
      return true;
    } else if (a === "--input" || a.startsWith("--input=")) {
      return true;
    } else if (["-f", "-F", "--field", "--raw-field"].includes(a) || /^-(f|F)[^ ]/.test(a) || a.startsWith("--field=") || a.startsWith("--raw-field=")) {
      const val = a.startsWith("--") && a.includes("=") ? a.slice(a.indexOf("=") + 1)
        : a.length > 2 && !a.startsWith("--") ? a.slice(2)
          : (args[i + 1] ?? "");
      const key = val.split("=", 1)[0] as string;
      if (READ_FIELDS.has(key)) continue;
      if (key === "query" && !val.toLowerCase().includes("mutation")) continue; // a graphql read
      return true;
    }
  }
  return false;
}

const GH_READ = new Set(["pr view", "pr diff", "pr list", "pr checks", "pr status", "issue view", "issue list", "repo view", "run list",
  "run view", "release list", "release view", "label list", "workflow list", "workflow view", "auth status"]);
const GH_READ_ANY = new Set(["search", "status", "browse"]);

function checkGhReadonly(words: string[]): void {
  const args = words.slice(1);
  if (!args.length) return;
  if (args[0] === "api") {
    if (ghApiWrites(args.slice(1))) refuse("gh api may only read (GET, no fields except paging or a graphql query)");
    return;
  }
  const second = args[1] !== undefined && !args[1].startsWith("-") ? args[1] : undefined;
  if ((second !== undefined && GH_READ.has(`${args[0]} ${second}`)) || GH_READ_ANY.has(args[0] as string)) return;
  refuse(`gh ${args.slice(0, 2).join(" ")} is not read-only`);
}

const API_DELETE_BRANCH = /^(-X|--method)\s*=?\s*DELETE repos\/([\w.-]+)\/([\w.-]+)\/git\/refs\/heads\/([\w./-]+)$/;
const API_RENAME_TO_MAIN = /^(-X|--method)\s*=?\s*POST repos\/([\w.-]+\/[\w.-]+)\/branches\/[\w./-]+\/rename -f new_name=main$/;

// Merged means GitHub's compare of the default branch with the branch finds nothing ahead: every
// commit on the branch is already in the default branch, so deleting it loses nothing. A squash
// merge leaves the branch ahead and reads as unmerged. Any failure reads as unmerged.
// The GitHub lookups one verdict makes share one budget, well inside the hook's 10 s timeout:
// Claude Code lets a call through when its hook times out, so a stalled GitHub must end the lookups
// with time left for the guard to refuse (CodeRabbit on #127). A lookup past the budget has failed.
export const GITHUB_BUDGET_MS = 6_000;
let githubDeadline = 0;
const startLookups = () => {
  githubDeadline = Date.now() + GITHUB_BUDGET_MS;
};
function ghLookup(args: string[]): string | null {
  const left = githubDeadline - Date.now();
  if (left < 250) return null;
  const r = run("gh", args, { timeout: left, killSignal: "SIGKILL" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function mergedOnGitHub(repo: string, branch: string): boolean {
  const base = ghLookup(["api", `repos/${repo}`, "--jq", ".default_branch"]);
  return base !== null && ghLookup(["api", `repos/${repo}/compare/${base}...${branch}`, "--jq", ".ahead_by"]) === "0";
}

function defaultBranchOnGitHub(repo: string): string | null {
  return ghLookup(["api", `repos/${repo}`, "--jq", ".default_branch"]);
}

// A write to a branch of a product repo: refused on a protected name, and on the repo's own default
// branch, which may be trunk or nextjs (CodeRabbit on #124). When the default cannot be read, refused.
function checkBranchWrite(repo: string, branch: string, ctx: GuardContext, why: string): void {
  // no branch is the default branch: create_or_update_file and delete_file commit there without one
  if (!branch || protectedRef(branch)) refuse(why);
  const d = (ctx.defaultBranch ?? defaultBranchOnGitHub)(repo);
  if (d === null) return refuse(`the default branch of ${repo} cannot be read, so a write to ${branch} cannot be checked`);
  if (d.toLowerCase() === branch.replace(/^\+/, "").replace(/^refs\/heads\//, "").toLowerCase()) refuse(why);
}

// Updating a PR's branch merges or rebases its base into its head, a write to the head branch: on a
// product repo it follows the rule for any branch write, so a PR whose head is the default branch or
// a protected one is refused, as is one whose head cannot be read (CodeRabbit on #127).
function checkPrHeadWrite(repo: string, n: string, ctx: GuardContext): void {
  if (ctx.ownRepos.some((r) => r.toLowerCase() === repo.toLowerCase())) return;
  if (!/^\d+$/.test(n)) refuse(`updating a branch of ${repo} needs the PR's number, so the guard can read its head`);
  const head = (ctx.prHead ?? prHeadOnGitHub)(repo, n);
  if (head === null) refuse(`the head of ${repo}#${n} cannot be read, so updating its branch cannot be checked`);
  const [headRepo, ref] = head as [string, string];
  if (ctx.ownRepos.some((r) => r.toLowerCase() === headRepo.toLowerCase())) return;
  checkBranchWrite(headRepo, ref, ctx, `${repo}#${n}'s head is ${headRepo}:${ref}, and updating it writes to that branch`);
}
function prHeadOnGitHub(repo: string, n: string): [string, string] | null {
  const out = ghLookup(["api", `repos/${repo}/pulls/${n}`, "--jq", '.head.repo.full_name + " " + .head.ref']);
  const m = out === null ? null : /^(\S+\/\S+) (\S+)$/.exec(out);
  return m ? [m[1] as string, m[2] as string] : null;
}

// The owner/repo a `gh pr <merge|close|...>` targets, from --repo/-R or a PR URL. null when the
// command relies on the cwd's remote, which the guard cannot resolve -- the caller then fails safe.
function ghPrRepo(args: string[]): string | null {
  const slug = /^[\w.-]+\/[\w.-]+$/;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--repo" || a === "-R") { const v = args[i + 1]; return v !== undefined && slug.test(v) ? v : null; }
    if (a.startsWith("--repo=")) { const v = a.slice(7); return slug.test(v) ? v : null; }
    if (a.startsWith("-R") && a.length > 2) { const v = a.slice(2); return slug.test(v) ? v : null; }
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/\d+/.exec(a);
    if (m) return m[1] as string;
  }
  return null;
}

// The PR number a `gh pr close` names, by a number or a PR URL of the repo it targets. null for a
// branch name, a second selector, a flag the guard does not know, or a URL and --repo that disagree.
function ghCloseNumber(args: string[], repo: string): number | null {
  const sel: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i] as string;
    if (["--repo", "-R", "--comment", "-c", "--reason", "-r", "--duplicate-of"].includes(a)) i++;
    else if (/^--(repo|comment|reason|duplicate-of)=/.test(a) || /^-[Rcr]./.test(a)) continue;
    else if (a.startsWith("-")) return null; // --delete-branch among them: a product branch is not the lead's to delete
    else sel.push(a);
  }
  if (sel.length !== 1) return null;
  const s = sel[0] as string;
  if (/^[1-9]\d*$/.test(s)) return Number(s);
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/([1-9]\d*)(\/.*)?$/.exec(s);
  return m && (m[1] as string).toLowerCase() === repo.toLowerCase() ? Number(m[2]) : null;
}

// The allow-close list of the workspace this session works in: --workspace, then FACTORY_WORKSPACE,
// then the nearest factory.toml above the session's project directory or the cwd. Read only when a
// product PR is closed; undefined when there is no workspace or its config does not load.
function workspaceAllowClose(flag: string | undefined): string | undefined {
  try {
    return allowClosePath(openWorkspace(resolveWorkspace({ flag, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() })).stateDir);
  } catch {
    return undefined;
  }
}

// The flags `gh pr merge` takes on a lead_merges repo, and whether each takes a value. Anything else is
// refused: --admin above all, which would merge past the repo's required checks and reviews.
const LEAD_MERGE_FLAGS: Record<string, boolean> = {
  "--repo": true, "-R": true, "--match-head-commit": true, "--squash": false, "-s": false, "--merge": false, "-m": false,
  "--rebase": false, "-r": false, "--delete-branch": false, "-d": false, "--auto": false, "--subject": true, "-t": true,
  "--body": true, "-b": true, "--body-file": true, "-F": true,
};
const HOW_TO_MERGE = "the lead merges a lead_merges PR as `gh pr merge <n> -R owner/repo --match-head-commit <40-hex sha> [--squash|--merge|--rebase]`";

// Refuses a `gh pr merge` by the lead on a lead_merges repo unless it names an explicit -R, one PR by
// number, and the exact head it was reviewed at, so a push after the review cannot ride along.
function checkLeadMerge(args: string[]): void {
  let repoFlag = false;
  let head: string | undefined;
  const sel: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i] as string;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : /^-[A-Za-z]./.test(a) ? a.slice(0, 2) : a;
    if (!a.startsWith("-")) { sel.push(a); continue; }
    if (!(name in LEAD_MERGE_FLAGS)) refuse(`${name} is not allowed when the lead merges a product PR; ${HOW_TO_MERGE}`);
    let value: string | undefined;
    if (LEAD_MERGE_FLAGS[name]) value = eq > 0 ? a.slice(eq + 1) : name !== a ? a.slice(2) : args[++i];
    if (name === "--repo" || name === "-R") repoFlag = true;
    if (name === "--match-head-commit") head = value;
  }
  if (!repoFlag) refuse(`merging a product PR needs an explicit -R owner/repo; ${HOW_TO_MERGE}`);
  if (sel.length !== 1 || !/^[1-9]\d*$/.test(sel[0] as string)) refuse(`merging a product PR needs exactly one PR number; ${HOW_TO_MERGE}`);
  if (head === undefined || !/^[0-9a-f]{40}$/i.test(head)) refuse(`merging a product PR needs --match-head-commit with the full 40-character head sha it was reviewed at; ${HOW_TO_MERGE}`);
}

const HOW_TO_CLOSE = "a product PR closes only once the human has named that exact PR and the lead has recorded it with " +
  "`factory allow-close <repo-key> <n> --words \"<the human's words>\"`";

// The comment rule (superfactory#119). A comment the factory's sessions post goes out under the
// human's token login, so the review watcher tells it from the human's own by the marker it starts
// with. A comment write passes only when its body is in the command and starts with the marker, or
// is a bot trigger; a body from a file, a $(...) or a variable cannot be checked here.
const COMMENT_HINT = `start the body with "${MARKER}" (or post it with \`factory pr-comment\`), in the command itself, not from a file or $(...)`;
const markedBody = (b: string) => b.trimStart().startsWith(MARKER) || /^@coderabbitai\b/.test(b.trimStart());

// gh's command path as cobra finds it. Flags may come before each command word, and pr's and issue's
// persistent -R/--repo takes the next word (gh -R o/r pr comment 1, gh pr --repo o/r close 2). The
// words come back with the path first and every other word after it in its order, so a parser of
// the command's flags still sees the repo (Marie on #119, after round 4). api's path is one word.
const GH_PATH_VALUES = new Set(["-R", "--repo"]);
export function ghPath(args: string[]): string[] {
  const path: string[] = [];
  const rest: string[] = [];
  let i = 0;
  for (; i < args.length && path.length < (path[0] === "api" ? 1 : 2); i++) {
    const a = args[i] as string;
    if (a === "--") break;
    if (a.startsWith("-") && a !== "-") {
      rest.push(a);
      if (GH_PATH_VALUES.has(a) && i + 1 < args.length) rest.push(args[++i] as string);
    } else path.push(a);
  }
  return [...path, ...rest, ...args.slice(i)];
}

// gh's own top-level commands, from gh 2.97's `gh help`, with their cobra aliases (cs, ext, rs...).
// Any other first word is a user alias, a shell alias or an extension, and could run anything, so
// it is refused. gh lets no alias shadow a built-in, so this needs no read of gh's config. Making
// an alias or getting an extension is refused outright (Marie and Niilo, the -R/alias hotfix).
const GH_BUILTINS = new Set(["agent-task", "agent-tasks", "agent", "agents", "alias", "api", "attestation", "at", "auth", "browse",
  "cache", "codespace", "cs", "completion", "config", "copilot", "discussion", "extension", "extensions", "ext", "gist", "gpg-key",
  "help", "issue", "label", "licenses", "org", "pr", "preview", "project", "release", "repo", "ruleset", "rs", "run", "search",
  "secret", "skill", "skills", "ssh-key", "status", "variable", "workflow"]);
const GH_ALIAS_HINT = "gh aliases and extensions can't be checked: run the full gh command";
export function checkGhCommand(args: string[]): void {
  const [c, sub] = args;
  // no command word: only flags (gh --version, gh --help) pass; anything after a `--` could be an alias
  if (c === undefined || (c.startsWith("-") && args.every((a) => a.startsWith("-") && a !== "--"))) return;
  if (!GH_BUILTINS.has(c)) refuse(`gh ${c}: ${GH_ALIAS_HINT}`);
  if (c === "alias" && ["set", "import", "delete"].includes(sub ?? "")) refuse(`gh alias ${sub}: ${GH_ALIAS_HINT}`);
  if (["extension", "extensions", "ext"].includes(c) && ["install", "upgrade", "exec"].includes(sub ?? ""))
    refuse(`gh ${c} ${sub}: ${GH_ALIAS_HINT}`);
}

// A `gh api` call read as gh reads it: its method, endpoint and fields. With no -X, a field or
// --input makes it a POST.
const API_VALUES = new Set(["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "-q", "--jq", "-t", "--template",
  "--hostname", "--cache", "-p", "--preview", "--input"]);
interface ApiCall { method: string; endpoint: string; fields: { key: string; value: string }[]; input: boolean }
function apiCall(args: string[]): ApiCall {
  let method: string | undefined;
  let endpoint: string | undefined;
  let input = false;
  const fields: { key: string; value: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : /^-[A-Za-z]./.test(a) && API_VALUES.has(a.slice(0, 2)) ? a.slice(0, 2) : a;
    if (!a.startsWith("-") || a === "-") {
      endpoint ??= a;
      continue;
    }
    if (!API_VALUES.has(flag)) continue;
    const value = eq > 0 ? a.slice(eq + 1) : flag !== a ? a.slice(2) : (args[++i] ?? "");
    if (flag === "-X" || flag === "--method") method = value.toUpperCase();
    else if (flag === "--input") input = true;
    else if (["-f", "-F", "--field", "--raw-field"].includes(flag)) {
      const k = value.indexOf("=");
      fields.push({ key: k < 0 ? value : value.slice(0, k), value: k < 0 ? "" : value.slice(k + 1) });
    }
  }
  return { method: method ?? (fields.length || input ? "POST" : "GET"), endpoint: endpoint ?? "", fields, input };
}

// What a `gh api` write does to a PR, an issue or a repo (Marie on #124). On a repo that is not the
// factory's own, setting a PR's or issue's state closes it, a lock is a lock, and a write to the repo
// itself (DELETE, PATCH) is the human's. A GraphQL mutation that merges, closes, locks or deletes is
// refused wherever it points, and one the guard cannot read is refused. A merge of one branch into
// another, a transfer, and a contents write to the default branch or a protected one land on main
// as surely as a push does; a contents write names its branch, as create_or_update_file does over MCP.
// createCommitOnBranch's branch cannot be read reliably, and git push is how a builder commits.
const API_REPO_WRITE = /^repos\/([^/\s?]+)\/([^/\s?]+)\/(merges|transfer|contents)(?:[/?]|$)/i;
const API_TARGET = /^repos\/([^/\s?]+)\/([^/\s?]+)(?:\/(pulls|issues)\/(\d+)(\/lock)?)?\/?(?:\?.*)?$/;
const GQL_REFUSED = /\b(mergePullRequest|closePullRequest|reopenPullRequest|enablePullRequestAutoMerge|lockLockable|unlockLockable|deleteRepository|archiveRepository|mergeBranch|enqueuePullRequest|createCommitOnBranch|closeIssue|reopenIssue)\b/i;
function checkApiProtect(args: string[], ctx: GuardContext): void {
  const a = apiCall(args);
  if (a.method === "GET" || a.method === "HEAD") return;
  const ep = a.endpoint.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
  if (ep === "graphql") {
    const queries = a.fields.filter((f) => f.key === "query").map((f) => f.value);
    if (a.input || queries.some((q) => q.startsWith("@") || /\$\(|`/.test(q) || /^\s*\$\w/.test(q)))
      refuse("a GraphQL call the guard cannot read (query=@file, --input, a $(...) or a variable) is not allowed: put the query inline");
    // only a mutation writes: a query, or the {...} shorthand, may name a mutation and change nothing
    if (queries.some((q) => /\bmutation\b/.test(q) && (GQL_REFUSED.test(q) || (/\bupdate(PullRequest|Issue)\b/i.test(q) && /\bstate\b/i.test(q)))))
      refuse("merging, closing, locking or deleting through GraphQL is not allowed; use gh pr merge or gh pr close");
    return;
  }
  const own = (repo: string) => ctx.ownRepos.some((r) => r.toLowerCase() === repo.toLowerCase());
  const w = API_REPO_WRITE.exec(ep);
  if (w && !own(`${w[1]}/${w[2]}`)) {
    const repo = `${w[1]}/${w[2]}`;
    if (w[3]?.toLowerCase() === "merges") refuse(`merging a branch of ${repo} through the API is not allowed; open a PR`);
    if (w[3]?.toLowerCase() === "transfer") refuse(`transferring ${repo} is the human's call`);
    const branch = a.fields.filter((f) => f.key === "branch").map((f) => f.value);
    const why = `a contents write to ${repo} needs -f branch=<a feature branch>: without one it commits to the default branch`;
    if (a.input || branch.length !== 1 || !branch[0] || branch[0].startsWith("@") || /[$`]/.test(branch[0] as string)) refuse(why);
    // gh fills {owner}, {repo} and {branch} in a typed field from the cwd's repo and checkout, which
    // the guard cannot read: -F branch={branch} on the default branch writes there (CodeRabbit on #127)
    if (/\{(owner|repo|branch)\}/.test(branch[0] as string)) refuse(`${why}; gh fills a {placeholder} from the checkout, which the guard cannot read`);
    checkBranchWrite(repo, branch[0] as string, ctx, why);
  }
  const m = API_TARGET.exec(ep);
  if (!m) return;
  const repo = `${m[1]}/${m[2]}`;
  if (own(repo)) return;
  if (m[5]) refuse(`locking or unlocking ${repo}#${m[4]} through the API is the human's and colleagues' call`);
  if (m[4] && (a.input || a.fields.some((f) => f.key === "state")))
    refuse(`setting the state of ${repo}#${m[4]} through the API is not allowed; close it with gh pr close, and ${HOW_TO_CLOSE}`);
  if (!m[3]) refuse(`a ${a.method} of the repo ${repo} itself is the human's call`);
}

function checkGhProtect(words: string[], ctx: GuardContext): void {
  let args = ghPath(words.slice(1));
  checkGhCommand(args);
  // gh issue close, reopen, lock and unlock act on a PR given its number (gh's issue/close.go closes
  // it as a PR), and offline an issue's number cannot be told from a PR's: checked as gh pr (Marie on #124)
  if (args[0] === "issue" && ["close", "reopen", "lock", "unlock"].includes(args[1] ?? "")) args = ["pr", ...args.slice(1)];
  if (args[0] === "api") checkApiProtect(args.slice(1), ctx);
  if (args[0] === "pr" && args[1] === "update-branch") {
    const repo = ghPrRepo(args);
    if (repo === null) refuse("updating a PR's branch needs an explicit --repo owner/name (or a PR URL) so the guard can confirm whose repo it is");
    const sel = args.slice(2).filter((a, i, all) => !a.startsWith("-") && !["-R", "--repo"].includes(all[i - 1] ?? ""));
    const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(sel[0] ?? "");
    checkPrHeadWrite(repo as string, sel.length === 1 ? (url?.[1] ?? (sel[0] as string)) : "", ctx);
  }
  if (args[0] === "pr" && ["merge", "close", "reopen", "lock", "unlock"].includes(args[1] ?? "")) {
    const repo = ghPrRepo(args);
    if (repo === null) refuse("merging or closing a PR needs an explicit --repo owner/name (or a PR URL) so the guard can confirm whose repo it is");
    const target = (repo as string).toLowerCase();
    // a factory-own repo (lyyti-factory / superfactory): the lead and its assistants may merge or close it.
    if (!ctx.ownRepos.some((r) => r.toLowerCase() === target)) {
      // Mikko, 2026-11-14, asked whether the lead may merge test PRs and bug fixes again: "Yes".
      if (args[1] === "merge" && ctx.role === "lead" && (ctx.leadMerges ?? []).some((r) => r.toLowerCase() === target)) {
        checkLeadMerge(args);
        return;
      }
      if (args[1] !== "close") refuse(`${args[1]} of a PR on a product repo is the human's and colleagues' call, always`);
      const n = ghCloseNumber(args, repo as string);
      if (n === null) refuse(`closing a product PR needs its number or URL in the command, one selector and no --delete-branch, so the guard can check it; ${HOW_TO_CLOSE}`);
      if (ctx.role !== "lead") refuse(`closing a product PR is the lead's; ${HOW_TO_CLOSE}`);
      const list = ctx.allowClose ?? workspaceAllowClose(ctx.workspace);
      if (list === undefined) refuse(`the guard found no workspace, so no allow-close list, to check ${repo}#${n} against; ${HOW_TO_CLOSE}`);
      if (!closable(list as string, repo as string, n as number))
        refuse(`${repo}#${n} is not on the allow-close list; ${HOW_TO_CLOSE}`);
    }
  }
  if (args[0] === "pr" && args[1] === "ready" && !args.includes("--undo")) {
    const repo = ghPrRepo(args);
    if (repo === null) refuse("undrafting a PR needs an explicit --repo owner/name (or a PR URL) so the guard can confirm whose repo it is; otherwise undrafting is `factory pr-send`'s job");
    const target = (repo as string).toLowerCase();
    // The human, 2026-10-15: "You should be able to undraft". The lead may, on a product repo of the
    // --org; a builder or reviewer still goes through the lead.
    const lead = ctx.role === "lead" && ctx.org !== undefined && target.split("/")[0] === ctx.org.toLowerCase();
    if (!lead && !ctx.ownRepos.some((r) => r.toLowerCase() === target)) refuse("undrafting a product-repo PR is the lead's, by `factory pr-open-for-review` or `gh pr ready <n> -R owner/repo`; gh pr ready --undo is fine");
    // a factory-own repo (lyyti-factory / superfactory): the lead and its assistants may undraft it to merge it.
  }
  if (args[0] === "api" && ghApiWrites(args.slice(1)) && /(pulls\/\d+\/merge|git\/refs|branches\/\S+\/(protection|rename))/.test(args.join(" "))) {
    const rest = args.slice(1).join(" ");
    const del = API_DELETE_BRANCH.exec(rest);
    if (del && !PROTECTED.has((del[4] as string).toLowerCase())) {
      if ((del[2] as string).toLowerCase() !== ctx.org?.toLowerCase()) return;
      const repo = `${del[2]}/${del[3]}`;
      if (ctx.role === "lead" && ctx.ownRepos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
        if ((ctx.isMerged ?? mergedOnGitHub)(repo, del[4] as string)) return;
        refuse(`${del[4]} is not merged into ${repo}'s default branch, so it stays`);
      }
    }
    const rename = API_RENAME_TO_MAIN.exec(rest);
    if (rename && ctx.ownRepos.includes(rename[2] as string)) return;
    refuse("writing merges or refs through the API is not allowed");
  }
}

// A GitHub MCP tool that posts a comment, review body or reply: its body is held to the same rule.
export const MCP_COMMENT_TOOLS = /^mcp__.+?__(add_issue_comment|add_reply_to_pull_request_comment|add_comment_to_pending_review|pull_request_review_write|update_issue_comment|create_pending_pull_request_review|submit_pending_pull_request_review|create_and_submit_pull_request_review)$/i;

export function mcpCommentVerdict(tool: string, body: unknown): string | null {
  if (!MCP_COMMENT_TOOLS.test(tool) || typeof body !== "string" || !body.trim()) return null;
  return markedBody(body) ? null : `this comment would read as the human's own: ${COMMENT_HINT}`;
}

// The GitHub MCP server's tools reach the same PRs as gh, so the guard sees them too (Marie and
// Niilo, the -R/alias hotfix). A read passes. A merge, close or undraft is checked as the gh command
// it equals, a comment must carry the marker, and a commit to a branch follows git push's rule for
// protected branches. Any other write, including a tool the server adds later, is refused, and a
// readonly session writes nothing. The hook sees only mcp__<server>__<tool>, so a GitHub tool is
// known by its tool name whatever its server is called; an unknown tool is refused only on a server
// named like GitHub's, and every other server's tools pass (Niilo's ruling on #124).
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const MCP_GITHUB_READ = /^(get_\w+|list_\w+|search_\w+|issue_read|pull_request_read)$/;
const MCP_GITHUB_BRANCH_WRITES = new Set(["push_files", "create_or_update_file", "delete_file", "create_branch"]);
const MCP_GITHUB_WRITES = new Set(["create_pull_request", "update_pull_request", "update_pull_request_branch", "issue_write", "sub_issue_write"]);
function checkMcpGithub(tool: string, tin: Record<string, unknown>, ctx: GuardContext): void {
  const [, server = "", name = ""] = MCP_TOOL.exec(tool) ?? [];
  const known = MCP_COMMENT_TOOLS.test(tool) || name === "merge_pull_request" || MCP_GITHUB_BRANCH_WRITES.has(name) || MCP_GITHUB_WRITES.has(name);
  if (!known && (!/github/i.test(server) || MCP_GITHUB_READ.test(name))) return;
  if (ctx.policy === "readonly") refuse(`${name} writes to GitHub, and this session may only read`);
  const str = (k: string) => (typeof tin[k] === "string" ? (tin[k] as string) : "");
  const repo = `${str("owner")}/${str("repo")}`;
  const n = String(tin.pullNumber ?? "");
  if (MCP_COMMENT_TOOLS.test(tool)) {
    const why = mcpCommentVerdict(tool, tin.body);
    if (why !== null) refuse(why);
  } else if (name === "merge_pull_request") {
    const head = str("expectedHeadSha");
    const method = str("merge_method");
    checkGhProtect(["gh", "pr", "merge", n, "-R", repo, ...(head ? ["--match-head-commit", head] : []), ...(method ? [`--${method}`] : [])], ctx);
  } else if (MCP_GITHUB_BRANCH_WRITES.has(name)) {
    const own = ctx.ownRepos.some((r) => r.toLowerCase() === repo.toLowerCase());
    if (!own) checkBranchWrite(repo, str("branch"), ctx, `pushing to a protected branch (${str("branch")}) is not allowed`);
  } else if (!MCP_GITHUB_WRITES.has(name)) refuse(`${name} is a GitHub MCP write the guard does not know, so it is refused; use gh`);
  if (name === "update_pull_request_branch") checkPrHeadWrite(repo, n, ctx);
  if (name === "update_pull_request") {
    if (tin.state === "closed") checkGhProtect(["gh", "pr", "close", n, "-R", repo], ctx);
    // the PR edit API reopens a closed PR given state=open, as gh pr reopen does (CodeRabbit on #127)
    if (tin.state === "open") checkGhProtect(["gh", "pr", "reopen", n, "-R", repo], ctx);
    if (tin.draft === false) checkGhProtect(["gh", "pr", "ready", n, "-R", repo], ctx);
  }
  // the Issues API closes a PR by its number too, and the guard cannot tell an issue from a PR
  if (name === "issue_write" && tin.state === "closed") checkGhProtect(["gh", "pr", "close", String(tin.issue_number ?? ""), "-R", repo], ctx);
  if (name === "issue_write" && tin.state === "open") checkGhProtect(["gh", "pr", "reopen", String(tin.issue_number ?? ""), "-R", repo], ctx);
}

export function mcpVerdict(tool: string, tin: Record<string, unknown>, ctx: GuardContext): string | null {
  startLookups();
  try {
    checkMcpGithub(tool, tin, ctx);
    return null;
  } catch (e) {
    return e instanceof Refused ? e.message : `the guard failed (${(e as Error).message})`;
  }
}

// ---------------------------------------------------------------- read-only allowlist

const PLAIN_READ = new Set(["ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "wc", "sort", "uniq", "cut", "tr",
  "awk", "jq", "yq", "diff", "comm", "cmp", "file", "stat", "du", "df", "pwd", "cd", "echo", "printf", "true", "false",
  "test", "[", "[[", "which", "whereis", "type", "date", "basename", "dirname", "realpath", "readlink", "md5", "shasum",
  "id", "whoami", "uname", "sw_vers", "hostname", "sleep", "seq", "column", "paste", "join", "nl", "xxd", "strings",
  "tree", "ps", "env", "printenv", "export", "set", "unset", "local", "read", "return", "exit", "break", "continue",
  "shift", "getconf", "git-lfs", "od", "hexdump", "rev", "expand", "unexpand", "fold", "fmt", "look", "bc", "expr", "let",
  "declare", "typeset", "readonly", "alias", "unalias", "hash", "wait", "jobs", "kill", "history", "fc", "ulimit", "umask",
  "tput", "clear", "stty", "tty", "yes", "cal", "uptime", "w", "who", "last", "arch", "sysctl", "nproc", "launchctl",
  "open", "say", "pbcopy", "pbpaste", "plutil", "defaults", "mdfind", "mdls", "sips", "textutil", "iconv", "base64",
  "openssl", "gzip", "gunzip", "zcat", "bzip2", "bunzip2", "xz", "unzip", "zipinfo", "diff3", "sdiff", "vimdiff", "man",
  "apropos", "whatis", "info", "help", "tldr", "curl", "wget", "nc", "dig", "host", "nslookup", "ping", "traceroute",
  "ifconfig", "networksetup", "scutil", "security", "codesign", "spctl", "xcode-select", "xcrun", "swift", "swiftc"]);
// read-only by name, but each of these acts on the machine
const PLAIN_REFUSED = new Set(["kill", "launchctl", "security", "defaults", "networksetup", "open", "say", "pbcopy", "codesign", "spctl", "xcode-select"]);
const TMP_WRITERS = new Set(["mkdir", "touch", "cp", "mv", "rm", "rmdir", "ln", "rsync", "install", "tee", "truncate", "dd", "chmod", "chown", "unzip", "tar", "zip"]);
const INTERPRETERS = new Set(["python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "swift", "lua", "tclsh", "osascript", "applescript",
  "expect", "sqlite3", "psql", "mysql", "redis-cli", "ed", "ex", "vi", "vim", "nvim", "nano", "emacs", "pico", "screen", "tmux"]);

function checkReadonly({ words: raw, writes }: Simple, ctx: GuardContext): void {
  for (const t of writes) if (!writable(t, ctx)) refuse(`redirect to '${t}' writes outside /tmp`);
  let words = stripPrefixes(raw);
  if (!words.length) return;
  let name;
  [name, words] = cmdName(words);
  const args = words.slice(1);
  const flags = flagsOf(args);
  const pos = posOf(args);
  if (name === "git") return checkGitReadonly(words, ctx);
  if (name === "gh") return checkGhReadonly(words);
  if (name === "php" && pos[0] === "artisan" && ["test", "route:list", "about", "config:show", "env", "list", "--version", "inspire"].includes(pos[1] ?? "")) return;
  if (INTERPRETERS.has(name) || SHELLS.has(name)) refuse(`'${name}' can write anything; not allowed in a read-only session`);
  if (name === "sed") {
    if (flags.some((f) => /^-[a-zA-Z]*i.*$/.test(f) || f.startsWith("--in-place"))) refuse("sed -i edits files");
    return;
  }
  if (name === "find") {
    if (args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(a))) refuse("find -delete/-exec is not allowed");
    return;
  }
  if (name === "curl" || name === "wget") {
    if (name === "wget" || flags.some((f) => ["-o", "-O", "--output", "--remote-name", "-T", "--upload-file", "-d", "--data", "--data-binary", "-F", "--form", "-X", "--request"].includes(f) ||
      ["--output=", "--data", "-o", "-X"].some((p) => f.startsWith(p))))
      refuse("downloading to a file or sending data is not allowed");
    return;
  }
  if (TMP_WRITERS.has(name)) {
    if (["tar", "zip", "unzip", "dd"].includes(name)) refuse(`${name} is not allowed in a read-only session`);
    if (["cp", "mv", "install", "rsync", "ln"].includes(name)) {
      // only the destination has to be under /tmp; sources may be anywhere readable
      if (!pos.length) refuse(`${name} without arguments`);
      const dests = pos.length >= 2 ? pos.slice(-1) : pos;
      if (!dests.every((d) => writable(d, ctx)) || pos.some((p) => p.split("/").includes(".."))) refuse(`${name} destination must be under /tmp`);
      if (name === "ln" && !pos.every((p) => writable(p, ctx))) refuse("ln may only create links under /tmp");
      return;
    }
    if (!pos.length || !pos.every((p) => writable(p, ctx))) refuse(`${name} may only touch paths under /tmp`);
    return;
  }
  if (PLAIN_READ.has(name)) {
    if (name === "awk" && pos.some((a) => /(>{1,2}\s*["']|>>|system\s*\()/.test(a))) refuse("awk program writes a file or runs a command");
    if (PLAIN_REFUSED.has(name)) refuse(`${name} is not allowed in a read-only session`);
    return;
  }
  // test and lint runners, read-only invocations only
  if (["--fix", "--write", "--apply", "--fix-dry-run"].some((x) => args.includes(x)) && !args.includes("--check")) refuse("auto-fixing runners edit files; run the check form");
  const p0 = pos[0] ?? "";
  if (name === "npm" && (args[0] === "test" || (args[0] === "run" && ["lint", "check-types", "typecheck", "test", "test:unit", "test:ci", "tsc"].includes(args[1] ?? "")))) return;
  if (name === "npx" && ["jest", "tsc", "eslint", "vitest", "prettier", "cypress"].includes(p0) && (args.includes("--check") || p0 !== "prettier") && !(p0 === "cypress" && pos.includes("run"))) return;
  if (name === "yarn" && ["lint", "test", "check-types", "typecheck", "jest", "tsc"].includes(p0)) return;
  if (name === "pnpm" && ["test", "lint", "check-types"].includes(p0)) return;
  if (["phpstan", "phpunit", "pest", "phplint", "phpcs", "psalm"].includes(name)) return;
  if (name === "pint") {
    if (args.includes("--test")) return;
    refuse("pint rewrites files; use pint --test");
  }
  if (name === "rector") {
    if (args.includes("--dry-run")) return;
    refuse("rector rewrites files; use --dry-run");
  }
  if (name === "composer" && ["show", "validate", "outdated", "licenses", "why", "why-not", "depends", "prohibits", "check-platform-reqs"].includes(p0)) return;
  const pubReads = !(p0 === "pub" && pos.length > 1 && !["deps", "outdated"].includes(pos[1] as string));
  if (name === "flutter" && ["analyze", "test", "doctor", "--version", "pub"].includes(p0) && pubReads) return;
  if (name === "dart" && ((["analyze", "--version", "pub"].includes(p0) && pubReads) ||
    (p0 === "format" && (args.includes("--set-exit-if-changed") || args.includes("--output=none") || (args.includes("-o") && args.includes("none")))))) return;
  if (name === "docker" && p0 === "compose" && pos.length > 1) {
    const tool = pos[3]?.split("/").pop() ?? "";
    if (["ps", "logs", "config", "ls", "top", "images", "version"].includes(pos[1] as string)) return;
    if (pos[1] === "exec" && ["phpunit", "phpstan", "pest", "pint"].includes(tool) && !(tool === "pint" && !args.includes("--test"))) return;
  }
  if (name === "claude" && p0 === "agents") return;
  refuse(`'${chars(words.join(" ")).slice(0, 60).join("")}' is not in the read-only allowlist`);
}

// The script a shell runs: its -c line, or the script file it names. Neither means it reads its
// script from stdin. `-s` reads stdin too, its other words being the script's arguments.
const STDIN_FILES = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
function shellScript(args: string[]): { code?: string; file?: string } {
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return stdin || args[i + 1] === undefined ? {} : { file: args[i + 1] as string };
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return { code: args[i + 1] ?? "" };
    if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(a)) i++;
    else if (STDIN_FILES.has(a)) return {};
    else if (/^[-+]./.test(a)) stdin ||= /^-[a-zA-Z]*s/.test(a);
    else return stdin ? {} : { file: a };
  }
  return {};
}

// ssh's options that take a value. Its first other word is the host, options may follow the host
// too, and the rest is the command line it runs there.
const SSH_VALUES = "BbcDEeFIiJLlmOoPpQRSWw";
function sshCommand(args: string[]): string {
  let host = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return args.slice(i + 1 + Number(!host)).join(" ");
    if (/^-./.test(a)) {
      if ([...a.slice(1)].findIndex((c) => SSH_VALUES.includes(c)) === a.length - 2) i++;
    } else if (host) return args.slice(i).join(" ");
    else host = true;
  }
  return "";
}

// The command word, read by its shape: an allowlist, applied to every command word including the
// one after a wrapper (Marie and Niilo on #124, round 8). Every other shape is refused:
//  1. A bare name, [A-Za-z0-9._+:-].
//  2. An absolute path, or one under ~/, $HOME/ or ${HOME}/ (unless the line names HOME otherwise).
//  3. A relative path with no .. segment.
// Refused: a glob or brace character, quoted or not ({env,gh,...}, /usr/bin/e?v), any other ~ form
// (~+, ~-, ~user), a variable, a substitution or a backtick, which the shell expands into anything.
//
// Then the program is the file that runs, not its spelling (round 9: rsh and slogin are ssh, rbash
// is bash, /usr/lib/git-core/git-push is git push): a bare name is looked up on PATH, a path is the
// file itself, and its realpath's basename names it. gh, git, git-<sub> (as git <sub>), ssh, find and
// the shells are themselves wherever they live; busybox, which is all of them, is refused. Any other
// program is itself (env, nice, xargs, ...) when its file resolves into a system bin dir, and
// otherwise a project script, which runs. A file that is not there is named by its spelling, and a
// relative path on a line that changes directory (cd, pushd, popd, env -C, find -execdir) cannot be
// resolved, so it is named by its spelling too. Returns the words to check, or [] for a script.
const BARE_WORD = /^([\w.+:-]+|\[\[?)$/;
const CHECKED_ANYWHERE = new Set(["gh", "git", "ssh", "find"]);
// the programs stripPrefixes reads as wrappers, or refuses
const WRAPPERS = new Set(["env", "nice", "setsid", "stdbuf", "flock", "timeout", "nohup", ...REFUSED_WRAPPERS]);
function executable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = posix.join(dir || process.cwd(), name);
    if (executable(p)) return p;
  }
  return null;
}
function realFile(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}
// the words a program name stands for when the guard checks it wherever it lives, or null
function anywhere(name: string): string[] | null {
  const n = name.toLowerCase();
  if (n === "busybox") refuse("busybox runs any of its applets (sh, env, find, xargs, ...), which the guard cannot check: run the program itself");
  if (/^git-[\w-]+$/.test(n)) return ["git", n.slice(4)];
  if (CHECKED_ANYWHERE.has(n)) return [n];
  if (SHELLS.has(name)) return [name];
  // the other shells, and a versioned or static file of one (ksh93, mksh-static), read as sh
  return /^(r?ba|da|z|k|mk|lk|tc|c|y|po|a)?sh(\d[\w.]*|-static)?$/.test(n) ? ["sh"] : null;
}
function commandWord(words: string[], ctx: GuardContext): string[] {
  for (;;) {
    let w = words[0];
    if (w === undefined) return words;
    let file: string | null = null;
    // the path as the shell finds it, before any link in its last part is followed
    let where: string | null = null;
    let trusted: boolean;
    const dirs = ctx.binDirs ?? TRUSTED_BIN_DIRS;
    const bare = BARE_WORD.test(w);
    if (bare) {
      where = onPath(w);
      file = where && realFile(where);
      // not on PATH: a builtin, or a program that is not there, named by its spelling
      trusted = file === null;
    } else {
      const cannot = (why: string) => refuse(`the command '${w}' ${why}, which the guard cannot check: run it by its name or its plain path`);
      const home = /^\$(?:HOME|\{HOME\})(\/.*)$/.exec(w);
      if (home) {
        if (ctx.homeAssigned) cannot("is under a HOME this line sets");
        w = `~${home[1]}`;
      }
      if (/[$`]/.test(w)) cannot("runs whatever its variable or substitution holds");
      if (/[*?[\]{}]/.test(w)) cannot("is a glob or a brace expansion");
      if (!w.includes("/")) cannot("is not a plain name");
      if (/^~(?!\/)/.test(w) || w.indexOf("~", 1) >= 0) cannot("uses a ~ form other than ~/");
      const relative = !w.startsWith("/") && !w.startsWith("~");
      if (relative && w.split("/").includes("..")) cannot("climbs out of the project with ..");
      if (relative && ctx.cwdChanged) trusted = true;
      else {
        where = unresolved(w.startsWith("~") ? homedir() + w.slice(1) : w);
        file = realFile(where);
        trusted = file === null && trustedDir(posix.dirname(w), dirs);
      }
    }
    const spelled = posix.basename(w);
    const real = file === null ? spelled : posix.basename(file);
    // A system program is named by where its directory resolves plus its name as written: on
    // ubuntu-26.04 /usr/bin/env is a link to /usr/lib/cargo/bin/coreutils/env (Marie on #124). A file
    // outside the bin dirs is a system program too when a bin dir's name of it resolves to it (a link
    // to that env is env); any other file there is named by what it is, or not at all.
    const system = file !== null && (trustedDir(posix.dirname(file), dirs) || [...dirs].some((d) => realFile(`${d}/${real}`) === file));
    if (file !== null) trusted = system || (where !== null && trustedDir(posix.dirname(where), dirs));
    // a system program keeps its spelling unless its file is a wrapper (/tmp/e linked to env is env)
    // git runs the subcommand its argv[0] names, so a git-push linked to git is git push
    const sub = real.toLowerCase() === "git" && /^git-[\w-]+$/i.test(spelled);
    const named = (sub ? anywhere(spelled) : anywhere(real)) ?? anywhere(spelled) ?? (trusted ? [system && WRAPPERS.has(real) ? real : spelled] : null);
    if (named === null) return bare ? words : [];
    const next = stripPrefixes([...named, ...words.slice(1)]);
    // stripPrefixes took nothing off, so this is the command; otherwise read the one after the wrapper
    if (next[0] === named[0] && next.length === named.length + words.length - 1) return next;
    words = next;
  }
}

const ARGV_CHECKED = new Set(["gh", "git", "ssh"]);
// the programs the guard reads specially: an argument naming one starts a check. Builtins (exec,
// eval, source, .) are left out, since a program cannot exec them.
const TRIGGERS = new Set([...ARGV_CHECKED, ...SHELLS, "sh", "busybox", "find", "xargs", "crontab", "at", "batch",
  ...[...WRAPPERS, ...REFUSED_WRAPPERS].filter((w) => !["exec", "eval", "source", "."].includes(w))]);
// whether an argument word, read as a command word, names a program the guard reads specially
function namesChecked(w: string, ctx: GuardContext): boolean {
  if (!BARE_WORD.test(w) && !/^(\/|~\/|\.\/|\$\{?HOME\}?\/)[^\s*?[\]{}`]*$/.test(w)) return false;
  if (TRIGGERS.has((w.split("/").pop() ?? "").toLowerCase())) return true;
  let named: string[];
  try {
    named = commandWord([w], ctx);
  } catch (e) {
    if (e instanceof Refused && /busybox/.test(e.message)) throw e;
    return false;
  }
  // nothing left: a wrapper by another name, which stripPrefixes took off
  if (!named.length) return !KEYWORDS.has(w) && !w.includes("/");
  return TRIGGERS.has((named[0] as string).toLowerCase());
}

// whether words[i] is a string the program runs through sh: tmux's shell-command arguments, and the
// -c of su, runuser and sg
const TMUX_SHELL_CMDS = new Set(["new-session", "new", "new-window", "neww", "split-window", "splitw", "respawn-pane", "respawnp",
  "respawn-window", "respawnw", "run-shell", "run", "if-shell", "if", "pipe-pane", "pipep", "display-popup", "popup"]);
function runsShellString(words: string[], i: number): boolean {
  const name = (words[0] as string).toLowerCase();
  if (name === "tmux") return words.slice(1, i).some((w) => TMUX_SHELL_CMDS.has(w));
  if (["su", "runuser", "sg"].includes(name)) return ["-c", "--command"].includes(words[i - 1] as string) || /^--command=/.test(words[i] as string);
  return false;
}

// the commands in a string, split at shell separators whatever the quoting, that start with a
// program the guard reads specially (after keywords and assignments) and reach gh, git, ssh or a
// shell: each is checked as a line from that word, or by its words when it does not parse. A piece
// that starts with any other word, or reaches none of those (`sudo usermod` in a message), is text.
function checkTriggerPieces(line: string, ctx: GuardContext): void {
  // the program the piece runs, past its wrappers, is gh, git, ssh or a shell
  const reaches = (ws: string[]): boolean => {
    try {
      const n = posix.basename(commandWord(ws, ctx)[0] ?? "").toLowerCase();
      return ARGV_CHECKED.has(n) || SHELLS.has(n) || n === "sh" || n === "busybox";
    } catch {
      return false;
    }
  };
  // what only a real command line can mean is refused; a piece that does not parse, a gh word that
  // is no gh command, ssh with no command, or a $variable command is prose cut from a message
  // (and in a string that does not parse, a shell word with nothing after it, `readKeyboard(sh)`)
  const textual = (check: () => void, cut = false): void => {
    try {
      check();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      if (!/^(cannot parse|gh \S+: gh aliases and extensions|ssh with no command|the command '\$)/.test(e.message) &&
        !(cut && /reading its script from a pipe/.test(e.message))) throw e;
    }
  };
  // a string that parses is read by the guard's own parser; any other is split at separators
  let simples: Simple[] | null = null;
  try {
    simples = simpleCommands(tokenize(line));
  } catch {
    simples = null;
  }
  if (simples) {
    for (const simple of simples) {
      const ws = simple.words;
      let k = 0;
      while (k < ws.length && (KEYWORDS.has(ws[k] as string) || /^[A-Za-z_]\w*=/.test(ws[k] as string))) k++;
      if (k >= ws.length || !namesChecked(ws[k] as string, ctx)) continue;
      if (reaches(ws.slice(k))) textual(() => checkProtect({ ...simple, words: ws.slice(k) }, ctx), !simple.piped && !simple.stdin?.length && !simple.reads.length);
    }
    return;
  }
  for (const piece of line.split(/[;&|\n`()]|\$\(/)) {
    const ws = piece.trim().split(/\s+/).filter(Boolean);
    let k = 0;
    while (k < ws.length && (KEYWORDS.has(ws[k] as string) || /^[A-Za-z_]\w*=/.test(ws[k] as string))) k++;
    if (k >= ws.length || !namesChecked(ws[k] as string, ctx)) continue;
    if (!reaches(ws.slice(k))) continue;
    textual(() => {
      try {
        checkCommand(ws.slice(k).join(" "), ctx);
      } catch (e) {
        if (!(e instanceof Refused) || !/^cannot parse/.test(e.message)) throw e;
        checkProtect({ words: ws.slice(k), writes: [], reads: [] }, ctx);
      }
    }, true);
  }
}

// Programs that only ever read their arguments as data. Not man (-P, MANPAGER), less, more, vi,
// awk, sed, find, xargs, tar, rsync, make or docker: each can run a program it is given.
const DATA_ONLY = new Set(["type", "which", "ls", "readlink", "realpath", "stat", "file", "grep", "cat", "head", "tail", "wc", "echo", "printf", "apt-cache", "dpkg-query"]);
function dataOnly(words: string[], raw: string[]): boolean {
  const name = (words[0] as string).toLowerCase();
  if (DATA_ONLY.has(name)) return true;
  // rg runs a program with --pre
  if (name === "rg") return !words.some((w) => /^--pre(-glob)?(=|$)/.test(w));
  // `command -v gh` names gh; stripPrefixes has dropped `command`, so look for it just before
  if (/^-[pvV]*[vV][pvV]*$/.test(name) && raw.length > words.length && raw.slice(raw.length - words.length).every((w, k) => w === words[k]))
    return raw[raw.length - words.length - 1] === "command";
  return false;
}

// the index of docker run's or create's image word, or -1. Only options known to take a value skip
// the next word; any other is read as a flag, so a misread lands on a word that is still scanned.
const DOCKER_VALUE_OPTS = new Set(["-a", "-c", "-e", "-h", "-l", "-m", "-p", "-u", "-v", "-w", "--add-host", "--attach", "--cap-add", "--cap-drop",
  "--cgroupns", "--cidfile", "--cpus", "--cpu-shares", "--device", "--dns", "--entrypoint", "--env", "--env-file", "--gpus", "--group-add", "--hostname",
  "--ipc", "--label", "--label-file", "--log-driver", "--log-opt", "--memory", "--mount", "--name", "--network", "--net", "--pid", "--platform", "--publish",
  "--pull", "--restart", "--runtime", "--security-opt", "--shm-size", "--stop-signal", "--stop-timeout", "--tmpfs", "--ulimit", "--user", "--volume", "--workdir"]);
function dockerImage(words: string[]): number {
  if ((words[0] as string).toLowerCase() !== "docker") return -1;
  let i = ["run", "create"].includes(words[1] ?? "") ? 2 : words[1] === "container" && ["run", "create"].includes(words[2] ?? "") ? 3 : -1;
  if (i < 0) return -1;
  for (; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "--") return i + 1;
    if (!w.startsWith("-")) return i;
    if (DOCKER_VALUE_OPTS.has(w)) i++;
  }
  return -1;
}

function checkProtect({ words: raw, reads, stdin = [], piped = false, redirected0 = false, upstream = [] }: Simple, ctx: GuardContext): void {
  let words = stripPrefixes(raw);
  words = commandWord(words, ctx);
  if (!words.length) return;
  const name = (words[0] as string).toLowerCase();
  if (name === "crontab" || name === "at" || name === "batch") checkScheduled(name, words, [...stdin, ...(piped && !redirected0 ? upstream : [])], ctx);
  // Fail closed on argv: a program the guard does not read as gh, git, ssh or a shell may still run
  // its arguments (ionice, strace, systemd-run, docker exec), so any later word that names one of
  // those, by commandWord's shape and file rule, is checked as a command from there on, and a word
  // holding a command line whose first word names one (watch 'gh pr merge 1', vi -c '!gh ...'), or
  // an option's value that does (--pre=gh), is checked as that line or word. The command word's arguments are skipped only for a program that can never run another
  // (DATA_ONLY), and for docker run's image word (Marie and Niilo on #124, round 9).
  if (!ARGV_CHECKED.has(name) && !SHELLS.has(name) && name !== "sh" && !dataOnly(words, raw)) {
    const image = dockerImage(words);
    for (let i = 1; i < words.length; i++) {
      if (i === image) continue;
      const w = words[i] as string;
      // an option's value, --pre=gh, and a line an editor runs, vi -c '!gh pr merge 1'
      const value = /^--?[\w-]+=/.test(w) ? w.slice(w.indexOf("=") + 1) : w;
      const line = value.trim().replace(/^[:!]+/, "");
      // a string a program runs through sh (tmux new 'a; b', su -c) is parsed as a shell line and
      // every command in it checked; one that does not parse is refused. Any other program's string
      // may be code or a message (python3 -c, sed, a commit body), so only the commands in it that
      // start with a program the guard reads specially are checked, each as a shell line.
      if (/\s|[;&|`]/.test(line) && runsShellString(words, i)) checkCommand(line, ctx);
      else if (/[\s;&|`(]/.test(line)) checkTriggerPieces(line, ctx);
      else if (namesChecked(line, ctx)) checkProtect({ words: [line, ...words.slice(i + 1)], writes: [], reads: [], stdin, piped }, ctx);
    }
  }
  if (name === "git") return checkGitProtect(words, ctx);
  if (name === "gh") return checkGhProtect(words, ctx);
  // `bash -c '<script>'` is the script, checked like any other command line, and so is the heredoc or
  // here-string a shell reads as its script. A script file is outside the guard (see the header). A
  // script the guard cannot see, from a pipe or a <( ... ), is refused.
  if (SHELLS.has(name)) {
    const { code, file } = shellScript(words.slice(1));
    if (code !== undefined) return checkCommand(code, ctx);
    if (file !== undefined && !/^[<>]\($/.test(file)) return;
    if (file === undefined && stdin.length) return stdin.forEach((script) => checkCommand(script, ctx));
    if (file === undefined && reads.some((r) => !STDIN_FILES.has(r))) return; // bash < script.sh, a script file
    refuse(`${name} reading its script from a pipe or a <( ... ) cannot be checked: run the commands themselves, or ${name} -c '...'`);
  }
  // the command find runs on each file, up to its `;` or `+`
  if (name === "find")
    for (let i = 1; i < words.length; i++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[i] as string)) continue;
      let j = i + 1;
      while (j < words.length && words[j] !== ";" && words[j] !== "+") j++;
      checkProtect({ words: words.slice(i + 1, j), writes: [], reads: [] }, ctx);
      i = j;
    }
  if (name === "ssh") {
    // with no command, the remote login shell runs what ssh reads on stdin
    const remote = sshCommand(words.slice(1));
    if (remote) checkCommand(remote, ctx);
    else if (stdin.length) stdin.forEach((script) => checkCommand(script, ctx));
    else if (piped || reads.some((r) => r !== "/dev/null"))
      refuse("ssh with no command runs its stdin on the host, which the guard cannot see: give the command, ssh <host> '<command>'");
  }
}

// ---------------------------------------------------------------- secret files
//
// Every role, both policies. A key in lyyti-classic's lyyti-config.php reached a transcript twice, on
// 2026-10-20 and 2026-10-21, both times through a grep whose redaction missed. So no command prints a
// secret file's contents, filtered or not. What cannot print it stays allowed: test -f, ls, stat,
// grep -q/-l/-c, writing it by redirect, editing it in place with sed -i, and copying a template into
// it. The stack scripts write .env inside `factory stack up`, which the guard never sees into.

// Committed templates hold no secrets, and builders read them to learn the keys.
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.dist", ".env.template"]);

export function secretFile(p: string): boolean {
  const b = posix.basename(p.replace(/\/+$/, ""));
  if (ENV_TEMPLATES.has(b)) return false;
  return b === ".env" || b.startsWith(".env.") || b === "lyyti-config.php" || b === "auth.json" || b.endsWith(".token");
}

// A glob counts when it could expand to one. A shell's * does not match a leading dot.
const SECRET_SAMPLES = [".env", ".env.local", "lyyti-config.php", "auth.json", "github.token"];
function namesSecret(word: string): boolean {
  const b = posix.basename(word.replace(/\/+$/, ""));
  if (!/[*?[]/.test(b)) return secretFile(word);
  let re: RegExp | null;
  try {
    re = new RegExp(`^${b.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  } catch {
    re = globRegex(b);
  }
  // A glob that matches nothing reaches the command as it was typed.
  if (re === null) return secretFile(word);
  return SECRET_SAMPLES.some((x) => (!x.startsWith(".") || b.startsWith(".")) && re.test(x));
}

// The shell's reading of a glob, for the words the translation above cannot compile: a grep pattern
// such as `stacks\[` or `[^-+]`. A backslash quotes the next character, a `[` with no closing `]` is
// literal, and `!` or `^` first negates a bracket. null when a bracket's range is out of order, which
// matches nothing.
function globRegex(glob: string): RegExp | null {
  const lit = (c: string) => (/\w/.test(c) ? c : `\\${c}`);
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "\\" && i + 1 < glob.length) {
      out += lit(glob[++i] as string);
      continue;
    }
    if (c === "*" || c === "?") {
      out += c === "*" ? ".*" : ".";
      continue;
    }
    if (c === "[") {
      const neg = glob[i + 1] === "!" || glob[i + 1] === "^";
      let j = i + 1 + Number(neg) + Number(glob[i + 1 + Number(neg)] === "]");
      while (j < glob.length && glob[j] !== "]") j += glob[j] === "\\" ? 2 : 1;
      if (j < glob.length) {
        const body = [...glob.slice(i + 1 + Number(neg), j).replace(/\\(.)/g, "$1")];
        out += `[${neg ? "^" : ""}${body.map((x, k) => (x === "-" && k > 0 && k < body.length - 1 ? "-" : lit(x))).join("")}]`;
        i = j;
        continue;
      }
    }
    out += lit(c);
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

// A path named inside an interpreter's code, `open('.env')`; `process.env.X` is not one.
const SECRET_IN_CODE = /(^|[^\w.])(\.env(\.[\w-]+)?|lyyti-config\.php|auth\.json|[\w-]+\.token)(?![\w.-])/;

// Commands that print what they read, or hand it to something that will.
const PRINTERS = new Set(["cat", "tac", "head", "tail", "less", "more", "most", "bat", "nl", "od", "xxd", "hexdump", "strings", "base64",
  "cut", "sort", "uniq", "awk", "gawk", "sed", "grep", "egrep", "fgrep", "rg", "ag", "ack", "jq", "yq", "paste", "column", "fold", "fmt",
  "rev", "tr", "iconv", "diff", "sdiff", "diff3", "vimdiff", "comm", "join", "view", "vi", "vim", "nvim", "nano", "emacs", "pico", "ed", "ex",
  "plutil", "openssl", "gzip", "zcat", "tee", "dd", "envsubst", "pbcopy"]);
// A shell's -c line is parsed as a command line of its own, so only these are read as code.
const CODE_RUNNERS = new Set(["python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "osascript", "lua", "tclsh"]);
// grep/rg flags whose output carries no line of the file: quiet, names only, counts.
const GREP_SILENT = /^-([a-zA-Z]*[qlLc][a-zA-Z]*)$|^--(quiet|silent|files-with-matches|files-without-match|count)$/;

function checkSecrets({ words: raw, reads }: Simple): void {
  const secret = (w: string) => namesSecret(w);
  for (const r of reads) if (secret(r)) refuse(`reading ${r} into a command prints a secret; check it is set with grep -q instead`);
  const words = raw.filter((w) => !/^\w+=/.test(w));
  if (!words.length) return;
  const name = posix.basename(words[0] as string);
  const args = words.slice(1);
  const named = args.filter((a) => !a.startsWith("-") && secret(a));
  if (CODE_RUNNERS.has(name) && args.some((a) => SECRET_IN_CODE.test(a) && !ENV_TEMPLATES.has(posix.basename(a))))
    refuse(`${name} with a secret file in its code could print it; check the key with grep -q instead`);
  if (!named.length) return;
  const file = named[0] as string;
  const why = `${file} holds secrets, and ${name} would print them. Check a key is set with \`grep -q '^KEY=' ${file} && echo set\``;
  if (["grep", "egrep", "fgrep", "rg", "ag"].includes(name)) {
    if (args.some((a) => GREP_SILENT.test(a))) return;
    refuse(why);
  }
  if (name === "sed") {
    if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) && !args.some((a) => a === "-n" || /(^|;)\s*\d*,?\d*\s*[pw]\b/.test(a)))
      return; // edited in place, nothing printed
    refuse(why);
  }
  if (["cp", "mv", "ln", "install", "rsync"].includes(name)) {
    const pos = args.filter((a) => !a.startsWith("-"));
    if (pos.length >= 2 && secret(pos[pos.length - 1] as string)) return; // into another secret file
    if (pos.slice(0, -1).some(secret)) refuse(`copying ${file} out to a file that is not a secret one exposes it to the next reader`);
    return;
  }
  if (PRINTERS.has(name) || CODE_RUNNERS.has(name)) refuse(why);
}

// ---------------------------------------------------------------- the hook

// The body starts on the line after the one holding <<DELIM, whatever else is on that line, and ends
// at a line that is the delimiter (after tabs, for <<-). The delimiter is any word, END-DATA as well as
// EOF, quoted in whole or in part (CodeRabbit on #124: <<EN'D-DATA' ends at END-DATA). With any part
// quoted the body is text; unquoted, bash runs each $(...) and `...` in it.
const HEREDOC_OPEN = /(?<!<)<<(-?)[ \t]*((?:[^\s'"<>;&|()\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+)/g;
interface Heredoc { start: number; head: number; rest: string; body: string; quoted: boolean; end: number }
// Whether text[at] lies in a comment: an unquoted # at the start of a word runs to the end of its
// line, so a `<<EOF` there opens no heredoc and the next line is a command (Marie on #127).
function inComment(text: string, at: number): boolean {
  let q = "";
  let comment = false;
  for (let i = 0; i < at; i++) {
    const c = text[i] as string;
    if (comment) {
      if (c === "\n") comment = false;
    } else if (c === "\\" && q !== "'") i++;
    else if (q) {
      if (c === q) q = "";
    } else if (c === "'" || c === '"') q = c;
    else if (c === "#" && (i === 0 || /[\s;&|()<>]/.test(text[i - 1] as string))) comment = true;
  }
  return comment;
}
function nextHeredoc(text: string, from: number): Heredoc | null {
  HEREDOC_OPEN.lastIndex = from;
  for (let m = HEREDOC_OPEN.exec(text); m; m = HEREDOC_OPEN.exec(text)) {
    if (inComment(text, m.index)) continue;
    const word = m[2] as string;
    const delim = word.replace(/\\(.)|'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_, e?: string, sq?: string, dq?: string) =>
      e ?? sq ?? (dq ?? "").replace(/\\([$`"\\\n])/g, "$1"));
    const head = m.index + m[0].length;
    const nl = text.indexOf("\n", head);
    if (nl < 0) return null;
    let at = nl + 1;
    while (at <= text.length) {
      const eol = text.indexOf("\n", at);
      const line = text.slice(at, eol < 0 ? text.length : eol);
      // the whole line is the delimiter: `EOF ` with a trailing space is still body (CodeRabbit on #127)
      if ((m[1] ? line.replace(/^\t+/, "") : line) === delim)
        return { start: m.index, head, rest: text.slice(head, nl), body: text.slice(nl + 1, Math.max(nl + 1, at - 1)), quoted: /['"\\]/.test(word), end: eol < 0 ? text.length : eol + 1 };
      if (eol < 0) break;
      at = eol + 1;
    }
    // no closing line: the lines stay and are read as commands, which over-checks
  }
  return null;
}

// What echo or printf prints, or null for any other command. Only \\n, \\t and \\\\ are read, and
// only %s, %d and %%: any other escape (\\x67, \\147, \\c) in echo's words or printf's format, or any
// other format (%.2s, %b), is UNREADABLE, which a pipe into crontab, at or batch refuses (Marie on
// #124 at c197d465).
const UNREADABLE = "\u0000unreadable";
function printedText(words: string[]): string | null {
  const name = posix.basename(words[0] ?? "");
  const esc = (t: string): string | null =>
    /\\[^nt\\]|\\$/.test(t.replace(/\\\\/g, "")) ? null : t.replace(/\\(n|t|\\)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"));
  if (name === "echo") {
    let i = 1;
    while (/^-[neE]+$/.test(words[i] ?? "")) i++;
    return esc(words.slice(i).join(" ")) ?? UNREADABLE;
  }
  if (name === "printf") {
    // `printf -- FORMAT`: the -- ends the options and is not the format (Marie on #124)
    if (words[1] === "--") words = [words[0] as string, ...words.slice(2)];
    const fmt = words[1];
    if (fmt === undefined) return "";
    if (fmt.replace(/%%|%[sd]/g, "").includes("%")) return UNREADABLE;
    const lit = fmt.split(/(%%|%[sd])/);
    if (lit.some((piece, x) => x % 2 === 0 && esc(piece) === null)) return UNREADABLE;
    const args = words.slice(2);
    let out = "";
    do {
      // an argument is printed as it is: printf reads escapes only in the format and %b
      out += lit.map((piece, x) => (x % 2 === 0 ? esc(piece) : piece === "%%" ? "%" : (args.shift() ?? ""))).join("");
    } while (args.length && lit.length > 1 && lit.some((piece, x) => x % 2 === 1 && piece !== "%%"));
    return out;
  }
  return null;
}

// crontab, at and batch run the commands on their stdin later: each is checked now. A cron line is
// its command after the five time fields or an @word, up to the first unescaped % (cron's stdin); a
// blank line, a # comment and a VAR=value line are not commands, and any other line is checked whole.
// A file they read instead is outside the guard (see the header).
function checkScheduled(name: string, words: string[], texts: string[], ctx: GuardContext): void {
  let file = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    if (name === "crontab") {
      if (w === "-u") i++;
      else if (/^-[lrei]+$/.test(w)) return; // list, remove, edit: nothing is read from stdin
      else if (w !== "-" && !w.startsWith("-")) file = true;
    } else {
      if (/^-[qtfm]*[qtf]$/.test(w)) {
        if (w.endsWith("f")) file = true;
        i++;
      } else if (/^-[a-zA-Z]*[lrdc]/.test(w) && w.startsWith("-")) return; // list, remove, cat a job
      else if (w.startsWith("-") && /f/.test(w)) file = true;
    }
  }
  if (file) return;
  for (const text of texts) {
    if (text === UNREADABLE) refuse("what printf prints here cannot be read: write the line plainly");
    if (name !== "crontab") {
      checkCommand(text, ctx);
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || /^[A-Za-z_]\w*\s*=/.test(line)) continue;
      const m = /^@\w+\s+(.*)$/s.exec(line) ?? /^(?:\S+\s+){5}(.*)$/s.exec(line);
      const command = m ? (m[1] as string).replace(/(^|[^\\])%.*$/s, "$1") : line;
      checkCommand(command, ctx);
    }
  }
}

// The command lines of the $(...) and `...` in an unquoted heredoc's body, which bash runs as it reads
// it; $((...)) is arithmetic.
function bodySubstitutions(body: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") i++;
    else if (c === "`") {
      let j = i + 1;
      while (j < body.length && body[j] !== "`") j += body[j] === "\\" ? 2 : 1;
      if (j >= body.length) refuse("cannot parse quoting (No closing backtick)");
      out.push(body.slice(i + 1, j).replace(/\\([`$\\])/g, "$1"));
      i = j;
    }
    else if (c === "$" && body[i + 1] === "(") {
      let depth = 0;
      let q = "";
      let j = i + 1;
      for (; j < body.length; j++) {
        const d = body[j] as string;
        if (d === "\\" && q !== "'") j++;
        else if (q) { if (d === q) q = ""; }
        else if (d === "'" || d === '"') q = d;
        else if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
      }
      if (j >= body.length) refuse("cannot parse quoting (No closing parenthesis)");
      const inner = body.slice(i + 2, j);
      if (!/^\(.*\)$/s.test(inner)) out.push(inner);
      i = j;
    }
  }
  return out;
}

function checkCommand(cmd: string, ctx: GuardContext): void {
  if (!ctx.homeAssigned && /\bHOME\b/.test(cmd.replace(/\$\{?HOME\b/g, ""))) ctx = { ...ctx, homeAssigned: true };
  if (!ctx.cwdChanged && /(^|[^\w.-])(cd|pushd|popd)\b|\s-(execdir|okdir)\b|\s--chdir\b|\benv\b[^;&|\n]*\s-[A-Za-z]*C/.test(cmd)) ctx = { ...ctx, cwdChanged: true };
  // heredocs: keep the header, drop the body so its lines are not parsed as commands. The newline
  // after the closing delimiter stays: without it the next line was read as the header's arguments.
  // Each body is kept by its number, which takes the delimiter's place after its own `<<`, so the body
  // is the stdin of the command that opens it (Marie on #124: `bash < x.sh <<'E' | cat`).
  let text = cmd;
  const bodies: string[] = [];
  for (let h = nextHeredoc(text, 0); h; h = nextHeredoc(text, h.start + 1)) {
    if (!h.quoted) for (const body of bodySubstitutions(h.body)) checkCommand(body, ctx);
    const header = `<< HEREDOC${bodies.push(h.body) - 1}${h.rest}`;
    text = text.slice(0, h.start) + header + "\n" + text.slice(h.end);
  }
  // What a pipe carries: in each scope from the line inward, what was printed there since its last cut,
  // up to where the next scope inward opened (a group's stdin is what was piped into it).
  const said: string[] = [];
  const opened = new Map<number, number>([[0, 0]]);
  const cut = new Map<number, number>([[0, 0]]);
  for (const simple of simpleCommands(tokenize(text), bodies)) {
    const path = simple.scope ?? [0];
    for (const id of simple.cuts ?? []) cut.set(id, said.length);
    for (const id of path) if (!opened.has(id)) [opened, cut].forEach((m) => m.set(id, said.length));
    if (simple.piped) simple.upstream = path.flatMap((id, k) => said.slice(cut.get(id) ?? 0, k + 1 < path.length ? opened.get(path[k + 1] as number) : said.length));
    const printed = printedText(stripPrefixes(simple.words));
    if (printed !== null) said.push(printed);
    checkSecrets({ ...simple, words: stripPrefixes(simple.words) });
    if (ctx.policy === "readonly") checkReadonly(simple, ctx);
    else checkProtect(simple, ctx);
  }
}

// The reason a command is refused, or null when it may run. Anything unexpected refuses.
export function verdict(cmd: string, ctx: GuardContext): string | null {
  startLookups();
  try {
    checkCommand(cmd, ctx);
    return null;
  } catch (e) {
    return e instanceof Refused ? e.message : `the guard failed (${(e as Error).message})`;
  }
}

function context(argv: string[], workspace: string | undefined): GuardContext {
  const { values } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: {
      "role": { type: "string" }, "policy": { type: "string" }, "write-dir": { type: "string", multiple: true },
      "org": { type: "string" }, "own-repo": { type: "string", multiple: true }, "allow-close": { type: "string" },
      "lead-merge": { type: "string", multiple: true },
    },
  });
  if (!values.role) throw new Error("--role is missing");
  if (!(POLICIES as readonly string[]).includes(values.policy ?? "")) throw new Error(`--policy must be one of ${POLICIES.join(", ")}`);
  return { role: values.role, policy: values.policy as Policy, writeDirs: values["write-dir"] ?? [], org: values.org, ownRepos: values["own-repo"] ?? [],
    leadMerges: values["lead-merge"] ?? [], allowClose: values["allow-close"], workspace };
}

export function hook(argv: string[], input: string, workspace?: string): HookResult {
  let ctx: GuardContext;
  try {
    ctx = context(argv, workspace);
  } catch (e) {
    return { code: 2, stderr: `guard: refused. ${(e as Error).message}. The session's settings were rendered wrong, so every command is refused until it is relaunched.\n` };
  }
  const refused = (reason: string, cmd: string): HookResult =>
    ({ code: 2, stderr: `guard[${ctx.role}]: refused. ${reason}\nCommand: ${chars(cmd).slice(0, 300).join("")}\n` });
  let call: { tool_name?: unknown; tool_input?: Record<string, unknown> };
  try {
    call = JSON.parse(input) as typeof call;
  } catch {
    return refused("hook input was not the expected JSON", "");
  }
  const tin = call.tool_input ?? {};
  const str = (k: string) => (typeof tin[k] === "string" ? (tin[k] as string) : "");
  // Read prints the file; Grep prints matching lines only in content mode.
  if (call.tool_name === "Read") {
    const f = str("file_path");
    return secretFile(f) ? refused(`${f} holds secrets; check a key is set with \`grep -q '^KEY=' ${f} && echo set\``, f) : { code: 0 };
  }
  if (call.tool_name === "Grep") {
    const target = [str("path"), str("glob")].find((x) => x && namesSecret(x));
    return target && str("output_mode") === "content"
      ? refused(`${target} holds secrets; Grep may list or count matches there, not print them`, target) : { code: 0 };
  }
  if (typeof call.tool_name === "string" && call.tool_name.startsWith("mcp__")) {
    const reason = mcpVerdict(call.tool_name, tin, ctx);
    return reason === null ? { code: 0 } : refused(reason, call.tool_name);
  }
  const cmd = tin.command ?? "";
  if (typeof cmd !== "string" || !cmd.trim()) return { code: 0 };
  const reason = verdict(cmd, ctx);
  return reason === null ? { code: 0 } : refused(reason, cmd);
}
