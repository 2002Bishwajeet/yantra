import type { Page } from '@playwright/test'
import { at } from './lib/sizes'
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

  /* The boards draw a proportion bar under each figure. Against the dearest
     row, never against a sum — a share of a fleet total would be that total,
     which D6 §5.1 forbids. */
  test('draws a proportion bar against the dearest row', async ({ page }) => {
    await page.getByRole('button', { name: 'Read spend' }).click()
    const bars = card(page, 'By workspace').getByRole('progressbar')
    await expect(bars).toHaveCount(10)
    // Every busy workspace reads $5.46, so every bar is the whole width.
    await expect(bars.first()).toHaveAttribute('aria-valuenow', '100')
    await expect(bars.first()).toHaveAccessibleName('$5.46 of the most spent, $5.46')
  })

  /* Finding 100. The fan-out used to be component state, so a walk to another
     page threw away ten ssh round trips and drew "Nothing read yet" again. */
  test('keeps the read when the page is left and opened again', async ({ page }) => {
    await page.getByRole('button', { name: 'Read spend' }).click()
    await expect(card(page, 'By workspace').getByText('10 workspaces read')).toBeVisible()

    // A link, not a `goto`: a reload would empty the query cache too, and the
    // walk between two screens is what a person does.
    await page.getByRole('link', { name: 'Fleet' }).first().click()
    await expect(page).toHaveURL('/fleet')
    await page.getByRole('link', { name: 'Usage' }).first().click()
    await expect(page).toHaveURL('/usage')

    await expect(card(page, 'By workspace').getByText('10 workspaces read')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Read again' })).toBeVisible()
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

  /* Y-361. A person drags the window across 600 px or 1240 px and the shell
     changes form factor. Every other screen reads its query cache again; the
     fan-out is Usage's own state, and a shell that remounted the tree on the
     way threw it away. */
  test('keeps the read when the window crosses a breakpoint', async ({ page, size }) => {
    await page.getByRole('button', { name: 'Read spend' }).click()
    const read = card(page, 'By workspace').getByText('10 workspaces read')
    await expect(read).toBeVisible()

    const other = size === 'phone' ? 'desktop' : 'phone'
    await page.setViewportSize(at(other).viewport)
    await expect(page.locator('[data-shell]')).toHaveAttribute('data-shell', other)
    await expect(read).toBeVisible()
  })

  /* The Usage boards draw the read, not the page waiting to be asked, so the
     picture waits for the count each part of the fan-out prints.

     The viewport rather than the page. A full-page capture makes Chromium
     report a 1x1 viewport for a frame and `useFormFactor` reads *phone*; that
     used to throw the read away, and Y-361 stopped it. The viewport stays
     because the boards are 1440x1024, 834x1194 and 390x844, so it is the frame
     each board was drawn at. */
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
