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
// no branch deletes on origin, no merging or undrafting through gh, no checkout of a protected
// branch.
//
// Why a parser and not regexes: a blocklist cannot enumerate a shell (`command git commit`, a
// newline before the command, `git -c x=y push origin main`, `git push origin CL-1:main`,
// `--mirror`, `find -delete`, `python3 -c "open(...,'w')"`). An allowlist of shapes can be read and
// audited; test/guard.test.ts is the contract.
import { posix } from "node:path";
import { parseArgs } from "node:util";
import type { HookResult } from "../settings.js";
import { chars } from "../util.js";

export const POLICIES = ["readonly", "protect"] as const;
export type Policy = (typeof POLICIES)[number];

export interface GuardContext {
  role: string;
  policy: Policy;
  writeDirs: string[];
}

export const PROTECTED = new Set(["main", "master", "staging", "production", "dev"]);
// Platform paths, not anyone's: macOS first, as the design says.
export const TMP_ROOTS = ["/tmp", "/private/tmp"];
const TRUSTED_BIN_DIRS = new Set(["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/opt/coreutils/libexec/gnubin"]);

class Refused extends Error {}

const refuse = (reason: string): never => {
  throw new Refused(reason);
};

// ---------------------------------------------------------------- tokenising

interface Tok {
  t: string;
  op: boolean;
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
  for (;;) {
    let tok = "";
    let quoted = false;
    let op = false;
    let state = " ";
    let esc = "a";
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
        else tok += c;
        continue;
      }
      if (state === "\\") {
        if (c === "") refuse("cannot parse quoting (No escaped character)");
        // inside double quotes only the quote and the backslash itself are escaped
        if (esc === '"' && c !== "\\" && c !== esc) tok += "\\";
        tok += c;
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
    out.push({ t: tok, op });
  }
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "|&", "(", ")", ";;"]);
// Longest first. A run such as ");" is two operators, not a word: read as one, `(ls); git commit`
// would be a single command named ls.
const OPS = ["&>>", ";;", "&&", "||", "|&", ">>", "<<", ">&", "<&", "<>", ">|", "&>", ";", "&", "|", "(", ")", "<", ">"];

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
}

