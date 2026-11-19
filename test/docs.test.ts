import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { factory } from "./helpers.js";

const doc = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

// Niilo on #129: the docs say what \`factory state\` says, so waiting work is never told to sit on the board.
test("README and design.md say where waiting work lives, as the help does", () => {
  const help = factory(undefined, ["--help"]).stdout;
  assert.match(help, /goes off with\s+--title, and \\?`state --off\\?` lists it/);
  const row = doc("README.md").split("\n").find((l) => l.startsWith("| `factory state <KEY>")) ?? "";
  const design = doc("docs/design.md").split("\n```")[1] ?? "";
  for (const [where, text] of [["README's factory state row", row], ["design.md's state.ts line", design.slice(design.indexOf("state.ts"), design.indexOf("fleet.ts"))]] as const) {
    assert.match(text, /backlog/, `${where} says waiting work lives in the backlog`);
    assert.match(text, /LOCAL- work.*?off --title|LOCAL- work[\s\S]*?goes off with --title/, `${where} says LOCAL- work goes off with --title`);
    assert.match(text, /factory state --off/, `${where} says \`state --off\` lists it`);
    assert.doesNotMatch(text, /queued/, `${where} names no queued state`);
  }
});
