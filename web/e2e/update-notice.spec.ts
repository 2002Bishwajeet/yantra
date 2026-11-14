import { axe, expect, scenario, screenshot, test } from './lib/test'

/** Y-752: a newer release shows once as a snackbar, then as a badge on
 *  Account and a row in About. It never sits above Chat or Terminal. */
test.describe('the update snackbar', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy', { update: true })
  })

  test('shows once, clears its badge in About, and does not return', async ({ page, size }) => {
    await page.goto('/machines')
    const snackbar = page.getByRole('status').filter({ hasText: 'Yantra v0.4.0 is out' })
    await expect(snackbar).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const nav = page.locator('nav.m3-navigation-bar')
    if (size === 'phone') {
      const [box, bar] = [await snackbar.boundingBox(), await nav.boundingBox()]
      expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y)
    }
    await screenshot(page, 'update-notice', 'busy', size)
    await axe(page)

    const account = page.getByRole('button', { name: /^Account.*Update available/ })
    await expect(account).toBeVisible()

    await snackbar.getByRole('button', { name: 'Update' }).click()
    await expect(page).toHaveURL(/\/settings\/about$/)
    await expect(page.getByRole('link', { name: 'v0.4.0 is out' })).toBeVisible()
    await expect(snackbar).toBeHidden()
    await expect(page.getByRole('button', { name: 'Account' })).toBeVisible()

    await page.goto('/machines')
    await expect(page.getByRole('main')).toBeVisible()
    await expect(snackbar).toBeHidden()
  })

  test('does not return after a reload', async ({ page }) => {
    await page.goto('/machines')
    const snackbar = page.getByRole('status').filter({ hasText: 'Yantra v0.4.0 is out' })
    await snackbar.getByRole('button', { name: 'Dismiss' }).click()
    await expect(snackbar).toBeHidden()
    await page.reload()
    await expect(page.getByRole('main')).toBeVisible()
    await expect(snackbar).toBeHidden()
    await expect(page.getByRole('button', { name: /^Account.*Update available/ })).toBeVisible()
  })

  test('is not drawn above a session', async ({ page }) => {
    await page.goto('/w/landing')
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'is out' })).toHaveCount(0)
  })
})
