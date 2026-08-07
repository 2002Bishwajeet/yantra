import { test, expect, type Page } from '@playwright/test';

/* The page is a placeholder (Y-208), so these tests are deliberately thin: they exist to keep the
 * build, the snapshot harness and the deploy path exercised while the design is redrawn, not to
 * pin down a design nobody has settled on yet. */

const VIEWS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

async function settle(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => document.fonts.status === 'loaded');
}

for (const [view, size] of Object.entries(VIEWS)) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme}, ${view}`, () => {
      /* Declared here rather than via setViewportSize inside the test: resizing at runtime can
         leave a strip of the pre-resize paint in the capture, and it lands in the baseline. */
      test.use({ viewport: size, colorScheme: scheme, reducedMotion: 'reduce' });

      test('renders', async ({ page }) => {
        await settle(page);
        await expect(page).toHaveScreenshot(`landing-${scheme}-${view}.png`);
      });
    });
  }
}

test.describe('content', () => {
  test.use({ viewport: VIEWS.desktop, reducedMotion: 'reduce' });

  test('the page says what it is, once', async ({ page }) => {
    await settle(page);
    await expect(page).toHaveTitle(/Yantra/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('yantra');
    await expect(page.getByText('One control plane for every machine you already own.')).toBeVisible();
    await expect(page.getByText('Coming soon', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: /GitHub/i })).toHaveAttribute(
      'href',
      'https://github.com/2002Bishwajeet/yantra',
    );
  });

  /* The previous design was light-only by argument (a painted cloth is light) and ignored the OS
     preference. A neutral placeholder has no such argument, so it honours the preference again --
     asserted because that reversal is easy to lose in a later edit. */
  test('the ground follows the OS preference', async ({ page }) => {
    const ground = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.emulateMedia({ colorScheme: 'light' });
    await settle(page);
    expect(await ground()).toBe('rgb(250, 249, 247)');

    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await ground()).toBe('rgb(23, 21, 15)');
  });
});
