import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scheduleFix } from "../src/scheduler/index.js";
import { every, render } from "../src/scheduler/launchd.js";
import { gatherFacts } from "../src/watchers/round.js";
import { FactoryError } from "../src/util.js";
import { openWorkspace } from "../src/workspace.js";
import { CLI, TOML, tempWorkspace } from "./helpers.js";

const workspace = (toml: string) => {
  const dir = tempWorkspace(toml);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return openWorkspace(dir, {});
};

const minutes = (xml: string) => [...xml.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));

// Rendering only: nothing here reaches launchctl.
test("the scheduler renders one plist per job from config, labelled by the lead", () => {
  const ws = workspace(TOML.replace('kind = "jira"', 'kind = "jira"\nsite = "example.atlassian.net"\nqueue_jql = "x"') +
    '\n[watchers]\nqueue_every_minutes = 20\nround_minute = 9\n');
  const out = render(ws, { PATH: "/one:/two", CLAUDE_BIN: "/opt/claude" });
  assert.deepEqual(out.map((r) => r.job.label), ["superfactory.ada.queue", "superfactory.ada.reviews", "superfactory.ada.round", "superfactory.ada.up"]);
  for (const { path } of out) {
    assert.equal(path, join(ws.runDir, "launchd", `${out.find((r) => r.path === path)!.job.label}.plist`));
    if (process.platform === "darwin") assert.equal(spawnSync("plutil", ["-lint", path]).status, 0, `${path} is a valid plist`);
  }
  const [queue, reviews, round, up] = out.map((r) => readFileSync(r.path, "utf8")) as [string, string, string, string];
  assert.deepEqual(minutes(queue), [0, 20, 40]);
  assert.deepEqual(minutes(reviews), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], "the review watcher runs no model, so every 5 minutes by default");
  assert.ok(reviews.includes("<string>watch</string>\n    <string>reviews</string>"));
  assert.deepEqual(minutes(round), [9]);
  assert.deepEqual(minutes(up), [3, 33]);
  assert.ok(queue.includes(`<string>${process.execPath}</string>\n    <string>${CLI}</string>\n    <string>--workspace</string>\n    <string>${ws.dir}</string>\n    <string>watch</string>\n    <string>queue</string>`));
  assert.match(queue, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(up, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(queue, /<key>PATH<\/key><string>\/one:\/two<\/string>/);
  assert.match(queue, /<key>CLAUDE_BIN<\/key><string>\/opt\/claude<\/string>/);
  assert.ok(queue.includes(`<key>FACTORY_WORKSPACE</key><string>${ws.dir}</string>`));
  assert.ok(queue.includes(`<key>StandardOutPath</key><string>${join(ws.logsDir, "launchd-queue.log")}</string>`));

  assert.deepEqual(every(120).map((c) => c.Hour), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  assert.throws(() => every(7), FactoryError, "a cadence that does not divide the hour cannot be a calendar job");

  const none = workspace(TOML.replace('kind = "jira"', 'kind = "none"'));
  assert.deepEqual(render(none, {}).map((r) => r.job.name), ["reviews", "round", "up"], "no tracker, no queue watcher");
  const off = workspace(`${TOML}\n[watchers]\nreviews_every_minutes = 0\n`);
  assert.ok(!render(off, {}).some((r) => r.job.name === "reviews"), "reviews_every_minutes = 0 turns the review watcher off");
  assert.ok(!existsSync(join(ws.runDir, "launchd", "superfactory.ada.relay.plist")));
});

// Marie on superfactory#119 (L1): a reviews job that has never run on Linux is a daemon started
// before config asked for it, which `factory schedule install` does not fix; a restart does.
test("a missing reviews heartbeat names the fix for this machine's scheduler", () => {
  assert.equal(scheduleFix("linux"), "systemctl --user restart factory-scheduler, which reads config again");
  assert.equal(scheduleFix("darwin"), "factory schedule install");
  const text = gatherFacts(workspace(TOML)).text;
  assert.ok(text.includes(`reviews heartbeat MISSING -- has it ever read GitHub? ${scheduleFix()}`), text);
});
