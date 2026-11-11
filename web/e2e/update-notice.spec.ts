import { axe, expect, scenario, screenshot, test } from './lib/test'

/** Y-712: a newer release shows a notice on every page but About, at phone
 *  and desktop widths. Update opens About, and Dismiss hides it for good. */
test.describe('the update notice', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/machines')
  })

  test('shows, opens About and dismisses', async ({ page, size }) => {
    const notice = page.getByRole('region', { name: 'Update available' })
    await expect(notice.getByText('Update to v0.4.0')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await screenshot(page, 'update-notice', 'busy', size)
    await axe(page)

    await notice.getByRole('link', { name: 'Update' }).click()
    await expect(page).toHaveURL(/\/settings\/about$/)
    await expect(notice).toBeHidden()

    await page.goto('/machines')
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(notice).toBeHidden()
    await page.reload()
    await expect(page.getByRole('main')).toBeVisible()
    await expect(notice).toBeHidden()
  })
})
