import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/* Y-347. What the Machines, TabletMachines and PhoneMachines boards say the
   page must carry, at all three sizes. `states.spec.ts` holds its empty and
   error states. */

const card = (page: Page, name: string) => page.getByRole('region', { name })

test.describe('the machines on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  })

  test('draws a card a machine, each check a mark and a word', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Open' })).toHaveCount(6)

    const good = card(page, 'cachyos-g14')
    await expect(good.getByText('online')).toBeVisible()
    await expect(good.getByText('4 of 4 checks')).toBeVisible()
    await expect(good.getByRole('button', { name: 'Doctor' })).toHaveCount(0)

    const short = card(page, 'pi-5')
    await expect(short.getByText('agent-cli')).toBeVisible()
    await expect(short.getByText('no `claude` on PATH there')).toBeVisible()
    await expect(short.getByText('1 failing')).toBeVisible()
    await expect(short.getByRole('button', { name: 'Doctor' })).toBeVisible()

    const gone = card(page, 'thinkpad')
    await expect(gone.getByText('unreachable')).toBeVisible()
    await expect(gone.getByText('1 failing · 3 unknown')).toBeVisible()
    // Finding 128: the board dates the chip `7 Jul`, not `2026-07-07`.
    await expect(gone.getByText('7 Jul', { exact: true })).toBeVisible()
  })

  test('offers an unclaimed session Attach and Kill, and never Adopt', async ({ page }) => {
    const worth = card(page, 'Worth a look')
    await expect(worth.getByText('2 sessions no workspace claims')).toBeVisible()
    await expect(worth.getByRole('link', { name: 'Attach' })).toHaveCount(2)
    await expect(worth.getByRole('button', { name: 'Adopt' })).toHaveCount(0)
    await expect(worth.getByRole('link', { name: 'Attach' }).first()).toHaveAttribute(
      'href',
      '/m/cachyos-g14/s/scratch',
    )
  })

  test('Kill asks first and repeats the row', async ({ page }) => {
    await card(page, 'Worth a look').getByRole('button', { name: 'Kill' }).first().click()
    const asking = page.getByRole('dialog')
    await expect(asking).toBeVisible()
    await expect(asking.getByText('scratch', { exact: true })).toBeVisible()
    await expect(asking.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(asking).toBeHidden()
  })

  test('has one h1, which on the phone is the app bar', async ({ page, size }) => {
    const h1 = page.locator('h1:visible')
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Machines')
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveCount(
      size === 'phone' ? 1 : 0,
    )
  })

  test('passes axe and walks by keyboard', async ({ page }) => {
    await axe(page)
    await keyboardWalk(page, 12)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'machines', 'busy', size)
  })
})

test.describe('the machines on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('condenses a card that passes and still names what fails', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    await expect(card(page, 'cachyos-g14').getByText('tmux')).toHaveCount(0)
    await expect(card(page, 'cachyos-g14').getByText('4 of 4 checks')).toBeVisible()
    await expect(card(page, 'nas').getByText('agent-cli')).toBeVisible()
  })
})
