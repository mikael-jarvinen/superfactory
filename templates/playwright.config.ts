import { defineConfig } from '@playwright/test';

// Used by `factory demo`, which copies it next to the spec and sets DEMO_OUT and DEMO_SPEC_DIR.
// Headless Chromium, one worker, generous timeouts for dev servers. Playwright's own video stays
// off: the camera in demo.spec.ts records the frames itself, with their timestamps, and
// `factory demo` encodes them to demo.mp4.
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run this through \`factory demo\``);
  return v;
};

export default defineConfig({
  testDir: need('DEMO_SPEC_DIR'),
  testMatch: /.*\.spec\.ts$/,
  outputDir: `${need('DEMO_OUT')}/.runner`,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
});
