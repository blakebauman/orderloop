import type { Page, TestInfo } from '@playwright/test';

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
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body).overscrollBehaviorY === 'none' &&
      // React Router marks the document once hydration is done.
      Boolean((window as unknown as { __reactRouterDataRouter?: object }).__reactRouterDataRouter),
  );
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
