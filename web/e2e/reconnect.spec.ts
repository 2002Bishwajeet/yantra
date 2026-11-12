import { axe, expect, scenario, test } from './lib/test'

/** Y-744: a page that drew its fleet keeps it while the daemon does not
 *  answer, and wears one mark. The board that follows is not asserted here:
 *  `scenario` pins `Date.now()`, so the time the page waits never passes. */
test('a daemon that stops answering leaves the page drawn and marks it', async ({ page }) => {
  await scenario(page, 'busy')
  await page.goto('/machines')
  const machine = page.getByRole('heading', { name: 'cachyos-g14' })
  const mark = page.getByRole('status').filter({ hasText: 'Reconnecting' })
  await expect(machine).toBeVisible()
  await expect(mark).toBeHidden()

  await scenario(page, 'down')
  await expect(mark).toBeVisible()
  const box = (await mark.boundingBox())!
  const view = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height)
  await expect(machine).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await axe(page)

  await scenario(page, 'busy')
  await expect(mark).toBeHidden()
  await expect(machine).toBeVisible()
})
