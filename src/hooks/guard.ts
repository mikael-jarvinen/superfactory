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
// cannot read is outside it: python/node/perl/ruby -c or -e, make, npm scripts, a script file. It
// stops habits and mistakes, not a session set on getting around it.
import { realpathSync } from "node:fs";
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
  // set by checkCommand when the command line names HOME other than as $HOME or ${HOME}: then a
  // $HOME/... command word may hold anything
  homeAssigned?: boolean;
  // set by checkCommand when the line changes directory, so a relative path cannot be resolved
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
  const abs = posix.resolve(process.cwd(), dir === "~" || dir.startsWith("~/") ? homedir() + dir.slice(1) : dir);
  try {
    return realpathSync(abs);
  } catch {
    return posix.normalize(abs);
  }
}
let trustedReal: Set<string> | undefined;
function trustedDir(dir: string): boolean {
  trustedReal ??= new Set([...TRUSTED_BIN_DIRS].map(resolveDir));
  return trustedReal.has(resolveDir(dir));
}
// the commands stripPrefixes reads as wrappers, and the ones it refuses
const WRAPPER_NAMES = new Set(["env", "nice", "setsid", "stdbuf", "flock", "timeout", "nohup"]);

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
  const text = cmd.replace(/\r/g, "\n").replace(/\n/g, " ; ");
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
    const subs: string[] = [];
    for (;;) {
      const c = next();
      if (state === " ") {
        if (c === "") break;
        if (SPACE.includes(c)) {
          if (tok || quoted) break;
          continue;
        }
        if (c === "\\") [esc, state] = ["a", "\\"];
        else if (PUNCT.includes(c)) [tok, state, op] = [c, "c", true];
        else if (c === "'" || c === '"') state = c;
        else [tok, state] = [c, "a"];
        continue;
      }
      if (state === "'" || state === '"') {
        quoted = true;
        if (c === "") refuse("cannot parse quoting (No closing quotation)");
        if (c === state) state = "a";
        else if (c === "\\" && state === '"') [esc, state] = [state, "\\"];
        else if (c === "(" && state === '"' && tok.endsWith("$") && escaped !== tok.length) {
          const body = sub();
          tok += `(${body})`;
          subs.push(body);
        } else tok += c;
        continue;
      }
      if (state === "\\") {
        if (c === "") refuse("cannot parse quoting (No escaped character)");
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
      if (c === "'" || c === '"') state = c;
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
  let piped = false;
  const outer: ({ cur: string[]; writes: string[]; reads: string[]; stdin: string[] } | null)[] = [];
  const flush = () => {
    if (cur.length || writes.length || reads.length) out.push({ words: cur, writes, reads, stdin, piped });
    [cur, writes, reads, stdin, piped] = [[], [], [], [], false];
  };
  const open = () => {
    outer.push({ cur, writes, reads, stdin });
    [cur, writes, reads, stdin] = [[], [], [], []];
  };
  for (let i = 0; i < flat.length; i++) {
    const { t, op, subs } = flat[i] as Tok;
    const paren = flat[i + 1]?.op === true && flat[i + 1]?.t === "(";
    for (const body of subs ?? []) if (!/^\(.*\)$/s.test(body)) out.push(...simpleCommands(tokenize(body), bodies)); // $((...)) is arithmetic
    if (op && (t === "<" || t === ">") && paren) {
      cur.push(`${t}(`);
      i++;
      open();
    } else if (op && t === "(") {
      flush();
      outer.push(null); // a subshell
    } else if (op && t === ")") {
      flush();
      const o = outer.pop();
      if (o) ({ cur, writes, reads, stdin } = o);
    } else if (op ? SEPARATORS.has(t) : t === "{" || t === "}") {
      flush();
      piped = t === "|" || t === "|&";
    } else if (op) {
      const target = flat[i + 1]?.t ?? "";
      if (cur.length && /^\d$/.test(cur[cur.length - 1] as string)) cur.pop();
      if (t.includes(">") && !(t === ">&" && /^(\d+|-)$/.test(target))) writes.push(target);
      if (t === "<" || t === "<>") reads.push(target);
      if (t === "<<<") stdin.push(target);
      if (t === "<<" && /^HEREDOC\d+$/.test(target)) stdin.push(bodies[Number(target.slice(7))] ?? "");
      i++;
    } else if (t.endsWith("$") && paren) {
      // `$(` or `X=$(`: what is inside is its own simple command, and a `$(` word stands for its output
      cur.push(t === "$" ? "$(" : t);
      i++;
      open();
    } else if (t.includes("`")) {
      refuse("backtick command substitution");
    } else {
      cur.push(t);
    }
  }
  flush();
  return out;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "!", "time"]);
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

