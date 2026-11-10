import { axe, expect, scenario, screenshot, test } from './lib/test'
import type { Page } from '@playwright/test'

/** ADR-0041: a Claude turn leaves a background task running, and the Chat
 *  lists it above the composer with a Stop for it and a Stop all. The
 *  fixture's chat socket answers `stopTask` and `stopAll` as chat.rs does. */
const PATH = '/w/yantra-web'
const banner = (page: Page) => page.getByRole('region', { name: 'Waiting on a background task' })

test.describe('the background work', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'background')
    await page.goto(PATH)
    await page.getByLabel('Message Claude in yantra-web', { exact: true }).fill('sleep in the background')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
  })

  test('lists the task that outlives its turn, passes axe, and looks like the board', async ({ page, size }) => {
    await expect(banner(page)).toContainText('Background sleep then echo completion marker')
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
    await axe(page)
    await screenshot(page, 'chat-background', 'background', size)
  })

  test('keeps each Stop a 44 px target a thumb reaches on a phone', async ({ page, size }) => {
    test.skip(size !== 'phone', 'a coarse pointer gets the 44 px target')
    for (const button of await banner(page).getByRole('button').all()) {
      await expect(button).toBeInViewport({ ratio: 1 })
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('stops the task, and the list goes', async ({ page }) => {
    await banner(page).getByRole('button', { name: 'Stop Background sleep then echo completion marker' }).click()
    await expect(banner(page)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('stops all, and the list goes', async ({ page }) => {
    await banner(page).getByRole('button', { name: 'Stop all' }).click()
    await expect(banner(page)).toHaveCount(0)
  })
})
