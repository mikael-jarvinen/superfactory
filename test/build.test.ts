import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// `factory` is npm link's symlink to dist/src/cli.js, so the built CLI has to be executable. tsc writes
// new files without the bit, and the build starts with `rm -rf dist`, so without it every `factory`
// call fails with "permission denied". The launchd jobs and the session hooks run it through node,
// so they would not notice.
test("the build leaves the CLI executable, with its shebang", { skip: process.platform === "win32" }, () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  assert.ok(statSync(cli).mode & 0o111, `${cli} is not executable: the build script must chmod +x it`);
  assert.match(readFileSync(cli, "utf8").split("\n")[0] as string, /^#!\/usr\/bin\/env node/);
});
