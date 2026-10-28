import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** Phones are below md (the tab bar); touch is every project but the desktop. */
export const isPhone = (info: TestInfo) => info.project.name.startsWith('iphone');
export const isTouch = (info: TestInfo) => info.project.name !== 'desktop';
/** Below lg: the review-only editor, the order page's Graph tab and the assistant as a sheet. */
export const isNarrow = (info: TestInfo) =>
  ['iphone', 'iphone-landscape', 'ipad'].includes(info.project.name);

/**
 * Opens `path` and waits until it is usable: app.css applied (the dev server injects it with
 * script) and the page hydrated, so a tap reaches React.
 */
export async function open(page: Page, path: string) {
  for (let tries = 0; ; tries++) {
    const res = await page.goto(path, { waitUntil: 'networkidle' }).catch((err: Error) => err);
    // The dev server's Workers runtime restarts if it crashes; meanwhile a request fails outright
    // or comes back 5xx. Wait for it to answer again and load the page once more.
    const down =
      res instanceof Error
        ? /connect|terminated|ECONNREFUSED|ERR_/i.test(res.message)
        : (res?.status() ?? 200) >= 500;
    if (!down) {
      if (res instanceof Error) throw res;
      break;
    }
    if (tries === 1)
      throw res instanceof Error ? res : new Error(`${path} answered ${res?.status()}`);
    await serverUp(page);
  }
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body).overscrollBehaviorY === 'none' &&
      // React Router marks the document once hydration is done.
      Boolean((window as unknown as { __reactRouterDataRouter?: object }).__reactRouterDataRouter),
  );
}

/** Waits (up to 30s) until the dev server serves the overview again. */
async function serverUp(page: Page) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const ok = await page.request
      .get('/', { timeout: 5_000 })
      .then((r) => r.ok())
      .catch(() => false);
    if (ok) return;
    await page.waitForTimeout(1_000);
  }
}

/** Every page in the shell, and the seeded flow the editor tests open. */
export const PAGES = [
  '/',
  '/orders',
  '/orders/new',
  '/orders/scenarios',
  '/approvals',
  '/carts',
  '/flows',
  '/flows/tpl-storefront-order',
  '/commerce',
  '/catalog',
  '/customers/cus_northwind',
  '/account',
  '/team',
  '/audit',
  '/plugins',
];

/**
 * Pretends the device has a notch and a home indicator. Playwright can't emulate safe-area insets,
 * which is why app.css reads them through --safe-* rather than env() directly.
 */
export async function fakeSafeArea(page: Page, inset = { top: 47, bottom: 34, left: 0, right: 0 }) {
  await page.addStyleTag({
    content: `html { --safe-top: ${inset.top}px !important; --safe-bottom: ${inset.bottom}px !important; --safe-left: ${inset.left}px !important; --safe-right: ${inset.right}px !important; }`,
  });
}

/**
 * Fakes the on-screen keyboard as Safari reports it: the visual viewport (and innerHeight) shrink
 * to the area above it. Call before the page loads; then `keyboard(page, px)` opens it leaving
 * `px` visible and `keyboard(page, null)` closes it.
 */
export async function installKeyboard(page: Page) {
  await page.addInitScript(() => {
    // The live layout viewport: at init a phone hasn't applied its viewport meta yet.
    const real = () => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    let up: number | null = null;
    const target = new EventTarget();
    const fake = Object.assign(target, {
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    });
    Object.defineProperties(fake, {
      width: { get: () => real().width },
      height: { get: () => up ?? real().height },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => up ?? real().height,
    });
    (window as unknown as { __keyboard: (h: number | null) => void }).__keyboard = (h) => {
      up = h;
      target.dispatchEvent(new Event('resize'));
    };
  });
}

export const keyboard = (page: Page, visible: number | null) =>
  page.evaluate(
    (v) => (window as unknown as { __keyboard: (h: number | null) => void }).__keyboard(v),
    visible,
  );

/**
 * The size of what takes a tap on each of `selector`'s visible elements: its box, or the larger
 * invisible target `hit-area` draws around a small control on a touch screen.
 */
export async function tapTargets(page: Page, selector: string) {
  return page.$$eval(selector, (els) =>
    els
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        let { width, height } = r;
        if (after.content !== 'none' && after.position === 'absolute') {
          const n = (v: string) => Number.parseFloat(v) || 0;
          width = Math.max(width, width - n(after.left) - n(after.right));
          height = Math.max(height, height - n(after.top) - n(after.bottom));
        }
        const name =
          el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName;
        return { name, width: Math.round(width), height: Math.round(height) };
      }),
  );
}

/** Whether the step is drawn wholly inside the flow canvas. */
export async function inView(page: Page, step: Locator) {
  const sheet = await page.locator('.react-flow').boundingBox();
  const box = await step.boundingBox();
  if (!sheet || !box) return false;
  return (
    box.x >= sheet.x &&
    box.y >= sheet.y &&
    box.x + box.width <= sheet.x + sheet.width &&
    box.y + box.height <= sheet.y + sheet.height
  );
}

/**
 * A step the canvas shows whole, once it has framed the flow. A wide flow opens where its orders
 * wait or loop, so its first step (the trigger) may be off-screen.
 */
export async function stepInView(page: Page) {
  const steps = page.locator('.react-flow__node');
  let found = -1;
  await expect
    .poll(async () => {
      const n = await steps.count();
      found = -1;
      for (let i = 0; i < n && found < 0; i++) if (await inView(page, steps.nth(i))) found = i;
      return found;
    })
    .toBeGreaterThanOrEqual(0);
  return steps.nth(found);
}