// The subcommand and its arguments after global options. Blocks alias definitions and relocation.
function gitParts(words: string[], ctx: GuardContext): [string, string[]] {
  for (let i = 1; i < words.length;) {
    const w = words[i] as string;
    if (GIT_BARE_FLAGS.has(w)) {
      i++;
      continue;
    }
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
function mergedOnGitHub(repo: string, branch: string): boolean {
  const opts = { timeout: 15_000 };
  const base = run("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"], opts);
  if (base.status !== 0 || !base.stdout.trim()) return false;
  const cmp = run("gh", ["api", `repos/${repo}/compare/${base.stdout.trim()}...${branch}`, "--jq", ".ahead_by"], opts);
  return cmp.status === 0 && cmp.stdout.trim() === "0";
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
    if (a.input || branch.length !== 1 || !branch[0] || branch[0].startsWith("@") || /[$`]/.test(branch[0] as string) || protectedRef(branch[0] as string))
      refuse(`a contents write to ${repo} needs -f branch=<a feature branch>: without one it commits to the default branch`);
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
    if (protectedRef(str("branch")) && !own) refuse(`pushing to a protected branch (${str("branch")}) is not allowed`);
  } else if (!MCP_GITHUB_WRITES.has(name)) refuse(`${name} is a GitHub MCP write the guard does not know, so it is refused; use gh`);
  if (name === "update_pull_request") {
    if (tin.state === "closed") checkGhProtect(["gh", "pr", "close", n, "-R", repo], ctx);
    if (tin.draft === false) checkGhProtect(["gh", "pr", "ready", n, "-R", repo], ctx);
  }
  // the Issues API closes a PR by its number too, and the guard cannot tell an issue from a PR
  if (name === "issue_write" && tin.state === "closed") checkGhProtect(["gh", "pr", "close", String(tin.issue_number ?? ""), "-R", repo], ctx);
}

export function mcpVerdict(tool: string, tin: Record<string, unknown>, ctx: GuardContext): string | null {
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

function checkProtect({ words: raw, reads, stdin = [], piped = false }: Simple, ctx: GuardContext): void {
  let words = stripPrefixes(raw);
  // gh, git and the shells by path are read by their basename wherever they live, so ~/.local/bin/gh
  // is gh and /usr/lib/git-core/git is git, each checked as itself. Any other command by path is read
  // as itself (/usr/bin/env, /usr/bin/nice) from a dir that resolves to a system bin dir, and
  // anywhere else it is a project script, which runs (./scripts/env is not env). A command word from a
  // variable or a substitution could run anything, so it is refused (Marie and Niilo on #124:
  // `~/.local/bin/gh pr merge` and `$G pr merge` skipped every check).
  // A command word holding a variable is split by the shell, so `$G/x` runs whatever G holds: only
  // $HOME/ or ${HOME}/ before a plain path is read as that path, while the line leaves HOME alone
  // (Marie on #124 at e6b2e171: `$G/x` with G='/usr/bin/gh pr merge 1 #' merged).
  while (words.length && (words[0] as string).includes("/")) {
    let w = words[0] as string;
    if (/[$`]/.test(w)) {
      const home = /^\$(HOME|\{HOME\})(\/[^$`]*)$/.exec(w);
      if (!home || ctx.homeAssigned) refuse(`the command '${w}' runs whatever its variable holds, which the guard cannot check: run it by its path`);
      else w = `~${home[2]}`;
    }
    const b = posix.basename(w);
    const dir = posix.dirname(w);
    // a wrapper by a relative path after a cd may be the system one, so it is read as the wrapper
    const unknown = ctx.cwdChanged && !dir.startsWith("/") && !dir.startsWith("~") && (WRAPPER_NAMES.has(b) || REFUSED_WRAPPERS.has(b));
    if (!["gh", "git"].includes(b.toLowerCase()) && !SHELLS.has(b) && !unknown && !trustedDir(dir)) return;
    words = stripPrefixes([b, ...words.slice(1)]);
  }
  if (!words.length) return;
  if (/[$`]/.test(words[0] as string)) refuse(`the command '${words[0]}' runs whatever it holds, which the guard cannot check: run gh/git by name`);
  const name = (words[0] as string).toLowerCase();
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

// The body starts on the line after the one holding <<DELIM, whatever else is on that line.
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\1\s*(\n|$)/;

function checkCommand(cmd: string, ctx: GuardContext): void {
  if (!ctx.homeAssigned && /\bHOME\b/.test(cmd.replace(/\$\{?HOME\b/g, ""))) ctx = { ...ctx, homeAssigned: true };
  if (!ctx.cwdChanged && /(^|[^\w.-])(cd|pushd|popd)\b/.test(cmd)) ctx = { ...ctx, cwdChanged: true };
  // heredocs: keep the header, drop the body so its lines are not parsed as commands. The newline
  // after the closing delimiter stays: without it the next line was read as the header's arguments.
  // Each body is kept by its number, which takes the delimiter's place after its own `<<`, so the body
  // is the stdin of the command that opens it (Marie on #124: `bash < x.sh <<'E' | cat`).
  let text = cmd;
  const bodies: string[] = [];
  for (let m = HEREDOC.exec(text); m; m = HEREDOC.exec(text)) {
    const header = (m[0].split("\n", 1)[0] as string).replace(/^<<-?\s*['"]?\w+['"]?/, `<< HEREDOC${bodies.push(m[2] as string) - 1}`);
    text = text.slice(0, m.index) + header + "\n" + text.slice(m.index + m[0].length);
  }
  for (const simple of simpleCommands(tokenize(text), bodies)) {
    checkSecrets({ ...simple, words: stripPrefixes(simple.words) });
    if (ctx.policy === "readonly") checkReadonly(simple, ctx);
    else checkProtect(simple, ctx);
  }
}

// The reason a command is refused, or null when it may run. Anything unexpected refuses.
export function verdict(cmd: string, ctx: GuardContext): string | null {
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
