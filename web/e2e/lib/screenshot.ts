import { expect, type Page } from '@playwright/test'
import type { Scenario } from './scenario'
import type { Size } from './sizes'

/** One file per screen, scenario and size under `e2e/__screenshots__/`, so
 *  `dashboard-busy-phone.png` is the picture a reviewer holds against the
 *  board. Full page: a phone screen is mostly below the fold. */
export async function screenshot(
  page: Page,
  screen: string,
  scenario: Scenario,
  size: Size,
) {
  await expect(page).toHaveScreenshot(`${screen}-${scenario}-${size}.png`, {
    fullPage: true,
  })
}
