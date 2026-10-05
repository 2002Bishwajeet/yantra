import type { Page } from '@playwright/test'
import { at } from './lib/sizes'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/* Y-347. What the Usage, TabletUsage and PhoneUsage boards say the page must
   carry, at all three sizes, with Y-354's time window. */

const card = (page: Page, name: string) => page.getByRole('region', { name })

test.describe('usage on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/usage')
  })

  test('reads nothing until a person asks, and the window starts at All', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Read spend' })).toBeVisible()
    await expect(page.getByText('Nothing read yet')).toBeVisible()
    const window = page.getByRole('radiogroup', { name: 'Window' })
    await expect(window.getByRole('radio')).toHaveText(['All', 'Today', '7 days', '30 days'])
    await expect(window.getByRole('radio', { name: 'All' })).toBeChecked()
  })

  /* Y-354. A switch reads nothing (ADR-0019), and Read sends the window's
     start as an instant the browser chose. */
  test('a window is read on request and posts its start', async ({ page }) => {
    let reads = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/tokens')) reads += 1
    })
    await page.getByRole('radio', { name: '7 days' }).click()
    await expect(page).toHaveURL('/usage?window=7d')
    await expect(page.getByText('as read · responses in the last 7 days')).toBeVisible()
    expect(reads).toBe(0)

    const posted = page.waitForRequest((request) => request.url().endsWith('/tokens'))
    await page.getByRole('button', { name: 'Read spend' }).click()
    const since = ((await posted).postDataJSON() as { since: string }).since
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(6.9 * 86_400_000)
    await expect(card(page, 'By workspace').getByText('10 workspaces read')).toBeVisible()

    await page.getByRole('radio', { name: 'All' }).click()
    await expect(page.getByText('Nothing read yet')).toBeVisible()
  })

  test('fans out on request and draws both breakdowns and the table', async ({ page }) => {
    await page.getByRole('button', { name: 'Read spend' }).click()

    const workspaces = card(page, 'By workspace')
    await expect(workspaces.getByText('10 workspaces read')).toBeVisible()
    await expect(workspaces.getByText('$5.46').first()).toBeVisible()

    // Finding 128: the board dates the price table `2 Sep`, not `2026-08-11`.
    await expect(page.getByText('prices from 11 Aug')).toBeVisible()

    const models = card(page, 'By model')
    await expect(models.getByText('claude-opus-5-20260115')).toBeVisible()
    // Y-373: opus's own counts, not the session total, across ten workspaces.
    await expect(
      models.getByText('94,120 in · 843,100 out · 48,120,030 cache read'),
    ).toBeVisible()
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
