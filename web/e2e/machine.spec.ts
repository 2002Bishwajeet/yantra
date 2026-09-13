import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/* Y-347, and D7 §4.3 since Y-396: one machine's page at all three sizes.
   Readiness leads, and its verdict decides the one action. */

const card = (page: Page, name: string) => page.getByRole('region', { name })

/** D7 B2: nothing on the page is wider than the screen. */
async function fits(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(over).toBeLessThanOrEqual(0)
}

test.describe('one machine on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/cachyos-g14')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  })

  test('leads with a ready verdict and folds the ten checks', async ({ page }) => {
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('heading', { name: 'Ready for sessions' })).toBeVisible()
    await expect(ready.getByText(/^10 of 10 · asked/)).toBeVisible()
    await expect(ready.getByRole('link', { name: 'New session' })).toBeVisible()
    await ready.getByRole('button', { name: /^Show/ }).click()
    await expect(ready.getByText('ok', { exact: true })).toHaveCount(10)
    await expect(ready.getByText('gh signed in', { exact: true })).toBeVisible()

    const about = card(page, 'About')
    await expect(about.getByText(/linux/).first()).toBeVisible()
  })

  test('lists only this machine’s workspaces, each with its one verb', async ({ page }) => {
    const here = card(page, 'Workspaces on this machine')
    await expect(here.getByRole('link', { name: 'yantra-web' })).toBeVisible()
    await expect(here.getByRole('link', { name: 'Answer' })).toHaveAttribute(
      'href',
      '/w/yantra-web?view=chat',
    )
    await expect(here.getByText('waiting for trust')).toBeVisible()
    // `landing` lives on macbook.
    await expect(here.getByRole('link', { name: 'landing' })).toHaveCount(0)
  })

  test('offers Terminal for a claimed session and Attach for one nobody claims', async ({
    page,
  }) => {
    const sessions = card(page, 'Sessions')
    await expect(sessions.getByRole('link', { name: 'Terminal' })).toHaveCount(3)
    await expect(sessions.getByRole('link', { name: 'Attach' })).toHaveAttribute(
      'href',
      '/m/cachyos-g14/s/scratch',
    )
    await expect(sessions.getByText('no workspace claims it')).toBeVisible()
    await expect(sessions.getByRole('button', { name: 'Adopt' })).toHaveCount(0)
  })

  test('Kill asks first; Resume does not', async ({ page }) => {
    await card(page, 'Sessions').getByRole('button', { name: 'Kill' }).first().click()
    const asking = page.getByRole('dialog')
    await expect(asking).toBeVisible()
    await expect(asking.getByText('Kill yantra-web?')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(asking).toBeHidden()

    await card(page, 'Workspaces on this machine')
      .getByRole('button', { name: 'Resume' })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  /* Y-360: the trailing value took the row's whole width, so `Tailnet name`
     read `T…` at every size. */
  test('keeps a list headline whole beside a long value', async ({ page, size }) => {
    const about = card(page, 'About')
    if (size === 'phone') await about.getByRole('button', { name: /^Show/ }).click()
    const head = about.getByText('Tailnet name')
    await expect(head).toBeVisible()
    const cut = await head.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(cut).toBeLessThanOrEqual(1)
  })

  test('has one h1, which on the phone is the app bar', async ({ page, size }) => {
    const h1 = page.locator('h1:visible')
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('cachyos-g14')
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveCount(
      size === 'phone' ? 1 : 0,
    )
  })

  test('fits the screen', async ({ page }) => {
    await fits(page)
  })

  test('passes axe and walks by keyboard', async ({ page }) => {
    await axe(page)
    await keyboardWalk(page, 12)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'machine', 'busy', size)
  })
})

test.describe('one machine that is off', () => {
  test('is asleep, not failed, and its ssh error wraps inside the screen', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/thinkpad')
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('heading', { name: 'thinkpad is asleep' })).toBeVisible({ timeout: 15_000 })
    await expect(ready.getByRole('button', { name: 'Check again' })).toHaveCount(0)
    const sessions = card(page, 'Sessions')
    await expect(sessions.getByText('the machine did not answer')).toBeVisible()
    await expect(sessions.getByText(/No route to host/)).toBeVisible()
    await fits(page)
    await axe(page)
  })
})

test.describe('one machine missing a basic', () => {
  test('offers Install and no session, inside the screen', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/nas')
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('heading', { name: 'tmux and claude are missing' })).toBeVisible({ timeout: 15_000 })
    await expect(ready.getByRole('button', { name: 'Install' })).toBeVisible()
    // The shell's FAB is D7 T8's; this page offers no session of its own.
    await expect(ready.getByRole('link', { name: 'New session' })).toHaveCount(0)
    await expect(card(page, 'Workspaces on this machine').getByRole('link', { name: 'New session' })).toHaveCount(0)
    await fits(page)
  })
})
