import type { Locator } from '@playwright/test'
import { expect, scenario, test } from './lib/test'

/** Y-765: a menu first mounted by the tap opened after 300 ms or more in WebKit. Both menus
 *  now mount closed once the page is idle, so the tap only opens them. */
async function opens(trigger: Locator) {
  const page = trigger.page()
  await page.waitForLoadState('networkidle')
  // Let the idle mount land; a tap before it is the slow path this guards against.
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const seen = { t0: 0, visible: 0 }
    Object.assign(window, { menuSeen: seen })
    addEventListener('pointerdown', () => (seen.t0 = performance.now()), { capture: true, once: true })
    const poll = () => {
      if (seen.t0 && document.querySelector('.m3-menu')?.checkVisibility()) seen.visible = performance.now()
      else requestAnimationFrame(poll)
    }
    poll()
  })
  await trigger.tap()
  await page.waitForFunction(() => (window as unknown as { menuSeen: { visible: number } }).menuSeen.visible > 0)
  const took = await page.evaluate(() => {
    const it = (window as unknown as { menuSeen: { t0: number; visible: number } }).menuSeen
    return it.visible - it.t0
  })
  expect(took).toBeLessThan(250)
}

test.describe('the phone menus open within a quarter second of the first tap', () => {
  test.skip(({ size }) => size !== 'phone', 'the phone projects run Chromium and WebKit at 390 px')

  test('Account', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/')
    const account = page.getByRole('button', { name: 'Account' })
    await expect(account).toBeVisible()
    await opens(account)
  })

  test('More actions', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/w/yantra-web')
    const more = page.getByRole('button', { name: 'More actions' })
    await expect(more).toBeVisible()
    await opens(more)
  })
})
