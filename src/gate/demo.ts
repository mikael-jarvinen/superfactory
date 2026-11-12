// `factory demo [--before] <KEY> <spec.ts> [base-url]`: run one Playwright demo headless and collect its media.
//
// Run from the item's worktree so the provenance stamp names the commit under demo. Output lands in
// /tmp/demo/<KEY>/: the NN-caption.png screenshots the spec takes, demo.mp4 encoded from the frames
// the template's camera records, and pr-media.json with the sha and branch. `factory pr-media`
// refuses media whose stamp is neither the PR head nor its base. Needs ffmpeg with libx264.
//
// --before records the code as it was before the change, into /tmp/demo/<KEY>-before/: the files
// checked out must be exactly the merge-base of HEAD with origin's default branch, or that branch's
// head, and the stamp names that commit, not HEAD.
//
// Playwright is an optional peer, never imported here: the runner is found in this package, the
// workspace or the worktree, and run as a child. The spec and the config are copied next to each
// other outside any node_modules tree and resolve @playwright/test through NODE_PATH, so both load
// the same copy the runner is, whichever of those places it came from.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES_DIR } from "../settings.js";
import { KEY_HINT, validKey } from "../state.js";
import type { Workspace } from "../workspace.js";
import { FactoryError, pyRepr, run, splitlines } from "../util.js";
import { STAMP } from "./media.js";

// Platform paths, not anyone's: the demo template and the builders' notes name the same place.
export const DEMO_ROOT = "/tmp/demo";
const PACKAGE_DIR = fileURLToPath(new URL("../../../", import.meta.url));

// The directory holding @playwright/test, searched from this package, then the workspace, then cwd.
export function findPlaywright(ws: Workspace, cwd = process.cwd()): string | undefined {
  const req = createRequire(import.meta.url);
  for (const from of [PACKAGE_DIR, ws.dir, cwd]) {
    try {
      return dirname(req.resolve("@playwright/test/package.json", { paths: [from] }));
    } catch {
      // not there; try the next place
    }
  }
  return undefined;
}

// KEY=value lines, as a shell would read a file of plain assignments. # starts a comment line.
export function readEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(file)) return env;
  for (const line of splitlines(readFileSync(file, "utf8"))) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] as string).trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    env[m[1] as string] = v;
  }
  return env;
}

const checkKey = (ws: Workspace, key: string) => {
  if (!validKey(ws, key)) throw new FactoryError(`demo: ${pyRepr(key)} is ${KEY_HINT}`, 2);
};

// The template, where the demo expects the spec. The package's copy is never edited in place.
export function demoInit(ws: Workspace, key: string, out: (line: string) => void = console.log): void {
  checkKey(ws, key);
  const dest = join(DEMO_ROOT, key, "demo.spec.ts");
  if (existsSync(dest)) throw new FactoryError(`demo: ${dest} exists; edit it, or remove it to start over`);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(TEMPLATES_DIR, "demo.spec.ts"), dest);
  out(dest);
}

// The commit a --before run's files are: the merge-base of HEAD with origin's default branch, or
// that branch's head, whichever the tracked files match exactly. Undefined when they match neither.
export function beforeSha(cwd = process.cwd()): { sha?: string; base: string } {
  const git = (...args: string[]) => run("git", args, { cwd });
  const head = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.trim();
  const base = head || "origin/main";
  const tip = git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).stdout.trim();
  if (!tip) return { base };
  const mb = git("merge-base", "HEAD", tip).stdout.trim();
  for (const sha of [mb, tip]) if (sha && git("diff", "--quiet", sha, "--").status === 0) return { sha, base };
  return { base };
}

export function demo(ws: Workspace, key: string, spec: string, baseUrl: string | undefined, out: (line: string) => void = console.log, before = false): number {
  const no = (msg: string) => new FactoryError(`demo: ${msg}`, 2);
  checkKey(ws, key);
  if (!existsSync(spec)) throw no(`no spec at ${spec}`);
  const git = (...args: string[]) => run("git", args);
  if (git("rev-parse", "--is-inside-work-tree").status !== 0) throw no("run this from the item's worktree");
  let ranAt: string | undefined;
  if (before) {
    const b = beforeSha();
    if (!b.sha)
      throw no(`--before: the files checked out are neither ${b.base} nor its merge-base with HEAD. ` +
        `\`git switch --detach ${b.base}\` (or the merge-base), run the demo, then switch back.`);
    ranAt = b.sha;
  }
  if (run("ffmpeg", ["-version"]).status !== 0) throw no("ffmpeg is not installed (brew install ffmpeg)");
  const pw = findPlaywright(ws);
  if (!pw)
    throw no("@playwright/test is not installed in this package, the workspace or the worktree. " +
      "`npm install -D @playwright/test` in the workspace, then `npx playwright install chromium`.");

  const outDir = join(DEMO_ROOT, before ? `${key}-before` : key);
  const specDir = join(outDir, ".spec");
  const frames = join(outDir, ".frames");
  mkdirSync(outDir, { recursive: true });
  for (const p of [".runner", ".frames", ".spec", "demo.webm", "demo.mp4"]) rmSync(join(outDir, p), { recursive: true, force: true });
  mkdirSync(specDir);
  copyFileSync(spec, join(specDir, "demo.spec.ts"));
  copyFileSync(join(TEMPLATES_DIR, "playwright.config.ts"), join(specDir, "playwright.config.ts"));

  // The workspace's demo.env carries the app's sign-in and base URLs; the command line wins.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...readEnvFile(join(ws.dir, "demo.env")),
    NODE_PATH: dirname(dirname(pw)),
    DEMO_OUT: outDir,
    DEMO_SPEC_DIR: specDir,
  };
  if (baseUrl) env.DEMO_BASE_URL = baseUrl;
  const rc = run(process.execPath, [join(pw, "cli.js"), "test", "--config", join(specDir, "playwright.config.ts")], {
    cwd: specDir, env, stdio: "inherit",
  }).status;

  // The camera held each frame until the next arrived; fps=30 turns that into a steady frame rate.
  if (existsSync(join(frames, "frames.txt"))) {
    const enc = run("ffmpeg", [
      "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(frames, "frames.txt"),
      "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", join(outDir, "demo.mp4"),
    ], { stdio: "inherit" });
    if (enc.status === 0) rmSync(frames, { recursive: true, force: true });
    else console.error(`demo: encoding demo.mp4 failed; frames kept in ${frames}`);
  } else {
    console.error("demo: no video. The spec never called camera.roll(), or it was copied from an older template.");
  }

  const stamp = join(outDir, STAMP);
  if (rc !== 0) {
    rmSync(stamp, { force: true });
    console.error(`demo: FAILED (exit ${rc}). No provenance written; pr-media will refuse this run.`);
    return rc;
  }
  const sha = ranAt ?? git("rev-parse", "HEAD").stdout.trim();
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  writeFileSync(stamp, JSON.stringify({ sha, branch, at: new Date().toISOString(), spec: resolve(spec), ...(before ? { before: true } : {}) }) + "\n");
  out(`demo: PASS${before ? ` (before, at ${sha.slice(0, 7)})` : ""}. media in ${outDir}:`);
  for (const f of readdirSync(outDir).filter((x) => !x.startsWith(".")).sort()) out(f);
  return 0;
}
