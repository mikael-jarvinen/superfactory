import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/util.js";
import { type ClaudeRun, runFailure, TIMED_OUT, watcherGh } from "../src/watchers/job.js";
import { factory, TOML, tempWorkspace } from "./helpers.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.js", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("./fake-gh.js", import.meta.url));
const PROMPTS = fileURLToPath(new URL("../../examples/prompts/", import.meta.url));
const SEARCH = "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql";
const JQL = 'assignee = currentUser() AND statusCategory = "To Do"';
const MERGED = "number,title,url,mergedAt,headRefName";

const JIRA = TOML.replace('kind = "jira"', `kind = "jira"\nsite = "example.atlassian.net"\nqueue_jql = '${JQL}'`);

interface Call {
  args: string[];
  prompt: string;
}

// A workspace with the example prompts, and a claude, gh and launchctl that are all fakes.
function watcherWorkspace(toml = JIRA) {
  const ws = tempWorkspace(toml);
  after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(join(ws, "prompts"));
  for (const f of readdirSync(PROMPTS)) copyFileSync(join(PROMPTS, f), join(ws, "prompts", f));
  const bin = join(ws, "bin");
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("claude", `exec "${process.execPath}" "${FAKE_CLAUDE}" "$@"`);
  script("gh", `exec "${process.execPath}" "${FAKE_GH}" "$@"`);
  script("launchctl", `printf 'PID\\tStatus\\tLabel\\n'`);
  const f = (name: string) => join(ws, name);
  const run = (args: string[], replies: { stdout?: string; status?: number }[], routes: Record<string, unknown> = {}) => {
    writeFileSync(f("replies.json"), JSON.stringify(replies));
    rmSync(f("replies.json.count"), { force: true });
    writeFileSync(f("claude.log"), "");
    writeFileSync(f("routes.json"), JSON.stringify(routes));
    writeFileSync(f("gh.log"), "");
    const res = factory(ws, args, {
      env: {
        PATH: `${bin}:${process.env.PATH}`, GH_BIN: "", DOCKER_BIN: "", LAUNCHCTL_BIN: join(bin, "launchctl"),
        FAKE_CLAUDE_REPLIES: f("replies.json"), FAKE_CLAUDE_LOG: f("claude.log"), FAKE_GH_ROUTES: f("routes.json"), FAKE_GH_LOG: f("gh.log"),
      },
    });
    const calls = readFileSync(f("claude.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
    return { ...res, calls };
  };
  const logs = (name: string) => join(ws, "logs", name);
  const read = (name: string) => (existsSync(logs(name)) ? readFileSync(logs(name), "utf8") : "");
  // Back-dates a heartbeat, so a run that rewrote it shows.
  const age = (name: string) => {
    const old = new Date(Date.now() - 3600_000);
    utimesSync(logs(name), old, old);
    return statSync(logs(name)).mtimeMs;
  };
  return { ws, run, logs, read, age };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

// The subtle part: a heartbeat means the tracker was read, so it needs a QUEUE line as evidence.
// An outage, a run that answered in prose, a sentinel after a QUEUE line and a failed run all leave
// the last healthy run's heartbeat as it was.
test("the queue heartbeat is written only on evidence that the tracker was read", () => {
  const { run, logs, read, age } = watcherWorkspace();

  let r = run(["watch", "queue"], [{ stdout: "QUEUE:\n" }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(logs("queue.heartbeat")), "a read writes the heartbeat");
  assert.equal(r.calls.length, 1, "nothing new, so no courier");
  const [reader] = r.calls as [Call];
  assert.equal(flag(reader.args, "--allowedTools"), `ToolSearch,${SEARCH},mcp__claude_ai_Atlassian__getJiraIssue`, "the reader runs no commands and messages nobody");
  assert.ok(reader.prompt.includes("You are the queue watcher") && reader.prompt.includes("cloudId example.atlassian.net") && reader.prompt.includes(JQL));
  assert.ok(!reader.prompt.includes("{lead}"), "placeholders are filled in");

  const cases: [string, { stdout?: string; status?: number }, number, string | null][] = [
    ["the sentinel", { stdout: "The search tool was not found.\n\nTRACKER-UNAVAILABLE\n" }, 0, null],
    ["prose instead of the contract", { stdout: "The tracker looks unreachable today, so I stopped.\n" }, 1, "queue READ NOTHING"],
    ["a QUEUE line with the sentinel after it", { stdout: "QUEUE: WEB-1\nTRACKER-UNAVAILABLE\n" }, 0, null],
    ["a failed run", { stdout: "QUEUE: WEB-1\n", status: 1 }, 1, "queue FAILED exit=1"],
  ];
  for (const [what, reply, status, logged] of cases) {
    const before = age("queue.heartbeat");
    const failures = read("watcher-failures.log");
    r = run(["watch", "queue"], [reply]);
    assert.equal(r.status, status, `${what}: ${r.stdout}${r.stderr}`);
    assert.equal(statSync(logs("queue.heartbeat")).mtimeMs, before, `${what} leaves the heartbeat alone`);
    const added = read("watcher-failures.log").slice(failures.length);
    if (logged) assert.match(added, new RegExp(logged), what);
    else assert.equal(added, "", `${what} is an outage the round reports, not a failure`);
  }
  const state = JSON.parse(read("queue.state")) as { outcomes: string[]; known: string[] };
  assert.deepEqual(state.outcomes, ["quiet", "unavailable", "off-contract", "unavailable", "failed"]);
  assert.deepEqual(state.known, [], "a run that did not read the queue keeps what the last read saw");
});

test("the queue says what is new once, and says it again when the courier failed", () => {
  const { ws, run, read } = watcherWorkspace();
  for (const [key, to] of [["WEB-2", "building"], ["WEB-3", "queued"]] as const) assert.equal(factory(ws, ["state", key, to]).status, 0);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const pr = (n: number, branch: string, min: number) => ({ number: n, title: "Change", headRefName: branch, mergedAt: ago(min), url: `https://github.com/acme/web/pull/${n}` });
  const routes = {
    [`pr list -R acme/web --state merged --limit 10 --json ${MERGED}`]: { stdout: [pr(12, "WEB-2-fix", 10), pr(11, "WEB-2-old", 300), pr(13, "OTHER-9", 5)] },
    [`pr list -R acme/api --state merged --limit 10 --json ${MERGED}`]: { stdout: [] },
  };
  const reader = { stdout: "TICKET: WEB-2 Fix login\nTICKET: WEB-3 Add the export\nTICKET: WEB-4 Retire the old page\nQUEUE: WEB-2 WEB-3 WEB-4\n" };
  const news = "[queue watcher]\nqueued: WEB-3 Add the export\nqueued: WEB-4 Retire the old page\nmerged: WEB-2 web#12 https://github.com/acme/web/pull/12";

  let r = run(["watch", "queue"], [reader, { status: 1 }], routes);
  assert.equal(r.status, 1, "a courier that failed fails the run");
  assert.equal(r.calls.length, 2);
  assert.match(read("watcher-failures.log"), /relay FAILED exit=1/);
  let state = JSON.parse(read("queue.state")) as { known: string[]; merged: string[] };
  assert.deepEqual(state, { ...state, known: ["WEB-2"], merged: [] }, "what was not delivered is not recorded as told");

  r = run(["watch", "queue"], [reader, { stdout: "" }], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const courier = r.calls[1] as Call;
  assert.ok(courier.prompt.includes(`---\n${news}\n---`), `the courier carries the lines untouched:\n${courier.prompt}`);
  assert.ok(courier.prompt.includes("the agent named ada"));
  assert.equal(flag(courier.args, "--model"), "haiku");
  assert.equal(flag(courier.args, "--allowedTools"), "SendMessage,ListAgents");
  state = JSON.parse(read("queue.state"));
  assert.deepEqual([state.known, state.merged], [["WEB-2", "WEB-3", "WEB-4"], ["https://github.com/acme/web/pull/12"]]);

  // The card carries the tracker summary as its title, stamped the moment the ticket is seen: an
  // existing queued record gets it set, a ticket with no record gets a titled queued one, and a
  // ticket already past queued is left as it is.
  const title = (k: string) => (JSON.parse(readFileSync(join(ws, "state", `${k}.json`), "utf8")) as { state: string; title?: string });
  assert.equal(title("WEB-3").title, "Add the export");
  assert.deepEqual([title("WEB-4").state, title("WEB-4").title], ["queued", "Retire the old page"]);
  assert.equal(title("WEB-2").title, undefined, "a ticket already building is not touched");

  r = run(["watch", "queue"], [reader], routes);
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 1, "nothing is new the third time, so no courier");
});

test("a recorded PR's merge is reported when no listing of the newest PRs reaches it", () => {
  const { ws, run, read } = watcherWorkspace();
  for (const [to, extra] of [["building", []], ["pr-open", ["--pr", "acme/web#7", "--head", "abc1234"]]] as const)
    assert.equal(factory(ws, ["state", "WEB-2", to, ...extra]).status, 0);
  // In review for a day, then merged five hours ago, which the name-matched window would drop too.
  const file = join(ws, "state", "WEB-2.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), since: new Date(Date.now() - 24 * 3600_000).toISOString() }));
  const view = { number: 7, title: "Change", headRefName: "WEB-2", state: "MERGED", isDraft: false, mergedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), headRefOid: "abc1234", url: "https://github.com/acme/web/pull/7" };
  const routes = { "pr list": { stdout: [] }, "pr view 7 -R acme/web": { stdout: view } };

  let r = run(["watch", "queue"], [{ stdout: "QUEUE:\n" }, { stdout: "" }], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^merged: WEB-2 web#7 https:\/\/github\.com\/acme\/web\/pull\/7$/m);
  assert.deepEqual((JSON.parse(read("queue.state")) as { merged: string[] }).merged, ["https://github.com/acme/web/pull/7"]);
  r = run(["watch", "queue"], [{ stdout: "QUEUE:\n" }], routes);
  assert.doesNotMatch(r.stdout, /merged:/, "reported once");

  r = run(["watch", "round", "--facts"], [], routes);
  assert.match(r.stdout, /WEB-2: acme\/web#7 is MERGED but the store says pr-open -- done judgement owed/);
});

test("the round: a merge the record moved after is judged, one it did not is owed", () => {
  const { ws, run } = watcherWorkspace();
  assert.equal(factory(ws, ["state", "WEB-2", "queued"]).status, 0);
  const merged = (n: number, at: string) => ({ number: n, title: "WEB-2: part", headRefName: "WEB-2", state: "MERGED", isDraft: false, mergedAt: at, headRefOid: "abc1234" });
  const before = new Date(Date.now() - 3600_000).toISOString();
  const after = new Date(Date.now() + 3600_000).toISOString();
  const r = run(["watch", "round", "--facts"], [], {
    "pr list -R acme/web --state all": { stdout: [merged(5, before), merged(6, after)] },
    "pr list -R acme/api --state all": { stdout: [] },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /acme\/web#5 is MERGED/);
  assert.match(r.stdout, /WEB-2: acme\/web#6 is MERGED but the store says queued -- done judgement owed/);
});

// Mikael, 2026-10-16: a PR is a draft in every column but colleague review, and open there. After
// colleague review it stays open through the fix rounds (2026-10-15).
test("the round: a PR open outside colleague review, or a draft in it, is flagged", () => {
  const { ws, run } = watcherWorkspace();
  const state = (...a: string[]) => assert.equal(factory(ws, ["state", ...a]).status, 0, a.join(" "));
  state("WEB-2", "building");
  state("WEB-2", "pr-open", "--pr", "acme/web#2", "--head", "aaa2222");
  state("WEB-3", "building");
  state("WEB-3", "pr-open", "--pr", "acme/web#3", "--head", "aaa3333");
  state("WEB-3", "your-review", "--reviewed", "aaa3333", "--force");
  state("WEB-4", "building");
  state("WEB-4", "colleague-review", "--force");
  state("WEB-4", "fixing");
  state("WEB-5", "building");
  state("WEB-5", "colleague-review", "--force");
  state("WEB-6", "building");
  state("WEB-6", "pr-open", "--pr", "acme/web#6", "--head", "aaa6666");
  state("WEB-7", "building");
  state("WEB-7", "colleague-review", "--force");
  const pr = (n: number, isDraft: boolean, baseRefName = "main") =>
    ({ number: n, title: `WEB-${n}: x`, headRefName: `WEB-${n}`, state: "OPEN", isDraft, mergedAt: null, headRefOid: `aaa${String(n).repeat(4)}`, baseRefName });
  const r = run(["watch", "round", "--facts"], [], {
    "pr list -R acme/web --state all": { stdout: [pr(2, false), pr(3, false), pr(4, false), pr(5, true), pr(6, true), pr(7, true, "WEB-5")] },
    "pr list -R acme/api --state all": { stdout: [] },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WEB-2: acme\/web#2 is open while pr-open -- should be a draft until colleague review/);
  assert.match(r.stdout, /WEB-3: acme\/web#3 is open while your-review -- should be a draft until colleague review/);
  assert.doesNotMatch(r.stdout, /WEB-4: /, "open in a fix round after colleague review");
  assert.match(r.stdout, /WEB-5: acme\/web#5 is a draft while colleague-review -- should be open: factory pr-open-for-review WEB-5/);
  assert.doesNotMatch(r.stdout, /WEB-6: /, "a draft before colleague review");
  assert.doesNotMatch(r.stdout, /WEB-7: /, "a draft stacked on another PR's branch keeps its draft");
});

test("the round: flags said once, the failures cursor, and its heartbeat", () => {
  const { ws, run, logs, read, age } = watcherWorkspace();
  assert.equal(factory(ws, ["state", "WEB-2", "building", "--agent", "bea"]).status, 0);
  const recFile = join(ws, "state", "WEB-2.json");
  const rec = JSON.parse(readFileSync(recFile, "utf8")) as Record<string, unknown>;
  writeFileSync(recFile, JSON.stringify({ ...rec, since: new Date(Date.now() - 2 * 3600_000).toISOString() }));
  mkdirSync(join(ws, "logs"), { recursive: true });
  writeFileSync(logs("watcher-failures.log"), "2026-01-01T00:00:00Z queue FAILED exit=1\n");
  const routes = { "pr list -R acme/web --state all": { stdout: [] }, "pr list -R acme/api --state all": { stdout: [] } };

  let r = run(["watch", "round", "--facts"], [], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.calls.length, 0, "--facts runs no session");
  assert.match(r.stdout, /WEB-2 .*OVER 90 MIN in a working state -- probe {2}NO SESSION: bea has no live session while building/);
  assert.match(r.stdout, /watcher failures since the last round --\n {2}2026-01-01T00:00:00Z queue FAILED exit=1/);
  assert.match(r.stdout, /launchd superfactory\.ada\.round NOT LOADED/);

  // A round whose tracker was down still saw the facts, so they are not news again; it writes no
  // heartbeat, because it did not read the tracker.
  // The outage itself goes to the lead by the courier, once, and again only when it is over.
  r = run(["watch", "round"], [{ stdout: "TRACKER-UNAVAILABLE\n" }], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(logs("round.heartbeat")));
  const prompt = (r.calls[0] as Call).prompt;
  assert.ok(prompt.includes("You are the round") && prompt.includes(SEARCH) && prompt.includes("OVER 90 MIN"));
  assert.equal(r.calls.length, 2);
  assert.match((r.calls[1] as Call).prompt, /\[round\]\ntracker UNAVAILABLE/);
  r = run(["watch", "round", "--facts"], [], routes);
  assert.match(r.stdout, /over 90 min \(already probed, not an escalation\)/);
  assert.match(r.stdout, /watcher failures since the last round --\n {2}none/);
  r = run(["watch", "round"], [{ stdout: "TRACKER-UNAVAILABLE\n" }], routes);
  assert.equal(r.calls.length, 1, "the same outage is not said twice");

  r = run(["watch", "round"], [{ stdout: "QUEUE: WEB-2\nQUIET\n" }, { stdout: "" }], routes);
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 2);
  assert.match((r.calls[1] as Call).prompt, /\[round\]\ntracker back/);
  const before = age("round.heartbeat");
  r = run(["watch", "round"], [{ stdout: "QUIET\n" }], routes);
  assert.equal(statSync(logs("round.heartbeat")).mtimeMs, before, "QUIET without a QUEUE line is not a read");
  assert.equal(r.calls.length, 1, "the outage is over, so nothing more is said about it");
  r = run(["watch", "round"], [{ status: 1 }], routes);
  assert.equal(r.status, 1);
  assert.equal(statSync(logs("round.heartbeat")).mtimeMs, before);
  assert.match(read("watcher-failures.log"), /round FAILED exit=1\n$/);
});

test("the round: a waiting item is not on the human, and its merged dependency is flagged", () => {
  const { ws, run } = watcherWorkspace();
  // WEB-9 is done; WEB-5 is open with PR #5; WEB-6 is open with PR #6, which has merged.
  assert.equal(factory(ws, ["state", "WEB-9", "queued"]).status, 0);
  const web9 = join(ws, "state", "WEB-9.json");
  writeFileSync(web9, JSON.stringify({ ...JSON.parse(readFileSync(web9, "utf8")), state: "done" }));
  for (const [k, n] of [["WEB-5", 5], ["WEB-6", 6]] as const)
    for (const args of [["building"], ["pr-open", "--pr", `acme/web#${n}`, "--head", "abc1234"]]) assert.equal(factory(ws, ["state", k, ...args]).status, 0);
  const old = new Date(Date.now() - 24 * 3600_000).toISOString();
  for (const [k, note] of [["WEB-1", "waits for WEB-9 to merge"], ["WEB-2", "waits for WEB-5 (#5) to merge"], ["WEB-3", "held behind web#6"]] as const) {
    assert.equal(factory(ws, ["state", k, "queued"]).status, 0);
    assert.equal(factory(ws, ["state", k, "waiting", "--note", note]).status, 0);
    const f = join(ws, "state", `${k}.json`);
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), since: old }));
  }
  const r = run(["watch", "round", "--facts"], [], {
    "pr list": { stdout: [] },
    "pr view 5 -R acme/web --json state": { stdout: { state: "OPEN" } },
    "pr view 6 -R acme/web --json state": { stdout: { state: "MERGED" } },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WEB-1 +waiting .*DEPENDENCY MERGED: WEB-9 -- WEB-1 can resume/);
  assert.match(r.stdout, /WEB-3 +waiting .*DEPENDENCY MERGED: web#6 -- WEB-3 can resume/);
  assert.match(r.stdout, /WEB-2 +waiting +\d+m .*pr=$/m, "a dependency still open is not flagged");
  assert.doesNotMatch(r.stdout, /waiting on Alex/, "a day of waiting on a merge is not waiting on the human");
});

test("the round: a blocked item whose named blocker has merged is flagged, once", () => {
  const { ws, run, read } = watcherWorkspace();
  // WEB-9 is merged (done); WEB-5 is still open. WEB-2 waits on WEB-9, WEB-3 waits on WEB-5.
  assert.equal(factory(ws, ["state", "WEB-9", "queued"]).status, 0);
  const web9 = join(ws, "state", "WEB-9.json");
  writeFileSync(web9, JSON.stringify({ ...JSON.parse(readFileSync(web9, "utf8")), state: "done" }));
  assert.equal(factory(ws, ["state", "WEB-5", "queued"]).status, 0);
  for (const [k, note] of [["WEB-2", "verify_site held behind WEB-9 merge"], ["WEB-3", "held behind WEB-5 merge"]] as const) {
    assert.equal(factory(ws, ["state", k, "queued"]).status, 0);
    assert.equal(factory(ws, ["state", k, "blocked", "--note", note]).status, 0);
  }
  const routes = { "pr list -R acme/web --state all": { stdout: [] }, "pr list -R acme/api --state all": { stdout: [] } };

  let r = run(["watch", "round", "--facts"], [], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WEB-2 .*BLOCKER DONE: WEB-9 merged -- WEB-2 may no longer be blocked/);
  assert.doesNotMatch(r.stdout, /WEB-3 .*BLOCKER DONE/, "a blocker that is still open is not flagged");

  // Said once: a real (non-facts) run commits the marker, after which the flag goes quiet.
  r = run(["watch", "round"], [{ stdout: "QUIET\n" }], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run(["watch", "round", "--facts"], [], routes);
  assert.doesNotMatch(r.stdout, /WEB-2 .*BLOCKER DONE/, "the cleared blocker is reported once, not every round");
});

test("the round: an item waiting on the lead over two hours is flagged, once", () => {
  const { ws, run } = watcherWorkspace();
  // WEB-2 has sat in pr-open for five days, WEB-3 for an hour.
  for (const [k, hours] of [["WEB-2", 5 * 24], ["WEB-3", 1]] as const) {
    assert.equal(factory(ws, ["state", k, "queued"]).status, 0);
    const f = join(ws, "state", `${k}.json`);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), state: "pr-open", since }));
  }
  const routes = { "pr list -R acme/web --state all": { stdout: [] }, "pr list -R acme/api --state all": { stdout: [] } };

  let r = run(["watch", "round", "--facts"], [], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WEB-2 .*pr-open .*waiting on the lead over 2 h -- report, review or gate it/);
  assert.doesNotMatch(r.stdout, /WEB-3 .*waiting on the lead/, "an hour in pr-open is not yet a wait");

  r = run(["watch", "round"], [{ stdout: "QUIET\n" }], routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run(["watch", "round", "--facts"], [], routes);
  assert.match(r.stdout, /WEB-2 .*waiting on the lead \(already reported, not an escalation\)/);
});

test("with no tracker there is no queue to watch, and the round needs no read", () => {
  const { run, logs } = watcherWorkspace(JIRA.replace('kind = "jira"', 'kind = "none"'));
  let r = run(["watch", "queue"], []);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no queue to watch/);
  assert.equal(r.calls.length, 0);
  r = run(["watch", "round"], [{ stdout: "QUIET\n" }], { "pr list": { stdout: [] } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(logs("round.heartbeat")));
  const prompt = (r.calls[0] as Call).prompt;
  assert.ok(prompt.includes("no tracker") && !prompt.includes(SEARCH) && !prompt.includes("queue heartbeat"));
});

// On 2026-10-20 every "exit=127" in the failures log was a claude run that launchd started in a
// seconds-long dark wake and the laptop's sleep froze past its timeout, not a missing binary.
test("a timeout is not a missing command, and a run the laptop slept through is not a failure", () => {
  assert.equal(run("sleep", ["5"], { timeout: 200 }).status, TIMED_OUT, "killed at its timeout: 124");
  assert.equal(run("/no/such/command", []).status, 127, "could not start: 127");

  const ran = (status: number, seconds: number, slept = false): ClaudeRun => ({ status, stdout: "", seconds, slept });
  assert.equal(runFailure("queue", ran(1, 30)), "queue FAILED exit=1");
  assert.equal(runFailure("round", ran(TIMED_OUT, 901)), "round TIMED OUT after 901s");
  assert.equal(runFailure("queue", ran(TIMED_OUT, 3604, true)), null, "the laptop slept: nothing for the failures log");
});

// On 2026-10-23 a queue run's `gh pr list` hung for 3h20m after the laptop slept mid-call, and
// launchd started no queue run while it was alive.
test("a watcher's gh call has a bound, and its timeout says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-hang-"));
  const hang = join(dir, "gh");
  writeFileSync(hang, "#!/bin/sh\nexec sleep 5\n");
  chmodSync(hang, 0o755);
  const was = process.env.GH_BIN;
  process.env.GH_BIN = hang;
  try {
    const r = watcherGh(["pr", "list", "-R", "o/r"], 0.2);
    assert.equal(r.status, TIMED_OUT, "killed at its bound: 124");
    assert.equal(r.stderr, "gh pr list timed out after 0s");
    assert.equal(r.slept, false);
  } finally {
    if (was === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = was;
    rmSync(dir, { recursive: true, force: true });
  }
});
