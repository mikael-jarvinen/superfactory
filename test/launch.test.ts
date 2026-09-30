import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentOrDie } from "../src/fleet.js";
import { buildAppendix, buildingPrompt, launchArgs } from "../src/launch.js";
import { openWorkspace } from "../src/workspace.js";
import { tempDir, tempWorkspace } from "./helpers.js";

// The order is part of the contract: --add-dir is variadic, a builder's --settings follows its
// --remote-control while every other role's leads, and the prompt always comes last.
test("the claude --bg command line, flag by flag, for each role", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  const s = (f: string) => join(dir, "settings", f);
  const rendered = (name: string) => join(dir, "logs", "run", `settings-${name}.json`);
  const repo = (r: string) => join(dir, "repos", r);
  const fixed = (name: string, mode: string) =>
    ["--name", name, "--model", "opus", "--effort", "high", "--autocompact", "1M", "--permission-mode", mode];

  assert.deepEqual(launchArgs(ws, agentOrDie(ws, "ada"), "P", null, undefined), [
    "--bg", "--settings", rendered("ada"), "--remote-control", "ada", ...fixed("ada", "bypassPermissions"), "P",
  ]);
  assert.deepEqual(launchArgs(ws, agentOrDie(ws, "bea"), "P", "/tmp/a.md", "build"), [
    "--bg", "--add-dir", repo("web"), "--add-dir", repo("api"), "--remote-control", "bea",
    "--settings", rendered("bea"), "--mcp-config", s("mcp.json"), ...fixed("bea", "bypassPermissions"),
    "--append-system-prompt-file", "/tmp/a.md", "P",
  ]);
  assert.deepEqual(launchArgs(ws, agentOrDie(ws, "rae"), "P", null, undefined), [
    "--bg", "--settings", rendered("rae"), "--add-dir", repo("web"), "--add-dir", repo("api"),
    "--remote-control", "rae", ...fixed("rae", "auto"), "P",
  ]);
});

test("appendix: workspace files labelled relative, repo: files inside the checkout, missing refused", () => {
  const dir = tempWorkspace();
  const checkout = tempDir();
  after(() => [dir, checkout].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const ws = openWorkspace(dir, {});
  mkdirSync(join(dir, "briefs"));
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(dir, "briefs", "app.md"), "the brief\n\n");
  const bea = agentOrDie(ws, "bea");
  assert.throws(() => buildAppendix(ws, bea, checkout), /appendix file .*AGENTS.md is missing or empty/);
  writeFileSync(join(checkout, "AGENTS.md"), "repo rules");
  const path = buildAppendix(ws, bea, checkout) as string;
  after(() => rmSync(path, { force: true }));
  assert.equal(readFileSync(path, "utf8"),
    `<!-- briefs/app.md -->\nthe brief\n\n\n<!-- ${join(checkout, "AGENTS.md")} -->\nrepo rules\n`);
});

test("the READY prompt names the lead from config and keeps a LOCAL key off GitHub", () => {
  const dir = tempWorkspace();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = openWorkspace(dir, {});
  const p = buildingPrompt(ws, agentOrDie(ws, "bea"), "LOCAL-fix-db");
  assert.match(p, /^You are Bea\. Your work item is LOCAL-fix-db\. .* on branch fix-db\. .*wait for Ada's brief\./);
  assert.match(p, /leave it out of the PR title and the commit message/);
  assert.doesNotMatch(buildingPrompt(ws, agentOrDie(ws, "bea"), "WEB-12"), /leave it out/);
});
