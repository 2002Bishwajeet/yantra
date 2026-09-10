import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/* The page is the owner's own prototype (Y-209): one sticky frame over three screen-heights, and
 * everything it does is a function of the scroll position. So the baselines are taken at the two
 * ends of that scroll rather than in two colour schemes — there is only one scheme now. */

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
     from Y-204 onward, harmlessly, because the page it tested had no motion to suppress. This
     one has two WebGL loops and never painted the same frame twice. */
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  /* Two frames, not one: the first lets the flame read the panel's box after the webfonts have
     changed its height, the second is the paint that box produces. */
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
     ground, one composition — so the assertion is kept and turned around. */
  test('the ground is dark whatever the OS prefers', async ({ page }) => {
    const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.emulateMedia({ colorScheme: 'light' });
    await settle(page);
    expect(await ground()).toBe('rgb(12, 15, 10)');

    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await ground()).toBe('rgb(12, 15, 10)');
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
    const copy = page.getByRole('button', { name: /Copy cargo install/ });
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
    await page.getByRole('button', { name: /Copy cargo install/ }).click();
    await expect(page.locator('[data-copy-verb]')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'cargo install --path crates/yantra',
    );
  });
});
