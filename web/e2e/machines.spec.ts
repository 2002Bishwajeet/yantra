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
    await expect(good.getByText('10 of 10')).toBeVisible()
    await expect(good.getByRole('button')).toHaveCount(0)

    const short = card(page, 'pi-5')
    // The check name table, never a raw id (D7 §3.5).
    await expect(short.getByText('claude', { exact: true })).toBeVisible()
    await expect(short.getByText('not found')).toBeVisible()
    await expect(short.getByText('6 of 9 · 2 failing · 1 unknown')).toBeVisible()
    // `git` is not in pi-5's report at all, so it counts as missing too.
    await expect(short.getByText('2 missing')).toBeVisible()
    await expect(short.getByRole('button', { name: 'Install' })).toBeVisible()

    const gone = card(page, 'thinkpad')
    // The tailnet says thinkpad is off: asleep, not failed (D7 §3.3).
    // Finding 128: the board dates the chip `7 Jul`, not `2026-07-07`.
    await expect(gone.getByText('asleep · 7 Jul', { exact: true })).toBeVisible()
    // ssh failed too, so one sentence stands in for a tally nobody could ask (Y-714).
    await expect(gone.getByText(/can’t reach thinkpad over ssh/)).toBeVisible()
    await expect(gone.getByRole('button', { name: /install|copy|again/i })).toHaveCount(0)
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

/** Y-582: the busy fleet's hub is cachyos-g14, drawn first and apart. */
test.describe('the hub on a busy fleet', () => {
  test('is first, in its own section, with the note about shared CPU and memory', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    const hub = page.getByRole('region', { name: 'Hub' })
    await expect(hub.getByRole('region', { name: 'cachyos-g14' })).toBeVisible()
    await expect(hub.getByText('Agents on the hub share its CPU and memory with Yantra.')).toBeVisible()
    const grid = page.locator('.machines__grid')
    await expect(grid.getByRole('region', { name: 'cachyos-g14' })).toHaveCount(0)
    const [above, below] = await Promise.all([hub.boundingBox(), grid.boundingBox()])
    expect(above!.y).toBeLessThan(below!.y)
  })
})

test.describe('the machines on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('condenses a card that passes and still names what fails', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    await expect(card(page, 'cachyos-g14').getByText('tmux')).toHaveCount(0)
    await expect(card(page, 'cachyos-g14').getByText('10 of 10')).toBeVisible()
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

    // Y-580: a phone has no action here, so the page draws no section for it.
    await expect(page.getByRole('region', { name: 'Devices that open the dashboard' })).toHaveCount(0)
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
    await expect(asleep.getByRole('button', { name: /install|copy|again/i })).toHaveCount(0)
  })

  test('looks like the board', async ({ page, size }) => {
    await axe(page)
    await screenshot(page, 'machines', 'setup', size)
  })
})

test.describe('the machines list with no clipboard', () => {
  test('selects nothing, but says so, rather than doing nothing silently', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }))
    await scenario(page, 'setup')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    const button = card(page, 'refused-box').getByRole('button', { name: 'Copy join command' })
    await button.click()
    await expect(page.getByText(/This page has no clipboard/)).toBeVisible()
    await expect(button).toBeVisible()
  })
})

/* Y-733: one short line per problem on a card, and the sudo note is one line. */
test.describe('the problems on a machine card', () => {
  test('keeps each failing row to one line of at most eight words, and the sudo note to one', async ({ page, size }) => {
    await scenario(page, 'problems')
    await page.goto('/machines')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    const mac = card(page, 'macbook')
    // Y-740: hetzner-1's claude is installed, but the account that runs agents cannot run it.
    const closed = card(page, 'hetzner-1')
    const rows = mac.locator('.machines__check')
    await expect(rows.first()).toBeVisible()
    // The phone hides the row's word, so the cause itself says installed and names Install.
    await expect(closed.locator('.machines__detail')).toBeVisible()
    await expect(closed.locator('.machines__detail')).toHaveText('installed, no access; Install')
    await expect(closed.getByText('1 to install')).toBeVisible()
    await expect(closed.getByRole('button', { name: 'Install' })).toBeVisible()
    await expect(closed).not.toContainText(/missing|not found/)
    await expect(mac.getByText('installed; update it')).toBeVisible()
    for (const row of [...(await rows.all()), ...(await closed.locator('.machines__check').all())]) {
      const cause = row.locator('.machines__detail')
      const words = ((await cause.textContent()) ?? '').trim().split(/\s+/).length
      expect(words).toBeLessThanOrEqual(8)
      // Not wrapped: one line of body-small text, whatever the width.
      expect(((await cause.boundingBox())!.height)).toBeLessThanOrEqual(24)
      // Not cut: no ellipsis, so the whole cause shows.
      const [client, scroll] = await cause.evaluate((el) => [el.clientWidth, el.scrollWidth])
      expect(scroll).toBeLessThanOrEqual(client)
    }
    const note = mac.getByRole('note')
    await expect(note).toHaveText('Agents here can use sudo')
    expect((await note.boundingBox())!.height).toBeLessThanOrEqual(24)
    await expect(mac.getByRole('button', { name: /^Fix/ })).toHaveCount(0)
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(over).toBeLessThanOrEqual(0)
    await screenshot(page, 'machines', 'problems', size)
  })
})
