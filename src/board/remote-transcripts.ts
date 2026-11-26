// Another host's transcripts, for the board's analytics (analytics.ts). The sessions of an agent with
// a `host` write their transcripts on that machine, so the board asks it over ssh, as the factory's
// heartbeat already does: `ssh <dest> python3 -`, with the script below on stdin. Python, as the
// host's daemon runs node from its own install and a non-interactive ssh shell may not have it on
// PATH, while python3 is there.
//
// The script is given the cwds whose transcripts are wanted, the earliest time a call could count,
// and how far into each file the board has read already. For each cwd it lists the transcripts in
// that cwd's projects/ dir (and its realpath's), each with its subagents' under
// <session>/subagents/, leaving out any last written before that time, and it sends back each file's
// lines after its offset, up to the last whole line. Of those lines it keeps only what the board
// reads, the session name and each assistant call's id, time and usage, so the bulk of a transcript
// never crosses the network: for the weekly usage (weekly.ts) also each call's model and hour-long
// cache writes, and the reset a call the weekly limit refused named. A file shorter than its offset
// was rewritten, and is sent from its start. With `all`, every projects/ dir is listed too, under
// "*", and a file listed twice is sent once.
//
// Measured with 3.1 GB of transcripts, 3,834 files in the fleet's cwds: the first read takes 8 s and
// sends 38 MB, and each read after it 0.35 s, almost all of it the listing. The board reads in the
// background (server.ts), so neither holds up a request.
import { spawn } from "node:child_process";

export interface RemoteQuery {
  cwds: string[];
  since: number;
  offsets: Record<string, number>;
  // Also every projects/ dir, listed under "*", leaving out files last written before this time.
  all?: number;
}

export interface RemoteFile {
  p: string;
  subs: string[];
}

export interface RemoteRead {
  listing: Record<string, RemoteFile[]>;
  data: Record<string, { off: number; reset: boolean; lines: string[] }>;
}

// Runs the script on the host and resolves to what it printed.
export type Runner = (script: string) => Promise<string>;

export const PROBE = String.raw`
import base64, json, os, re, sys

def projects():
    return os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects")

def project(cwd):
    return os.path.join(projects(), re.sub(r"[^A-Za-z0-9]", "-", cwd))

MARK = "--sf-transcripts--"
KEEP = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")

def slim(line):
    if b'"agent-name"' not in line and not (b'"usage"' in line and b'"assistant"' in line):
        return None
    try:
        d = json.loads(line)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    if d.get("type") == "agent-name":
        name = d.get("agentName")
        return json.dumps({"type": "agent-name", "agentName": name}) if isinstance(name, str) else None
    m = d.get("message") if isinstance(d.get("message"), dict) else {}
    u = m.get("usage")
    if d.get("type") != "assistant" or not isinstance(u, dict):
        return None
    usage = {k: u[k] for k in KEEP if isinstance(u.get(k), (int, float)) and not isinstance(u.get(k), bool)}
    cc = u.get("cache_creation")
    if isinstance(cc, dict) and isinstance(cc.get("ephemeral_1h_input_tokens"), (int, float)):
        usage["cache_creation"] = {"ephemeral_1h_input_tokens": cc["ephemeral_1h_input_tokens"]}
    out = {"type": "assistant", "timestamp": d.get("timestamp"), "requestId": d.get("requestId"),
           "uuid": d.get("uuid"), "message": {"id": m.get("id"), "model": m.get("model"), "usage": usage}}
    q = d.get("quotaLimits")
    if isinstance(q, dict) and q.get("rateLimitType") == "seven_day":
        out["quotaLimits"] = {k: q.get(k) for k in ("rateLimitType", "status", "resetsAt")}
    return json.dumps(out, separators=(",", ":"))

def take(path, off, out):
    if path in out:
        return
    try:
        size = os.stat(path).st_size
    except OSError:
        return
    reset = size < off
    if reset:
        off = 0
    if size == off:
        return
    try:
        with open(path, "rb") as f:
            f.seek(off)
            data = f.read(size - off)
    except OSError:
        return
    end = data.rfind(b"\n") + 1
    lines = [s for s in (slim(raw) for raw in data[:end].split(b"\n")[:-1]) if s is not None]
    out[path] = {"off": off + end, "reset": reset, "lines": lines}

def fresh(p, since):
    try:
        return os.stat(p).st_mtime * 1000 >= since
    except OSError:
        return False

def files(d, since):
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return []
    got = []
    for n in names:
        p = os.path.join(d, n)
        if not n.endswith(".jsonl") or not fresh(p, since):
            continue
        sub = os.path.join(d, n[:-len(".jsonl")], "subagents")
        try:
            subs = [os.path.join(sub, s) for s in sorted(os.listdir(sub)) if s.endswith(".jsonl")]
        except OSError:
            subs = []
        got.append({"p": p, "subs": [s for s in subs if fresh(s, since)]})
    return got

def collect(dirs, since, offsets, data):
    seen = []
    for d in dirs:
        for f in files(d, since):
            seen.append(f)
            for p in [f["p"]] + f["subs"]:
                take(p, offsets.get(p, 0), data)
    return seen

def main(q):
    listing, data = {}, {}
    for cwd in q["cwds"]:
        dirs = dict.fromkeys([project(cwd), project(os.path.realpath(cwd))])
        listing[cwd] = collect(dirs, q["since"], q["offsets"], data)
    if q.get("all") is not None:
        try:
            dirs = [os.path.join(projects(), n) for n in sorted(os.listdir(projects()))]
        except OSError:
            dirs = []
        listing["*"] = collect(dirs, q["all"], q["offsets"], data)
    sys.stdout.write("\n" + MARK + "\n" + json.dumps({"listing": listing, "data": data}, separators=(",", ":")))
`;

