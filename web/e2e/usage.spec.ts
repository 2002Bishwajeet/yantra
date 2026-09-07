import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

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

  /* The Usage boards draw the read, not the page waiting to be asked, so the
     picture waits for the count each part of the fan-out prints.

     The viewport rather than the page, and this is not a preference: a
     full-page capture makes Chromium report a 1x1 viewport for a frame,
     `useFormFactor` reads *phone*, and `Shell` swaps the component it renders,
     which unmounts the tree and throws the read away. Every other screen reads
     its query cache again and looks the same; Usage holds the fan-out in its
     own state and cannot. The boards are 1440x1024, 834x1194 and 390x844, so
     the viewport is the frame the board was drawn at. */
  test('looks like the board once the read is on screen', async ({ page, size }) => {
    await page.getByRole('button', { name: 'Read spend' }).click()
    await expect(card(page, 'By workspace').getByText('10 workspaces read')).toBeVisible()
    await expect(card(page, 'By model').getByText('2 models')).toBeVisible()
    await expect(card(page, 'Sessions').getByText('10 read · most expensive first')).toBeVisible()
    await screenshot(page, 'usage', 'busy', size, { overlay: true })
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
