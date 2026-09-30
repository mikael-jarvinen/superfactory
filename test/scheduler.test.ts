import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { every, render } from "../src/scheduler/launchd.js";
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
  assert.deepEqual(out.map((r) => r.job.label), ["superfactory.ada.queue", "superfactory.ada.round", "superfactory.ada.up"]);
  for (const { path } of out) {
    assert.equal(path, join(ws.runDir, "launchd", `${out.find((r) => r.path === path)!.job.label}.plist`));
    if (process.platform === "darwin") assert.equal(spawnSync("plutil", ["-lint", path]).status, 0, `${path} is a valid plist`);
  }
  const [queue, round, up] = out.map((r) => readFileSync(r.path, "utf8")) as [string, string, string];
  assert.deepEqual(minutes(queue), [0, 20, 40]);
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
  assert.deepEqual(render(none, {}).map((r) => r.job.name), ["round", "up"], "no tracker, no queue watcher");
  assert.ok(!existsSync(join(ws.runDir, "launchd", "superfactory.ada.relay.plist")));
});
