import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/* Y-347. What the Machine, TabletMachine and PhoneMachine boards say one
   machine's page must carry, at all three sizes. */

const card = (page: Page, name: string) => page.getByRole('region', { name })

test.describe('one machine on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/cachyos-g14')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  })

  test('draws About and the nine readiness checks', async ({ page }) => {
    const about = card(page, 'About')
    await expect(about.getByText('linux')).toBeVisible()
    await expect(about.getByText(/beat 4s ago/)).toBeVisible()

    const ready = card(page, 'Readiness')
    await expect(ready.getByText(/^9 of 9 · asked/)).toBeVisible()
    await expect(ready.getByText('ok')).toHaveCount(9)
    await expect(ready.getByText('provider-auth')).toBeVisible()
    await expect(ready.getByRole('button', { name: 'Doctor' })).toHaveCount(0)
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
  test('keeps a list headline whole beside a long value', async ({ page }) => {
    const head = card(page, 'About').getByText('Tailnet name')
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

  test('passes axe and walks by keyboard', async ({ page }) => {
    await axe(page)
    await keyboardWalk(page, 12)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'machine', 'busy', size)
  })
})

test.describe('one machine that did not answer', () => {
  test('draws the machine’s own words in place of its sessions', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/thinkpad')
    const sessions = card(page, 'Sessions')
    await expect(sessions.getByText('the machine did not answer')).toBeVisible()
    await expect(sessions.getByText(/No route to host/)).toBeVisible()
    await expect(card(page, 'Readiness').getByText('unknown').first()).toBeVisible()
    await axe(page)
  })
})
