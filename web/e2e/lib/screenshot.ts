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
  await expect(page).toHaveScreenshot(`${screen}-${scenario}-${size}.png`, {
    fullPage: !options.overlay,
  })
}
