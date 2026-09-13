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
    // Every basic is present, so the chip reads the verdict (D7 §3.3).
    await expect(good.getByText('ready')).toBeVisible()
    await expect(good.getByText('4 of 4 checks')).toBeVisible()
    await expect(good.getByRole('button')).toHaveCount(0)

    const short = card(page, 'pi-5')
    // The check name table, never a raw id (D7 §3.5).
    await expect(short.getByText('claude', { exact: true })).toBeVisible()
    await expect(short.getByText('no `claude` on PATH there')).toBeVisible()
    await expect(short.getByText('1 failing')).toBeVisible()
    // `git` is not in pi-5's report at all, so it counts as missing too.
    await expect(short.getByText('2 missing')).toBeVisible()
    await expect(short.getByRole('button', { name: 'Install' })).toBeVisible()

    const gone = card(page, 'thinkpad')
    // The tailnet says thinkpad is off: asleep, not failed (D7 §3.3).
    // Finding 128: the board dates the chip `7 Jul`, not `2026-07-07`.
    await expect(gone.getByText('asleep · 7 Jul', { exact: true })).toBeVisible()
    await expect(gone.getByText('1 failing · 3 unknown')).toBeVisible()
    await expect(gone.getByRole('button')).toHaveCount(0)
  })

  test('starts an install when Install is pressed', async ({ page }) => {
    const asked = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/machines/pi-5/install'),
    )
    await card(page, 'pi-5').getByRole('button', { name: 'Install' }).click()
    await asked
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
    // Y-360: past a day the age is a date, and a date takes no `ago`.
    await expect(worth.getByText(/opened \d{1,2} \w{3} ago/)).toHaveCount(0)
    await expect(worth.getByText(/opened \d{1,2} \w{3}$/).first()).toBeVisible()
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
    await expect(card(page, 'nas').getByText('claude', { exact: true })).toBeVisible()
  })
})

test.describe('the machines list when an install is refused', () => {
  test('shows the daemon’s words', async ({ page }) => {
    await scenario(page, 'refused')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    await card(page, 'pi-5').getByRole('button', { name: 'Install' }).click()
    const alert = card(page, 'pi-5').getByRole('alert')
    await expect(alert).toContainText('Install did not start')
    await expect(alert).toContainText('node biswas-iphone is on this tailnet but is not yours')
  })
})

test.describe('the machines list with devices that open the dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'setup')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  })

  test('keeps a phone and Windows apart, uncounted and without a Fix', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Open' })).toHaveCount(4)
    await expect(page.getByRole('region', { name: 'iphone' })).toHaveCount(0)

    const devices = page.getByRole('region', { name: 'Devices that open the dashboard' })
    await expect(devices.getByText('iphone')).toBeVisible()
    await expect(devices.getByText('gaming-pc')).toBeVisible()
    await expect(devices.getByText('coming soon', { exact: true })).toBeVisible()
  })

  test('reads a missing basic as Install, and a refused key as Copy join command', async ({ page }) => {
    await expect(card(page, 'missing-mac').getByText('2 missing')).toBeVisible()
    await expect(card(page, 'missing-mac').getByRole('button', { name: 'Install' })).toBeVisible()

    const refused = card(page, 'refused-box')
    await expect(refused.getByText('key refused')).toBeVisible()
    await expect(refused.getByRole('button', { name: 'Copy join command' })).toBeVisible()
    await expect(refused.getByRole('button', { name: 'Install' })).toHaveCount(0)
  })

  test('is asleep, not failed, and offers nothing to press', async ({ page }) => {
    const asleep = card(page, 'asleep-laptop')
    await expect(asleep.getByText(/^asleep · /)).toBeVisible()
    await expect(asleep.getByRole('button')).toHaveCount(0)
  })

  test('looks like the board', async ({ page, size }) => {
    await axe(page)
    await screenshot(page, 'machines', 'setup', size)
  })
})
