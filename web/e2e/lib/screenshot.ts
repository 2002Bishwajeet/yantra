import { expect, test, type Page } from '@playwright/test'
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
  scenario: Scenario | `${Scenario}-${number}`,
  size: Size,
  options: { overlay?: boolean } = {},
) {
  // Y-660: every baseline is a Chromium render, so WebKit runs the spec's assertions and skips the image.
  if (test.info().project.use.browserName === 'webkit') return
  // Shell's lazy Account and BellPopover show a slot fallback until they load (321 px).
  await expect(page.locator('.shell__slot')).toHaveCount(0)
  // A full-page capture resizes the viewport under a sticky dock, and the Chat scrolls itself as the page resizes,
  // so two captures differ. A viewport as tall as the page needs no resize: the dock rests at the foot of it.
  const before = page.viewportSize()
  // The phone scrolls `.shell__main`, which a full-page capture does not follow, so it grows the viewport to the whole of it too.
  const phone = !options.overlay && before !== null && (await page.locator('[data-shell="phone"] .shell__main').count()) > 0
  const docked = phone || (!options.overlay && before !== null && (await page.locator('.composer-dock').first().isVisible()))
  if (docked) {
    // The page grows after its last assertion (an image settles, a draft wraps), so the viewport follows it
    // until two reads a frame apart agree with it.
    const frame = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    let agreed = 0
    await expect
      .poll(async () => {
        await frame()
        const height = await page.evaluate(() => {
          const main = document.querySelector('[data-shell="phone"] .shell__main')
          return main ? Math.ceil(main.getBoundingClientRect().top + main.scrollHeight) : document.documentElement.scrollHeight
        })
        if (page.viewportSize()!.height !== height) {
          agreed = 0
          await page.setViewportSize({ width: before!.width, height })
          return false
        }
        return ++agreed >= 3
      })
      .toBe(true)
  }
  await expect(page).toHaveScreenshot(`${screen}-${scenario}-${size}.png`, {
    fullPage: !options.overlay,
  })
  if (docked) await page.setViewportSize(before!)
}
