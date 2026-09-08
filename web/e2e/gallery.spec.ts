import type { Page } from '@playwright/test'
import { axe, expect, scenario, test } from './lib/test'

/* Y-360, finding 115. Y-339 built `/m3` for the reviewer and for axe, and no
   spec ever opened it: the route is dropped from what ships, so the run that
   gates a merge drew `Nowhere` and passed. `vite build --mode e2e` now keeps
   the chunk (playwright.config.ts), and these three sizes are the whole of
   what CI checks the components in. */

/** The theme through `shell/prefs.ts`'s key, as dashboard.spec.ts does. The
 *  gallery's own `?theme=` writes `data-theme` too, and the shell writes it
 *  last, so the query parameter does not survive the first paint. */
async function prefer(page: Page, theme: string) {
  await page.addInitScript((one) => {
    localStorage.setItem(
      'yantra.prefs',
      JSON.stringify({ v: 1, seenAt: null, seed: null, general: {}, theme: one, density: 'clean' }),
    )
  }, theme)
}

test.describe('the component gallery', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`draws every component in ${theme} and passes axe`, async ({ page }) => {
      await prefer(page, theme)
      await scenario(page, 'busy')
      await page.goto('/m3')

      await expect(page.getByRole('heading', { level: 1, name: 'M3 gallery' })).toBeVisible()
      // Both densities, because a token set that holds at one only is half a
      // component library (ADR-0024 §4).
      await expect(page.getByRole('heading', { level: 2, name: 'Clean' })).toBeVisible()
      await expect(page.getByRole('heading', { level: 2, name: 'Compact' })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

      await axe(page)
    })
  }
})
