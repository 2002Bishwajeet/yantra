import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, test } from './lib/test'

/* Y-347. What the Usage, TabletUsage and PhoneUsage boards say the page must
   carry, at all three sizes — minus the time window, which is Y-354. */

const card = (page: Page, name: string) => page.getByRole('region', { name })

test.describe('usage on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/usage')
  })

  test('reads nothing until a person asks, and offers no time window yet', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Read spend' })).toBeVisible()
    await expect(page.getByText('Nothing read yet')).toBeVisible()
    for (const window of ['Today', '7 days', '30 days']) {
      await expect(page.getByRole('button', { name: window })).toHaveCount(0)
    }
  })

  test('fans out on request and draws both breakdowns and the table', async ({ page }) => {
    await page.getByRole('button', { name: 'Read spend' }).click()

    const workspaces = card(page, 'By workspace')
    await expect(workspaces.getByText('10 workspaces read')).toBeVisible()
    await expect(workspaces.getByText('$5.46').first()).toBeVisible()

    const models = card(page, 'By model')
    await expect(models.getByText('claude-opus-5-20260115')).toBeVisible()
    // A model the price table does not carry is unpriced, never free.
    await expect(models.getByText('unpriced')).toBeVisible()

    const table = card(page, 'Sessions').getByRole('table')
    await expect(table.getByRole('columnheader', { name: 'Cost' })).toBeVisible()
    await expect(table.getByRole('row')).toHaveCount(11)
    await expect(page.getByText(/there is no fleet total/)).toBeVisible()
  })

  test('has one h1, which on the phone is the app bar', async ({ page, size }) => {
    const h1 = page.locator('h1:visible')
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Usage')
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveCount(
      size === 'phone' ? 1 : 0,
    )
  })

  test('passes axe before and after the read, and walks by keyboard', async ({ page }) => {
    await axe(page)
    await keyboardWalk(page, 10)
    await page.getByRole('button', { name: 'Read spend' }).click()
    await expect(card(page, 'By workspace')).toBeVisible()
    await axe(page)
  })
})

test.describe('usage when a read is refused', () => {
  test('names the workspace and the daemon’s own words in place', async ({ page }) => {
    await scenario(page, 'refused')
    await page.goto('/usage')
    await page.getByRole('button', { name: 'Read spend' }).click()
    const workspaces = card(page, 'By workspace')
    await expect(workspaces.getByText('Nothing was counted')).toBeVisible()
    await expect(
      workspaces.getByText(/node biswas-iphone is on this tailnet but is not yours/).first(),
    ).toBeVisible()
    await axe(page)
  })
})
