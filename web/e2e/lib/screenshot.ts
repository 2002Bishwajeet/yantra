import { expect, type Page } from '@playwright/test'
import type { Scenario } from './scenario'
import type { Size } from './sizes'

/** One file per screen, scenario and size under `e2e/__screenshots__/`, so
 *  `dashboard-busy-phone.png` is the picture a reviewer holds against the
 *  board. Full page: a phone screen is mostly below the fold. An overlay
 *  (popover, side sheet) is the viewport only: capturing beyond it on a page
 *  taller than the viewport dismisses a non-modal surface. */
export async function screenshot(
  page: Page,
  screen: string,
  scenario: Scenario,
  size: Size,
  options: { overlay?: boolean } = {},
) {
  // Shell's lazy Account and BellPopover show a slot fallback until they load (321 px).
  await expect(page.locator('.shell__slot')).toHaveCount(0)
  // A full-page capture resizes the viewport under a sticky dock, and the Chat scrolls itself as the page resizes,
  // so two captures differ. A viewport as tall as the page needs no resize: the dock rests at the foot of it.
  const before = page.viewportSize()
  const docked = !options.overlay && before !== null && (await page.locator('.composer-dock').first().isVisible())
  if (docked) {
    // The dock grows with its draft, so the page is measured again until it stops moving.
    const frame = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    await expect
      .poll(async () => {
        const height = await page.evaluate(() => document.documentElement.scrollHeight)
        if (page.viewportSize()!.height === height) return true
        await page.setViewportSize({ width: before.width, height })
        await frame()
        return false
      })
      .toBe(true)
  }
  await expect(page).toHaveScreenshot(`${screen}-${scenario}-${size}.png`, {
    fullPage: !options.overlay,
  })
  if (docked) await page.setViewportSize(before)
}
