import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentOrDie } from "../src/fleet.js";
import { designerPrompt, launchArgs, settingsFile } from "../src/launch.js";
import { editDenyRules, templateNames, TEMPLATES_DIR } from "../src/settings.js";
import { openWorkspace } from "../src/workspace.js";
import { factory, TOML, tempDir, tempWorkspace } from "./helpers.js";

const DESIGN_TOML = TOML + `
[roles.designer]
cwd = "designers"
model = "opus"
effort = "high"
autocompact = "1M"
permission_mode = "auto"
settings = "designer"
mcp_config = "settings/mcp.json"
add_dirs = ["web", "api"]

[[agents]]
name = "dee"
role = "designer"
remote_control = true
`;

const CANVAS = "https://claude.ai/artifact/canvas1";
const SLIDES = "https://claude.ai/artifact/slides1";

// A UI ticket with no design: designed, sent back once, approved in the human's words, then built.
test("design walk", () => {
  const ws = tempWorkspace(DESIGN_TOML);
  after(() => rmSync(ws, { recursive: true, force: true }));
  const T = "TEST-7";
  const failures: string[] = [];
  const ok = (...args: string[]) => {
    const r = factory(ws, args);
    if (r.status !== 0) failures.push(`expected ok: ${args.join(" ")}\n${r.stderr}`);
    return r;
  };
  const no = (...args: string[]) => {
    const r = factory(ws, args);
    if (r.status === 0) failures.push(`expected refusal: ${args.join(" ")}`);
    return r;
  };

  ok("state", T, "queued");
  let r = ok("state", T, "designing", "--agent", "dee");
  assert.match(r.stdout, /queued -> designing .* jira should read: In Progress/);
  no("state", T, "design-review");
  no("state", T, "design-review", "--canvas", CANVAS);
  no("state", T, "design-review", "--canvas", "not a url", "--slides", SLIDES);
  ok("state", T, "design-review", "--canvas", CANVAS, "--slides", SLIDES);
  no("state", T, "building");
  r = no("state", T, "queued");
  assert.match(r.stderr, /pass --approved "<Alex's words>"/);
  ok("state", T, "designing", "--note", "Alex: show the empty state too");
  ok("state", T, "design-review", "--slides", "https://claude.ai/artifact/slides2");
  no("state", T, "designing", "--approved", "looks good");
  ok("state", T, "queued", "--approved", "Approved, build it");
  r = ok("state", T);
  assert.match(r.stdout, /design: slides https:\/\/claude\.ai\/artifact\/slides2 canvas https:\/\/claude\.ai\/artifact\/canvas1 approved: Approved, build it/);
  ok("state", T, "building", "--agent", "bea");
  assert.deepEqual(failures, []);

  const rec = JSON.parse(readFileSync(join(ws, "state", `${T}.json`), "utf8"));
  assert.equal(rec.jira, "In Progress", "Jira reads In Progress from the moment the design starts, and nothing else moves it");
  assert.equal(rec.design.canvas, CANVAS);
  assert.equal(rec.design.slides, "https://claude.ai/artifact/slides2");
  assert.equal(rec.design.approved, "Approved, build it");
  const events = readFileSync(join(ws, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const approval = events.find((e) => e.from === "design-review" && e.to === "queued");
  assert.equal(approval.evidence, "Approved, build it");
  assert.equal(approval.design.approved, "Approved, build it");

  // designing again forgets the approval: it was for another drawing
  const U = "TEST-8";
  ok("state", U, "designing", "--agent", "dee");
  ok("state", U, "design-review", "--canvas", CANVAS, "--slides", SLIDES);
  ok("state", U, "queued", "--approved", "yes");
  ok("state", U, "designing");
  assert.equal(JSON.parse(readFileSync(join(ws, "state", `${U}.json`), "utf8")).design.approved, null);
  assert.deepEqual(failures, []);
});

test("a designer is dispatched without a repo, and a builder is refused a ticket in design", () => {
  const ws = tempWorkspace(DESIGN_TOML);
  after(() => rmSync(ws, { recursive: true, force: true }));
  factory(ws, ["state", "TEST-9", "designing", "--agent", "dee"]);
  let r = factory(ws, ["dispatch", "dee", "TEST-9", "--repo", "web"]);
  assert.match(r.stderr, /a designer reads every repo and works in none, so it takes no --repo/);
  r = factory(ws, ["dispatch", "bea", "TEST-9"]);
  assert.match(r.stderr, /TEST-9 is designing; a dispatch makes no sense there/);
  factory(ws, ["state", "TEST-10", "queued"]);
  r = factory(ws, ["dispatch", "dee", "TEST-10"]);
  assert.match(r.stderr, /dee is recorded as designing TEST-9/);
  factory(ws, ["state", "TEST-11", "building", "--agent", "bea"]);
  r = factory(ws, ["dispatch", "dee", "TEST-11"]);
  assert.match(r.stderr, /TEST-11 is building; a design starts from queued/);
});

test("a designer launches in the shared cwd with the repos read-only and a browser", () => {
  const dir = tempWorkspace(DESIGN_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  const dee = agentOrDie(ws, "dee");
  assert.deepEqual(launchArgs(ws, dee, "P", null, undefined), [
    "--bg", "--settings", join(dir, "logs", "run", "settings-dee.json"),
    "--add-dir", join(dir, "repos", "web"), "--add-dir", join(dir, "repos", "api"), "--remote-control", "dee",
    "--mcp-config", join(dir, "settings", "mcp.json"),
    "--name", "dee", "--model", "opus", "--effort", "high", "--autocompact", "1M", "--permission-mode", "auto", "P",
  ]);
  assert.match(designerPrompt(ws, dee, "TEST-1"), /^You are Dee, one of Ada's designers\. Your work item is TEST-1\..*wait for Ada's design brief/);
});

test("the designer's settings: edits only in its work dir, the guard's redirects there too", () => {
  const dir = tempWorkspace(DESIGN_TOML);
  after(() => rmSync(dir, { recursive: true, force: true }));
  for (const d of ["designers", "lead", "repos/web", "repos/api"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "designers", "CLAUDE.md"), "brief");
  const ws = openWorkspace(dir, {});
  const work = join(dir, "designers", "work");
  const r = JSON.parse(readFileSync(settingsFile(ws, agentOrDie(ws, "dee")), "utf8"));
  assert.ok(existsSync(work), "the render makes the work dir");
  const deny: string[] = r.permissions.deny;
  const allow: string[] = r.permissions.allow;
  assert.ok(allow.includes(`Edit(/${work}/**)`));
  assert.ok(allow.includes("Artifact") && allow.includes("DesignSync"));
  assert.ok(!deny.includes(`Edit(/${dir}/**)`), "the workspace above the work dir cannot be denied whole");
  assert.ok(!deny.some((x) => x.startsWith(`Edit(/${work}`)));
  for (const p of [join(dir, "repos"), join(dir, "lead"), join(dir, "factory.toml"), join(dir, "designers", "CLAUDE.md")])
    assert.ok(deny.some((x) => x === `Edit(/${p}/**)` || x === `Edit(/${p})`), `${p} stays denied`);
  const guard = r.hooks.PreToolUse.find((e: { matcher?: string }) => e.matcher === "Bash|Read|Grep").hooks[0].command as string;
  assert.match(guard, /--role designer --policy readonly --write-dir \S*designers\/work/);
  assert.deepEqual(r.worktree, { bgIsolation: "none" }, "the work dir is in the factory's own checkout, where a background session may not edit until it isolates");
});

test("only the designer turns off the background-isolation guard", () => {
  for (const t of templateNames()) {
    const doc = JSON.parse(readFileSync(join(TEMPLATES_DIR, `${t}.json`), "utf8"));
    if (t !== "designer") assert.equal(doc.settings?.worktree, undefined, `${t} keeps the guard`);
  }
});

test("editDenyRules leaves only the kept path, and denies a root with nothing kept whole", () => {
  const root = tempDir();
  after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ["a/b/keep", "a/b/side", "a/c", "z"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "a", "f.txt"), "x");
  assert.deepEqual(editDenyRules([root]), [`Edit(/${root}/**)`]);
  assert.deepEqual(editDenyRules([root], join(root, "a", "b", "keep")), [
    `Edit(/${join(root, "a", "b", "side")}/**)`, `Edit(/${join(root, "a", "c")}/**)`, `Edit(/${join(root, "a", "f.txt")})`, `Edit(/${join(root, "z")}/**)`,
  ]);
});