// Simple commands with the files their redirects write. `2>` arrives as "2" then ">", and the
// bare fd is not a word. `>&1` duplicates a descriptor and writes no file.
function simpleCommands(toks: Tok[]): Simple[] {
  const flat = toks.flatMap((k) => (k.op ? splitOps(k.t).map((t) => ({ t, op: true })) : [k]));
  const out: Simple[] = [];
  let cur: string[] = [];
  let writes: string[] = [];
  const flush = () => {
    if (cur.length || writes.length) out.push({ words: cur, writes });
    cur = [];
    writes = [];
  };
  for (let i = 0; i < flat.length; i++) {
    const { t, op } = flat[i] as Tok;
    if (op ? SEPARATORS.has(t) : t === "{" || t === "}") {
      flush();
    } else if (op) {
      const target = flat[i + 1]?.t ?? "";
      if (cur.length && /^\d$/.test(cur[cur.length - 1] as string)) cur.pop();
      if (t.includes(">") && !(t === ">&" && /^(\d+|-)$/.test(target))) writes.push(target);
      i++;
    } else if (t === "$") {
      // the $ of $( ... ); what is inside is its own simple command
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

// Drop shell keywords, env assignments and wrappers so the real command name is first. A wrapper
// whose command cannot be read off the line is refused; timeout's command can, so it is checked.
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
      for (; j < words.length && ((words[j] as string).startsWith("-") || (words[j] as string).includes("=")); j++)
        if (!(words[j] as string).startsWith("-")) checkEnvName((words[j] as string).split("=", 1)[0] as string);
      words = words.slice(j);
    } else if (w === "timeout") {
      let j = 1;
      for (; j < words.length && (words[j] as string).startsWith("-"); j++) if (["-s", "-k", "--signal", "--kill-after"].includes(words[j] as string)) j++;
      words = words.slice(j + 1);
    } else if (REFUSED_WRAPPERS.has(w)) refuse(`'${w}' is not allowed in this session`);
    else return words;
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
    if (!pos.length || (pos.length === 1 && pos[0] === "origin") || ["--all", "--mirror", "--prune", "--tags"].some((f) => flags.includes(f)))
      refuse("push exactly one branch by name: git push -u origin <branch>");
    for (const f of flags) {
      if (f === "-d" || f === "--delete") refuse("deleting a remote branch is not allowed");
      if (f.startsWith("--force-with-lease=") || f.startsWith("--force-if-includes=")) refuse("--force-with-lease takes no value here; use bare --force-with-lease");
      if (f === "--force" || f === "-f" || (/^-[a-zA-Z]+$/.test(f) && f.slice(1).includes("f"))) refuse("force pushes need --force-with-lease, never --force or -f");
    }
    for (const a of pos[0] === "origin" ? pos.slice(1) : pos) {
      if (a.startsWith("+")) refuse("a + refspec is a force push; use --force-with-lease");
      if (a.includes(":") && a.split(":", 2)[1] === "") refuse("deleting a remote branch is not allowed");
      if (protectedRef(a)) refuse(`pushing to a protected branch (${a}) is not allowed`);
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

function checkGhProtect(words: string[]): void {
  const args = words.slice(1);
  if (args[0] === "pr" && ["merge", "close", "lock", "unlock"].includes(args[1] ?? "")) refuse("merging or closing a PR is the human's call");
  if (args[0] === "pr" && args[1] === "ready" && !args.includes("--undo")) refuse("undrafting is done by `factory pr-send` only; gh pr ready --undo is fine");
  if (args[0] === "api" && ghApiWrites(args.slice(1)) && /(pulls\/\d+\/merge|git\/refs|branches\/[^/]+\/protection)/.test(args.join(" ")))
    refuse("writing merges or refs through the API is not allowed");
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

function checkProtect({ words: raw }: Simple, ctx: GuardContext): void {
  let words = stripPrefixes(raw);
  if (!words.length) return;
  let name;
  try {
    [name, words] = cmdName(words);
  } catch (e) {
    if (e instanceof Refused) return; // builders may run project scripts by path
    throw e;
  }
  if (name === "git") return checkGitProtect(words, ctx);
  if (name === "gh") return checkGhProtect(words);
  // `bash -c '<script>'` is the script, checked like any other command line
  if (SHELLS.has(name)) {
    const i = words.findIndex((w, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    if (i > 0 && words[i + 1] !== undefined) checkCommand(words[i + 1] as string, ctx);
  }
}

// ---------------------------------------------------------------- the hook

const HEREDOC = /<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*(\n|$)/;

function checkCommand(cmd: string, ctx: GuardContext): void {
  // heredocs: keep the header, drop the body so its lines are not parsed as commands
  let text = cmd;
  for (let m = HEREDOC.exec(text); m; m = HEREDOC.exec(text))
    text = text.slice(0, m.index) + (m[0].split("\n", 1)[0] as string) + " HEREDOC " + text.slice(m.index + m[0].length);
  for (const s of simpleCommands(tokenize(text))) {
    const simple = { ...s, words: s.words.filter((w) => w !== "HEREDOC") };
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

function context(argv: string[]): GuardContext {
  const { values } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: { "role": { type: "string" }, "policy": { type: "string" }, "write-dir": { type: "string", multiple: true } },
  });
  if (!values.role) throw new Error("--role is missing");
  if (!(POLICIES as readonly string[]).includes(values.policy ?? "")) throw new Error(`--policy must be one of ${POLICIES.join(", ")}`);
  return { role: values.role, policy: values.policy as Policy, writeDirs: values["write-dir"] ?? [] };
}

export function hook(argv: string[], input: string): HookResult {
  let ctx: GuardContext;
  try {
    ctx = context(argv);
  } catch (e) {
    return { code: 2, stderr: `guard: refused. ${(e as Error).message}. The session's settings were rendered wrong, so every command is refused until it is relaunched.\n` };
  }
  const refused = (reason: string, cmd: string): HookResult =>
    ({ code: 2, stderr: `guard[${ctx.role}]: refused. ${reason}\nCommand: ${chars(cmd).slice(0, 300).join("")}\n` });
  let cmd: unknown;
  try {
    cmd = (JSON.parse(input) as { tool_input?: { command?: unknown } }).tool_input?.command ?? "";
  } catch {
    return refused("hook input was not the expected JSON", "");
  }
  if (typeof cmd !== "string" || !cmd.trim()) return { code: 0 };
  const reason = verdict(cmd, ctx);
  return reason === null ? { code: 0 } : refused(reason, cmd);
}