// What a login shell prints on its own (a motd, an rc file's echo) comes before the script's
// reply, which starts after the script's marker line.
const MARK = "\n--sf-transcripts--\n";

export function parseReply(out: string): RemoteRead {
  const at = out.lastIndexOf(MARK);
  if (at < 0) throw new Error(`its reply is not the script's: ${JSON.stringify(out.slice(0, 200))}`);
  let r: RemoteRead;
  try {
    r = JSON.parse(out.slice(at + MARK.length)) as RemoteRead;
  } catch (e) {
    throw new Error(`its reply is not JSON (${(e as Error).message}): ${JSON.stringify(out.slice(at + MARK.length, at + MARK.length + 200))}`);
  }
  if (!r || typeof r.listing !== "object" || typeof r.data !== "object") throw new Error("its reply has no listing");
  return r;
}

// The script with its query, which goes in as base64 so no byte of a path can end the literal.
export const probeFor = (q: RemoteQuery): string =>
  `${PROBE}\nmain(json.loads(base64.b64decode("${Buffer.from(JSON.stringify(q)).toString("base64")}")))\n`;

export const READ_TIMEOUT_MS = 180_000;

// ssh in batch mode, so a missing key fails rather than prompts, and compressed, as the first read
// sends tens of megabytes of JSON. `dest` is config.ts's checked destination, never an option. The
// board runs as a service, with no ssh agent, so the key must be one ssh finds itself: an
// IdentityFile in ~/.ssh/config for the destination, or a default identity, with no passphrase.
export function sshRunner(dest: string, timeoutMs = READ_TIMEOUT_MS): Runner {
  return (script) =>
    new Promise((resolve, reject) => {
      if (!dest) return reject(new Error("it has no ssh destination; set hosts.<name>.ssh"));
      const p = spawn("ssh", ["-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", dest, "python3 -"], { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.stdout.on("data", (b: Buffer) => out.push(b));
      p.stderr.on("data", (b: Buffer) => (err = (err + b.toString("utf8")).slice(-2000)));
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
        else {
          const last = err.trim().split("\n").slice(-1)[0] ?? "";
          const hint = /permission denied|publickey/i.test(last) ? " (the board has no ssh agent: give the destination an IdentityFile with no passphrase in ~/.ssh/config)" : "";
          reject(new Error(`ssh ${dest} ${signal ? `was killed (${signal}) after ${timeoutMs / 1000} s` : `exited ${code}`}${last ? `: ${last}` : ""}${hint}`));
        }
      });
      p.stdin.on("error", () => {
        // the close handler says why
      });
      p.stdin.end(script);
    });
}
