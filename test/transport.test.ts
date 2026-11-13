import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentOrDie, findSession, type Session } from "../src/fleet.js";
import { agentSessions, local, pick, type Transport } from "../src/transport.js";
import { openWorkspace } from "../src/workspace.js";
import { tempDir, tempWorkspace } from "./helpers.js";

test("the local start writes the appendix it is given and names it on the command line", () => {
  const dir = tempDir();
  after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  writeFileSync(claude, `#!/bin/sh
prev=
for a in "$@"; do [ "$prev" = --append-system-prompt-file ] && cat "$a" > "${dir}/appendix"; prev=$a; done
echo "$@" > "${dir}/args"
echo "backgrounded · abc123 · rae"
`);
  chmodSync(claude, 0o755);
  const was = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = claude;
  after(() => (was === undefined ? delete process.env.CLAUDE_BIN : (process.env.CLAUDE_BIN = was)));
  const ws = openWorkspace(tempWorkspace(), {});
  after(() => rmSync(ws.dir, { recursive: true, force: true }));
  const req = { agent: agentOrDie(ws, "bea"), cwd: dir, prompt: "P", phase: undefined, env: process.env };
  const args = (p: string | null) => ["--bg", ...(p ? ["--append-system-prompt-file", p] : []), "P"];

  assert.equal(local.start({ ...req, appendix: "the brief\n", args }), "abc123");
  assert.equal(readFileSync(join(dir, "appendix"), "utf8"), "the brief\n");
  rmSync(readFileSync(join(dir, "args"), "utf8").split(" ")[2] as string);
  rmSync(join(dir, "appendix"));
  local.start({ ...req, appendix: null, args });
  assert.equal(readFileSync(join(dir, "args"), "utf8"), "--bg P\n");
});

test("an agent's session is its newest live one, else its newest, and only its background ones count", () => {
  const ws = openWorkspace(tempWorkspace(), {});
  after(() => rmSync(ws.dir, { recursive: true, force: true }));
  const row = (id: string, state: string, extra: Partial<Session> = {}) => ({ id, name: "bea", kind: "background", state, ...extra }) as Session;
  const listed = [row("a", "stopped"), row("b", "running"), row("c", "running", { kind: "interactive" }), row("d", "running", { name: "ada" })];
  const bea = agentSessions(ws, (where) => (where === "local" ? listed : undefined)).find((x) => x.agent.name === "bea");
  assert.deepEqual(bea?.hits.map((s) => s.id), ["a", "b"]);
  const t = { alive: (s: Session | null | undefined) => s?.state === "running" } as Transport;
  assert.equal(pick(t, bea?.hits ?? [])?.id, "b");
  assert.equal(pick(t, [row("a", "stopped"), row("e", "failed")])?.id, "a");
  assert.equal(pick(t, []), null);
  // newest by updatedAt, else startedAt, else createdAt, whatever order the listing has
  const old = row("old", "failed", { updatedAt: "2026-11-06T10:00:00Z" });
  const recent = row("new", "failed", { startedAt: "2026-11-13T10:00:00Z" });
  assert.equal(pick(t, [old, recent])?.id, "new");
  assert.equal(pick(t, [recent, old])?.id, "new");
  const liveOld = row("live", "running", { createdAt: "2026-11-01T10:00:00Z" });
  assert.equal(pick(t, [recent, liveOld])?.id, "live");
  // compared as instants: 11:30+02:00 is 09:30Z, older than 10:00Z though it sorts later as text
  const plus2 = row("plus2", "failed", { updatedAt: "2026-11-13T11:30:00+02:00" });
  const zulu = row("zulu", "failed", { updatedAt: "2026-11-13T10:00:00Z" });
  assert.equal(pick(t, [plus2, zulu])?.id, "zulu");
  assert.equal(pick(t, [zulu, plus2])?.id, "zulu");
  // a missing or unparseable timestamp ranks as oldest
  const none = row("none", "failed");
  const junk = row("junk", "failed", { updatedAt: "yesterday-ish" });
  assert.equal(pick(t, [none, junk, old])?.id, "old");
  // a garbled field falls through to the next one that parses
  const garbled = row("garbled", "failed", { updatedAt: "not a date", startedAt: "2026-11-13T08:00:00Z" });
  const clean = row("clean", "failed", { createdAt: "2026-11-10T08:00:00Z" });
  assert.equal(pick(t, [clean, garbled])?.id, "garbled");
  assert.equal(pick(t, [garbled, clean])?.id, "garbled");
  // findSession goes by the same rule and never returns an interactive session
  const ft = { ...t, sessions: () => [row("i", "running", { kind: "interactive", updatedAt: "2026-11-13T12:00:00Z" }), old, recent] } as Transport;
  assert.equal(findSession(ft, "bea")?.id, "new");
});
