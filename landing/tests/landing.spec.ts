import { test, expect, type Page } from '@playwright/test';

const VIEWS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

/* The bowl's bead is the shadow of a real crosswire over a real site, so it moves with the
 * clock and no two runs would agree on where it falls. Pinned to a morning with the sun well
 * up but nowhere near the zenith: at noon the bead sits on the centre, where it would also sit
 * if the reading were broken. */
const OVER_JAIPUR = new Date('2026-06-21T03:30:00Z'); // 09:00 IST, sun ~43 degrees up

async function settle(page: Page, theme?: 'dark') {
  await page.clock.setFixedTime(OVER_JAIPUR);
  await page.goto('/');
  if (theme) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForFunction(() => document.fonts.status === 'loaded');

  /* Wait for the drawing to stop changing size rather than for a fixed delay. Everything on
     the page is laid out from the viewport, so a capture taken between a resize and its redraw
     differs from the baseline by a sub-pixel shift across the whole figure -- which reads as
     "the drawing is non-deterministic", and it is not. A 250ms sleep lost that race about one
     run in ten when this was a canvas. */
  await page.waitForFunction(
    () => {
      const gate = document.querySelector('#gate');
      const box = gate?.getAttribute('viewBox');
      if (!box || box === '0 0 0 0') return false;
      const w = window as unknown as { __box?: string; __stable?: number };
      if (w.__box === box) w.__stable = (w.__stable ?? 0) + 1;
      else { w.__box = box; w.__stable = 0; }
      return (w.__stable ?? 0) >= 3;
    },
    null,
    { polling: 80 },
  );
}

for (const [view, size] of Object.entries(VIEWS)) {
  for (const ground of ['light', 'dark'] as const) {
    test.describe(`${ground} patta, ${view}`, () => {
      /* Declared here rather than via setViewportSize inside the test: resizing at runtime
         leaves a strip of the pre-resize frame in the capture, and it lands in the baseline. */
      test.use({ viewport: size, reducedMotion: 'reduce' });

      test('renders', async ({ page }) => {
        await settle(page, ground === 'dark' ? 'dark' : undefined);
        await expect(page).toHaveScreenshot(`landing-${ground}-${view}.png`);
      });
    });
  }
}

test.describe('content and behaviour', () => {
  test.use({ viewport: VIEWS.desktop, reducedMotion: 'reduce' });

  test('the page says what it is, once', async ({ page }) => {
    await settle(page);
    await expect(page).toHaveTitle(/Yantra/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('यन्त्र');
    await expect(page.getByText('Coming soon', { exact: false })).toBeVisible();
    await expect(page.locator('#reading')).toContainText('sun 43° above the horizon');
  });

  /* The reading is the one thing on the page that is not decoration, so a caption that has
     stopped tracking the instrument is worse than no caption. Both are read off the same
     clock, and moving the clock has to move both. */
  test('the caption follows the instrument, not a fixed string', async ({ page }) => {
    await settle(page);
    const beadAt = () => page.evaluate(() => document.querySelector('#gate')!.innerHTML.length);
    const day = await page.locator('#reading').innerText();
    const dayHtml = await beadAt();

    await page.clock.setFixedTime(new Date('2026-06-21T19:00:00Z')); // 00:30 IST, well after dark
    await page.setViewportSize({ width: 1281, height: 800 }); // nudge a redraw
    await expect(page.locator('#reading')).toContainText('below the horizon');
    expect(await page.locator('#reading').innerText()).not.toBe(day);
    expect(await beadAt()).not.toBe(dayHtml);
  });

  /* A patta is a painted cloth and the cloth is light, so the dark ground is an invention and
     does not get to be what a dark-mode visitor sees. It applies only when asked for by name. */
  test('the OS preference alone does not black the cloth; data-theme does', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await settle(page);

    // Lowercased: the production minifier rewrites hex literals, which the dev server does not.
    const cloth = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--patta').trim().toLowerCase(),
      );

    expect(await cloth()).toBe('#dfcba6');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await cloth()).toBe('#1a1509');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(await cloth()).toBe('#dfcba6');
  });
});

test.describe('the frame and what it holds', () => {
  for (const [view, size] of Object.entries(VIEWS)) {
    test.describe(view, () => {
      test.use({ viewport: size, reducedMotion: 'reduce' });

      /* The border wraps the viewport rather than a box inside it, so anything short of the
         full width leaves a strip of bare ground along an edge. */
      test('the border reaches every edge', async ({ page }) => {
        await settle(page);
        const gap = await page.evaluate(() => {
          const b = document.querySelector('#frame')!.getBoundingClientRect();
          return [b.left, b.top, window.innerWidth - b.right, window.innerHeight - b.bottom];
        });
        for (const g of gap) expect(Math.abs(g)).toBeLessThanOrEqual(1);
      });

      /* The instrument, its caption and the words are stacked inside one arch by a script that
         computes their boxes, so an overlap is what a bad number looks like from outside. */
      test('the figure, the caption and the words do not collide', async ({ page }) => {
        await settle(page);
        const box = await page.evaluate(() => {
          const r = (sel: string) => {
            const b = document.querySelector(sel)!.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
          };
          return { panel: r('#panel'), reading: r('#reading'), opening: r('#opening') };
        });
        expect(box.reading.bottom).toBeLessThanOrEqual(box.opening.top);
        expect(box.opening.bottom).toBeLessThanOrEqual(box.panel.bottom + 1);
        expect(box.reading.left).toBeGreaterThanOrEqual(box.panel.left);
        expect(box.reading.right).toBeLessThanOrEqual(box.panel.right);
      });
    });
  }
});
