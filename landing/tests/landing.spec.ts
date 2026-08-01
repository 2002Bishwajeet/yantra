import { test, expect, type Page } from '@playwright/test';

const VIEWS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

/* The shader is time-driven, so a snapshot taken at an arbitrary frame differs every run.
 * Pinning prefers-reduced-motion makes the island draw exactly one frame at t=0 --
 * deterministic, and it exercises the reduced-motion path at the same time. */
async function settle(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await expect(page.locator('canvas')).toBeVisible();
  await page.waitForTimeout(250);
}

for (const [view, size] of Object.entries(VIEWS)) {
  for (const ground of ['light', 'dark'] as const) {
    test.describe(`${ground} patta, ${view}`, () => {
      /* Declared here rather than via setViewportSize inside the test: resizing at runtime
         leaves a strip of the pre-resize frame in the capture, and it lands in the baseline. */
      test.use({ viewport: size, colorScheme: ground, reducedMotion: 'reduce' });

      test('renders', async ({ page }) => {
        await settle(page);
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
  });

  test('the viewer toggle beats the OS preference in both directions', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await settle(page);

    // Lowercased: the production minifier rewrites hex literals, which the dev server does not.
    const ground = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--patta').trim().toLowerCase(),
      );

    expect(await ground()).toBe('#191108');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(await ground()).toBe('#d0a87f');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await ground()).toBe('#191108');
  });

  /* client:only means the island must not be server-rendered. A canvas in the delivered HTML
     means the directive has regressed, and SSR will start throwing on document/matchMedia. */
  test('the shader island is not server-rendered', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).not.toContain('<canvas');
    expect(html).toContain('astro-island');
  });

  test('the niche keeps its ratio, so the clip cannot drift off the fill', async ({ page }) => {
    await settle(page);
    const drift = await page.evaluate(() => {
      const r = document.querySelector('.shrine')!.getBoundingClientRect();
      return Math.abs(r.width / r.height - 430 / 408);
    });
    expect(drift).toBeLessThan(0.01);
  });
});

test.describe('no sideways scroll', () => {
  for (const [view, size] of Object.entries(VIEWS)) {
    test.describe(view, () => {
      test.use({ viewport: size, reducedMotion: 'reduce' });

      test('fits the viewport width', async ({ page }) => {
        await settle(page);
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflows).toBe(false);
      });
    });
  }
});
