// Demo script template. `factory demo <KEY> --init` copies it into the item's demo directory and
// prints where; edit the steps there, then run `factory demo <KEY> <that file>` from the worktree.
//
// A demo films the change and nothing else. Sign in and reach the screen the PR changes before
// `camera.roll()`, where nothing is filmed or paced; roll on that screen, then only the steps that
// show the change. Screenshots are named `NN-what-it-shows.png` in the order a reviewer should see
// them. After the roll the camera paces each step, draws the cursor and the click rings, and records
// the frames `factory demo` encodes to demo.mp4. DEMO_PACE=0 films at full speed.
// Environment: DEMO_BASE_URL (the app), DEMO_OUT (where files go), and DEMO_USER and DEMO_PASS
// from the workspace's demo.env. A login page that comes prefilled needs neither: signIn only
// clicks the button. Nothing here is committed to a product repo.
import { test as base, expect, type Frame, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Set by `factory demo`, which is the only way this runs.
const OUT = process.env.DEMO_OUT as string;
if (!OUT) throw new Error('DEMO_OUT is not set: run this through `factory demo`');
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000/';

// ---------------------------------------------------------------- the camera: no need to edit
const PACE = Number(process.env.DEMO_PACE ?? 1);
const MS = {
  settle: 700, // the new screen, still, before the cursor sets off
  press: 250, // ring showing before the click lands, so a navigation cannot hide it
  afterClick: 1500,
  afterInput: 900,
  afterGoto: 1000,
  endHold: 2500,
};
const POINTER = new Set(['click', 'dblclick', 'tap', 'check', 'uncheck', 'setChecked']);
const OTHER = new Set(['fill', 'type', 'press', 'selectOption', 'setInputFiles', 'hover']);

const cam = {
  page: undefined as Page | undefined, rolling: false, x: 0, y: 0, shooting: false, blackoutUntil: 0, cut: 0,
};
const pause = (page: Page, ms: number) => (PACE > 0 ? page.waitForTimeout(ms * PACE) : undefined);

// Runs inside the page. Self-contained: it is serialised into an init script.
function overlay() {
  const w = window as any;
  if (w.__demoCursor || window !== window.top) return;
  let host: HTMLElement | undefined;
  let root: ShadowRoot;
  let cursor: HTMLElement;
  let x = -100;
  let y = -100;
  const ensure = () => {
    if (host?.isConnected) return true;
    if (!document.documentElement) return false;
    host = document.createElement('demo-camera');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .cursor{position:fixed;left:0;top:0;width:28px;height:32px;will-change:transform;
        filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
      .ring{position:fixed;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;
        border:4px solid #ff2d55;background:rgba(255,45,85,.22);box-shadow:0 0 0 2px #fff;
        animation:ring 1100ms ease-out forwards}
      @keyframes ring{0%{transform:scale(.25);opacity:1}60%{opacity:.95}100%{transform:scale(1.35);opacity:0}}
    </style><div class="cursor"><svg viewBox="0 0 28 32" width="28" height="32">
      <path d="M2 2 L2 26 L8.5 19.5 L13 29.5 L17.5 27.5 L13 17.8 L22 17.8 Z"
        fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div>`;
    cursor = root.querySelector('.cursor') as HTMLElement;
    document.documentElement.appendChild(host);
    return true;
  };
  w.__demoCursor = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    if (ensure()) cursor.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
  };
  w.__demoHide = (hidden: boolean) => {
    if (host) host.style.visibility = hidden ? 'hidden' : '';
  };
  w.__demoRing = (rx: number, ry: number) => {
    if (!ensure()) return;
    w.__demoRingAt = Date.now();
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.left = `${rx}px`;
    ring.style.top = `${ry}px`;
    root.insertBefore(ring, cursor);
    setTimeout(() => ring.remove(), 1200);
  };
  addEventListener('mousemove', (e) => w.__demoCursor(e.clientX, e.clientY), true);
  addEventListener('mousedown', (e) => {
    if (Date.now() - (w.__demoRingAt ?? 0) > 800) w.__demoRing(e.clientX, e.clientY);
  }, true);
}

async function approach(frame: Frame, selector: string, options: any, pointer: boolean) {
  const page = frame.page();
  const target = frame.locator(selector).first();
  await target.waitFor({ state: 'visible', timeout: options?.timeout });
  await pause(page, MS.settle);
  const offscreen = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
  });
  if (offscreen) {
    await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await page.waitForTimeout(700);
  }
  const box = await target.boundingBox();
  if (!box) return;
  const tx = box.x + (options?.position?.x ?? box.width / 2);
  const ty = box.y + (options?.position?.y ?? box.height / 2);
  if (PACE > 0) {
    const dist = Math.hypot(tx - cam.x, ty - cam.y);
    const steps = Math.round(Math.min(1000, Math.max(450, 250 + dist * 0.6)) * PACE / 16);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      await page.mouse.move(cam.x + (tx - cam.x) * e, cam.y + (ty - cam.y) * e);
      await page.waitForTimeout(16);
    }
  }
  await page.mouse.move(tx, ty);
  cam.x = tx;
  cam.y = ty;
  if (pointer && PACE > 0) {
    await page.evaluate(([x, y]) => (window as any).__demoRing?.(x, y), [tx, ty]);
    await pause(page, MS.press);
  }
}

function patch(page: Page) {
  const frameProto = Object.getPrototypeOf(page.mainFrame());
  const pageProto = Object.getPrototypeOf(page);
  if (frameProto.__demoPatched) return;
  frameProto.__demoPatched = true;
  for (const name of [...POINTER, ...OTHER]) {
    const original = frameProto[name];
    frameProto[name] = async function (this: Frame, selector: string, ...rest: any[]) {
      if (this.page() !== cam.page || !cam.rolling) return original.call(this, selector, ...rest);
      const pointer = POINTER.has(name);
      await approach(this, selector, rest.at(-1), pointer).catch(() => {});
      const result = await original.call(this, selector, ...rest);
      await pause(this.page(), pointer ? MS.afterClick : MS.afterInput);
      return result;
    };
  }
  const goto = frameProto.goto;
  frameProto.goto = async function (this: Frame, ...args: any[]) {
    const result = await goto.apply(this, args);
    if (this.page() === cam.page && cam.rolling) await pause(this.page(), MS.afterGoto);
    return result;
  };
  // A fullPage screenshot resizes the viewport while it captures: cut its frames and its time.
  const screenshot = pageProto.screenshot;
  const hide = (page: Page, hidden: boolean) =>
    page.evaluate((h) => (window as any).__demoHide?.(h), hidden).catch(() => {});
  pageProto.screenshot = async function (this: Page, ...args: any[]) {
    const start = performance.now();
    cam.shooting = true;
    await hide(this, true);
    try {
      return await screenshot.apply(this, args);
    } finally {
      await hide(this, false);
      cam.shooting = false;
      cam.blackoutUntil = performance.now() + 300;
      cam.cut += cam.blackoutUntil - start;
    }
  };
}

const test = base.extend<{ camera: { roll: () => Promise<void> } }>({
  camera: async ({ page }, use) => {
    const dir = `${OUT}/.frames`;
    rmSync(dir, { recursive: true, force: true });
    const size = page.viewportSize() ?? { width: 1280, height: 800 };
    Object.assign(cam, { page, rolling: false, x: size.width / 2, y: size.height / 2, cut: 0 });
    await page.addInitScript(overlay);
    page.on('load', () => {
      if (!cam.rolling) return;
      page.evaluate(([x, y]) => (window as any).__demoCursor?.(x, y), [cam.x, cam.y]).catch(() => {});
    });
    patch(page);
    const frames: { file: string; at: number }[] = [];
    const roll = async () => {
      if (cam.rolling) return;
      mkdirSync(dir, { recursive: true });
      await page.mouse.move(cam.x, cam.y);
      await page.evaluate(([x, y]) => (window as any).__demoCursor?.(x, y), [cam.x, cam.y]);
      cam.rolling = true;
      await page.screencast.start({
        size,
        quality: 90,
        onFrame: ({ data }) => {
          const now = performance.now();
          if (cam.shooting || now < cam.blackoutUntil) return;
          const at = now - cam.cut;
          const file = `${String(frames.length).padStart(6, '0')}.jpg`;
          writeFileSync(`${dir}/${file}`, data);
          frames.push({ file, at });
        },
      });
      await pause(page, MS.afterGoto);
    };
    await use({ roll });
    if (!cam.rolling) return;
    await pause(page, MS.endHold);
    const end = performance.now() - cam.cut;
    await page.screencast.stop();
    cam.rolling = false;
    // ffmpeg's concat demuxer: each frame held until the next one arrived, the last one repeated.
    const list = ['ffconcat version 1.0'];
    frames.forEach(({ file, at }, i) => {
      list.push(`file ${file}`, `duration ${(((frames[i + 1]?.at ?? end) - at) / 1000).toFixed(4)}`);
    });
    if (frames.length) list.push(`file ${frames[frames.length - 1].file}`);
    writeFileSync(`${dir}/frames.txt`, `${list.join('\n')}\n`);
  },
});
// ---------------------------------------------------------------- end of the camera

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

// The sign-in is saved per app host and reused, so later runs never see the login screen.
const SESSION = join(dirname(OUT), '.sessions', `${new URL(BASE).host}.json`);
test.use({ storageState: existsSync(SESSION) ? SESSION : undefined });

// What the sign-in form's fields and button say. Add the app's own words if it uses others.
const LABELS = {
  user: RegExp('email|username', 'i'),
  password: RegExp('password', 'i'),
  submit: RegExp('log in|sign in', 'i'),
};

async function signIn(page: Page) {
  await page.goto(BASE);
  const emailField = page.getByLabel(LABELS.user);
  if (await emailField.count()) {
    const user = process.env.DEMO_USER;
    const pass = process.env.DEMO_PASS;
    if (user && pass && !(await emailField.first().inputValue())) {
      await emailField.first().fill(user);
      await page.getByLabel(LABELS.password).first().fill(pass);
    }
    await page.getByRole('button', { name: LABELS.submit }).first().click();
    await emailField.first().waitFor({ state: 'hidden' });
  }
  mkdirSync(dirname(SESSION), { recursive: true });
  await page.context().storageState({ path: SESSION });
}

test('demo', async ({ page, camera }) => {
  // Setup, not filmed: sign in and open the screen the PR changes, by URL or by clicking there.
  await signIn(page);
  await page.goto(BASE); // the changed screen's URL
  // await expect(page.getByRole('heading', { name: 'The changed screen' })).toBeVisible();

  // Roll on the screen the PR changes, right before the first step that shows the change.
  await camera.roll();

  // Only the steps that show the change, then stop. For a PR that fixes saving rich text:
  // await page.getByRole('textbox', { name: 'Description' }).fill('Bold text and a list');
  // await page.getByRole('button', { name: 'Save' }).click();
  // await page.reload();
  await shot(page, '01-rich-text-kept-after-save');
});
