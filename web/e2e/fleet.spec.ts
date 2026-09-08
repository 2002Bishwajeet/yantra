import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/* Y-347's screen, first pictured by Y-352. What the Fleet, TabletFleet and
   PhoneFleet boards say the page must carry, at all three sizes.
   `states.spec.ts` holds its empty and unreachable states. */

const band = (page: Page, name: string) => page.getByRole('region', { name })

test.describe('the fleet on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/fleet')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  })

  test('sorts every workspace into a band, each row a mark and a word', async ({ page }) => {
    const needs = band(page, 'Needs you')
    await expect(needs.getByText('waiting for trust')).toBeVisible()
    await expect(needs.getByText('crashed, exit 1')).toBeVisible()
    await expect(needs.getByRole('link', { name: 'Answer' })).toBeVisible()

    const running = band(page, 'Running')
    await expect(running.getByText('running', { exact: true })).toHaveCount(3)
    await expect(running.getByRole('link', { name: 'Open' })).toHaveCount(3)
    await expect(running.getByRole('button', { name: 'Stop' })).toHaveCount(3)

    const idle = band(page, 'Idle')
    await expect(idle.getByText('nothing running')).toBeVisible()
  })

  /* D3 §4.1: a dead machine is one row, and the workspaces behind it are not
     listed under it. */
  test('rolls the machine that did not answer into one row', async ({ page, size }) => {
    const needs = band(page, 'Needs you')
    await expect(needs.getByText('unreachable')).toBeVisible()
    await expect(needs.getByRole('link', { name: 'thinkpad' })).toBeVisible()
    await expect(needs.getByText('1 workspace', { exact: true })).toBeVisible()
    // Only the desktop board keeps a detail column; the other two drop it.
    if (size === 'desktop') await expect(needs.getByText(/No route to host/)).toBeVisible()
    await expect(needs.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', '/m/thinkpad')
    // The workspace on it is the row's cause, not a row of its own.
    await expect(page.getByRole('link', { name: 'cargo-zig' })).toHaveCount(0)
  })

  /* D6 §3: GitHub sits inside Needs you, under its own heading, and its links
     go to GitHub and nowhere else. */
  test('draws the GitHub block inside Needs you', async ({ page }) => {
    const github = band(page, 'On GitHub')
    await expect(github.getByRole('heading', { name: 'Reviews' })).toBeVisible()
    await expect(github.getByRole('heading', { name: 'Issues' })).toBeVisible()
    await expect(github.getByRole('link', { name: 'Review' })).toHaveCount(2)
    await expect(github.getByText('Y-330: the options round for D7')).toBeVisible()
  })

  test('folds Idle behind its own button and opens it again', async ({ page, size }) => {
    const show = band(page, 'Idle').getByRole('button', { name: /^Show/ })
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await expect(show).toContainText(size === 'phone' ? 'Show 4' : 'Show 1 more')
    await show.click()
    await expect(show).toHaveAttribute('aria-expanded', 'true')
    await expect(band(page, 'Idle').getByRole('link', { name: 'landing-copy' })).toBeVisible()
  })

  /* D3 §4.4: the order recomputes only when a person asks, so with nothing
     changed the pill has nothing to apply. */
  test('offers Reorder, disabled while no row has moved', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Reorder/ })).toBeDisabled()
  })

  test('has one h1, which on the phone is the app bar', async ({ page, size }) => {
    const h1 = page.locator('h1:visible')
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Fleet')
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveCount(
      size === 'phone' ? 1 : 0,
    )
  })

  test('passes axe and walks by keyboard', async ({ page }) => {
    await axe(page)
    await keyboardWalk(page, 12)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'fleet', 'busy', size)
  })
})

/* Finding 131. When nothing answers, the page used to title itself with a bare
   `<h1>Fleet</h1>` in the browser's own type beside a Material surface. */
test.describe('the fleet when nothing answers', () => {
  test('keeps the screen’s own title', async ({ page }) => {
    await scenario(page, 'unreachable')
    await page.goto('/fleet')
    const title = page.locator('h1.m3-text')
    await expect(title).toHaveText('Fleet')
    await expect(title).toHaveAttribute('data-scale', 'display-small')
  })
})
