import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/* The page is the owner's own prototype (Y-212): a painting under a cloth simulation, one sticky
 * frame over three screen-heights, and everything it says is a function of the scroll position.
 * So the baselines are taken at the two ends of that scroll rather than in two colour schemes —
 * there is only one scheme, because there is only one painting. */

const VIEWS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

const version = readFileSync(new URL('../../Cargo.toml', import.meta.url), 'utf8')
  .match(/^version = "([^"]+)"$/m)![1];

async function settle(page: Page) {
  /* Not `reducedMotion` in `use`. Set there -- at file, describe or config level -- it is
     accepted and then dropped: `matchMedia('(prefers-reduced-motion: reduce)')` still answers
     false inside the page, and `contextOptions.reducedMotion` is undefined. Measured against
     the headless shell these run on; whether a full chromium behaves is untested and does not
     matter, since this call works on both. Every one of these tests carried the dead option
     from Y-204 onward, harmlessly, because the page it tested had no motion to suppress. The
     cloth reads this preference itself and parks after one frame; with it genuinely off, the
     fabric never holds still and no two screenshots are alike. */
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  /* The page sets this once the cloth has rendered a frame. Waiting on the <img> instead is not
     enough and looks like it is: `decode()` resolves asynchronously, so the fabric is still the
     flat backing colour two frames after the bitmap is complete, and the baseline captures a
     charcoal rectangle that no assertion here would have caught. */
  await expect(page.locator('[data-frame]')).toHaveAttribute('data-cloth', /on|off/);
  /* Two frames, not one: the first is the cloth's parked render, the second is the paint it
     produces. */
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

async function scrollToEnd(page: Page) {
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('[data-frame]')).toHaveAttribute('data-beat', '2');
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

for (const [view, size] of Object.entries(VIEWS)) {
  test.describe(view, () => {
    /* Declared here rather than via setViewportSize inside the test: resizing at runtime can
       leave a strip of the pre-resize paint in the capture, and it lands in the baseline. */
    test.use({ viewport: size });

    test('the first beat', async ({ page }) => {
      await settle(page);
      await expect(page).toHaveScreenshot(`landing-${view}-first.png`);
    });

    test('the last beat', async ({ page }) => {
      await settle(page);
      await scrollToEnd(page);
      await expect(page).toHaveScreenshot(`landing-${view}-last.png`);
    });
  });
}

test.describe('content', () => {
  test.use({ viewport: VIEWS.desktop });

  test('the page says what Yantra is', async ({ page }) => {
    await settle(page);
    await expect(page).toHaveTitle(/Yantra/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'One workspace.One interface.Every machine.',
    );
    await expect(page.getByText('Local-first, over Tailscale.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/2002Bishwajeet/yantra',
    );
  });

  /* The version is read from the workspace manifest at build time. Asserted against the same file
     rather than a literal, so a bump that forgets the landing cannot pass here either. */
  test('the release it offers is the one in Cargo.toml', async ({ page }) => {
    await settle(page);
    await expect(page.getByText(`v${version}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `Download v${version}` })).toHaveAttribute(
      'href',
      `https://github.com/2002Bishwajeet/yantra/releases/tag/v${version}`,
    );
  });

  /* Y-208 made the placeholder follow the OS preference and asserted it, because that kind of
     reversal is what a later edit silently undoes. This design reverses it deliberately — one
     painting, one ground — so the assertion is kept and turned around. */
  test('the ground is dark whatever the OS prefers', async ({ page }) => {
    const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.emulateMedia({ colorScheme: 'light' });
    await settle(page);
    expect(await ground()).toBe('rgb(11, 8, 6)');

    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await ground()).toBe('rgb(11, 8, 6)');
  });

  /* The painting is the page. A build that emits the markup but loses the asset still passes
     every other test here, and the result is a charcoal rectangle nobody notices until it ships. */
  test('the painting is served', async ({ page }) => {
    await settle(page);
    const painting = page.locator('.ground');
    await expect(painting).toHaveJSProperty('complete', true);
    expect(await painting.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  });

  /* And that it reaches the fabric, which is a separate thing and was separately broken: the cloth
     drew nothing but its flat backing colour over a perfectly loaded <img>, and every other test
     here passed. No pixel decoder is needed to tell those apart -- PNG compresses a flat fill to a
     few kB, and the painting does not compress. */
  test('the fabric carries the painting', async ({ page }) => {
    await settle(page);
    const shot = await page.locator('canvas.cloth').screenshot();
    expect(shot.byteLength).toBeGreaterThan(200_000);
  });
});

test.describe('the three beats', () => {
  test.use({ viewport: VIEWS.desktop });

  test('scrolling tells the clauses in turn', async ({ page }) => {
    await settle(page);
    const frame = page.locator('[data-frame]');
    const verse = (n: number) => page.locator(`[data-verse="${n}"]`);

    await expect(frame).toHaveAttribute('data-beat', '0');
    await expect(verse(0)).toHaveCSS('opacity', '1');
    await expect(verse(2)).toHaveCSS('opacity', '0');

    await page.evaluate(() => scrollTo(0, innerHeight * 1.2));
    await expect(frame).toHaveAttribute('data-beat', '1');
    await expect(verse(1)).toHaveCSS('opacity', '1');

    await scrollToEnd(page);
    await expect(verse(2)).toHaveCSS('opacity', '1');
    await expect(page.locator('[data-clause="2"]')).toHaveCSS('opacity', '1');
  });

  /* The page asks for nothing until it has said all three things, so the one button that does
     something is unreachable at the first beat. Pointer events, not just opacity: a transparent
     button that still takes a click is worse than a visible one. */
  test('the install command arrives with the last beat', async ({ page }) => {
    await settle(page);
    const copy = page.getByRole('button', { name: /install\.sh/ });
    await expect(copy).toHaveCSS('pointer-events', 'none');

    await scrollToEnd(page);
    await expect(copy).toHaveCSS('pointer-events', 'auto');
    await expect(copy).toHaveCSS('opacity', '1');
  });
});

test.describe('copying', () => {
  test.use({
    viewport: VIEWS.desktop,
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  test('the button puts the command on the clipboard', async ({ page }) => {
    await settle(page);
    await scrollToEnd(page);
    await page.getByRole('button', { name: /install\.sh/ }).click();
    await expect(page.locator('[data-copy-tag]')).toHaveText('Copied');
    /* Against the manifest, not a literal: the command pins the tag the download button names, so
       a bump that moves one and not the other fails here. */
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/v${version}/install.sh | bash`,
    );
  });
});
