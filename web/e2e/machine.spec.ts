import type { Locator, Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/* Y-347, and D7 §4.3 since Y-396: one machine's page at all three sizes.
   Readiness leads, and its verdict decides the one action. */

const card = (page: Page, name: string) => page.getByRole('region', { name })

/** Y-714: one filled action a card; a tonal link is a Base UI button with data-variant. */
const filled = (scope: Locator) => scope.locator('[data-variant="filled"]')

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

  test('leads with a ready verdict and lists no check that passed', async ({ page }) => {
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('heading', { name: 'Ready for sessions' })).toBeVisible()
    await expect(ready.getByText(/^10 of 10 · asked/)).toBeVisible()
    await expect(ready.getByRole('link', { name: 'New session' })).toBeVisible()
    await expect(ready.getByText('ok', { exact: true })).toHaveCount(0)
    await expect(ready.locator('.machine__check')).toHaveCount(0)
    await expect(ready.getByRole('button', { name: /What ssh said/ })).toHaveCount(0)
    await expect(filled(ready)).toHaveCount(1)

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

  /* Y-748: the address and the tailnet name are list items, and their values share a left edge. */
  test('starts the About list values at one left edge', async ({ page, size }) => {
    const about = card(page, 'About')
    if (size === 'phone') await about.getByRole('button', { name: /^Show/ }).click()
    const edges = await about
      .locator('.m3-list-item__supporting')
      .evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().left)))
    expect(edges).toHaveLength(2)
    expect(new Set(edges).size).toBe(1)
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
    await expect(sessions.getByText('thinkpad is asleep')).toBeVisible()
    await expect(sessions.getByText(/No route to host/)).toHaveCount(0)
    await sessions.getByRole('button', { name: /What ssh said/ }).click()
    await expect(sessions.getByText(/No route to host/)).toBeVisible()
    await fits(page)
    await axe(page)
  })
})

test.describe('one machine missing a basic', () => {
  // nas's report has no `git` check at all: `missingBasics` (`lib/ready`)
  // counts an unasked basic as missing too, same as the machines-list card
  // (Y-402 review), so it joins tmux and claude's explicit absence.
  test('offers Install and no session, inside the screen', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/nas')
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('heading', { name: 'tmux, git and claude are missing' })).toBeVisible({ timeout: 15_000 })
    await expect(ready.getByRole('button', { name: 'Install' })).toBeVisible()
    await expect(filled(ready)).toHaveCount(1)
    await expect(filled(ready)).toHaveText('Install')
    // The shell's FAB is D7 T8's; this page offers no session of its own.
    await expect(ready.getByRole('link', { name: 'New session' })).toHaveCount(0)
    await expect(card(page, 'Workspaces on this machine').getByRole('link', { name: 'New session' })).toHaveCount(0)
    await fits(page)
  })
})

/* Y-748: the hero leads the page, and nothing is wider than the screen. */
test.describe('the machine hero', () => {
  test('is the first card, and the page fits', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/m/cachyos-g14')
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('heading', { level: 2 })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.machine__columns > :first-child')).toHaveClass(/readiness/)
    await expect(ready).toHaveAttribute('data-surface', 'primary')
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
    expect(scroll).toBeLessThanOrEqual(client)
    if (size === 'phone') {
      const action = await ready.getByRole('link', { name: 'New session' }).boundingBox()
      expect(action!.height).toBeGreaterThanOrEqual(48)
    }
  })
})

/* Y-714: a machine with a gap shows its first fix and one filled action, and no mono outside a command. */
test.describe('a machine with a gap', () => {
  test('/m/nas has one filled button, at most one fix and no stray mono', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/nas')
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('button', { name: 'Install' })).toBeVisible({ timeout: 15_000 })
    await expect(filled(ready)).toHaveCount(1)
    expect(await ready.locator('.machine__fix').count()).toBeLessThanOrEqual(1)
    const stray = await page.$$eval(
      '.machine__card .m3-mono',
      (all) => all.filter((one) => !one.closest('.m3-copyable')).length,
    )
    expect(stray).toBe(0)
    await fits(page)
  })

  test('draws the probe text in the body font', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/nas')
    const ready = card(page, 'Readiness')
    await ready.getByRole('button', { name: /^Show What ssh said/ }).click({ timeout: 15_000 })
    const line = ready.getByText(/^tmux: /)
    await expect(line).toBeVisible()
    const [said, mono] = await Promise.all([
      line.evaluate((el) => getComputedStyle(el).fontFamily),
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--md-ref-typeface-mono').trim()),
    ])
    expect(said).not.toContain(mono.split(',')[0]!.replace(/["']/g, ''))
  })
})

/* Y-676, Y-714: a phone reads the first fix, not a wall of probe text. */
test.describe('a machine page on a phone', () => {
  test.skip(({ size }) => size !== 'phone', 'the phone owns the page length')

  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
  })

  for (const name of ['nas', 'cachyos-g14']) {
    test(`/m/${name} is under two screens, with the failed probes behind What ssh said`, async ({ page }) => {
      await page.goto(`/m/${name}`)
      const readiness = card(page, 'Readiness')
      const press = readiness.getByRole('button', { name: /^Show What ssh said/ })
      await expect(readiness.getByRole('heading', { level: 2 })).toBeVisible({ timeout: 15_000 })
      const { tall, high } = await page.evaluate(() => ({
        tall: document.documentElement.scrollHeight,
        high: window.innerHeight,
      }))
      expect(tall).toBeLessThan(2 * high)
      if (name === 'cachyos-g14') {
        // Every check passed, so there is no probe text to fold.
        await expect(press).toHaveCount(0)
      } else {
        const said = readiness.getByText(/^tmux: /)
        await expect(said).toBeHidden()
        await press.click()
        await expect(said).toBeVisible()
      }
      await fits(page)
    })
  }
})

/* Y-733: a problem is one short line, and its fix opens on press. */
test.describe('the problems on a machine page', () => {
  test('draws each failing row as a list item, opens a fix with Copy, and scrolls a long command', async ({ page, size }) => {
    await scenario(page, 'problems')
    await page.goto('/m/macbook')
    const ready = card(page, 'Readiness')
    const rows = ready.locator('.machine__check')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    // Y-740: gh, the agent, the hooks and sudo are all on macbook, so no row says missing.
    await expect(ready).not.toContainText('missing')
    for (const row of await rows.all()) {
      const cause = row.locator('.machine__cause')
      const words = ((await cause.textContent()) ?? '').trim().split(/\s+/).length
      expect(words).toBeLessThanOrEqual(8)
      // Y-748: the cause wraps rather than being cut, and the row has a status mark.
      const [client, scroll] = await cause.evaluate((el) => [el.clientWidth, el.scrollWidth])
      expect(scroll).toBeLessThanOrEqual(client)
      await expect(row.locator('.m3-state .m3-mark')).toHaveCount(1)
    }
    // Y-714: only the first fix is offered, so one Fix is closed and the rest have none.
    const fix = ready.getByRole('button', { name: /^Fix/ })
    await expect(fix).toHaveCount(1)
    await expect(ready.getByRole('button', { name: /^Copy/ })).toHaveCount(0)
    if (size === 'phone') expect((await fix.boundingBox())!.height).toBeGreaterThanOrEqual(48)
    await fix.click()
    await expect(ready.getByRole('button', { name: /^Copy/ })).toBeVisible()
    expect(await ready.locator('.machine__fix').textContent()).not.toContain('`')
    for (const text of await ready.locator('.m3-copyable__text').all()) {
      const [client, scroll, height] = await text.evaluate((el) => [el.clientWidth, el.scrollWidth, el.clientHeight])
      expect(scroll).toBeGreaterThanOrEqual(client)
      // One line: body-small plus its 8 px padding.
      expect(height).toBeLessThanOrEqual(48)
    }
    await fits(page)
    await screenshot(page, 'machine', 'problems', size)
  })

  /* Y-740: a claude that is there is never called missing, and Install is its fix. */
  test('says an installed claude this account cannot run is installed, on an uncut line', async ({ page, size }) => {
    await scenario(page, 'problems')
    await page.goto('/m/hetzner-1')
    const ready = card(page, 'Readiness')
    await expect(ready.getByRole('heading', { name: 'claude is installed, but this account cannot run it' })).toBeVisible({ timeout: 15_000 })
    const cause = ready.locator('.machine__check', { hasText: 'claude' }).first().locator('.machine__cause')
    await expect(cause).toHaveText('installed, no access; Install')
    // Beside the Fix button the line is at its narrowest, and it is still whole.
    const [client, scroll] = await cause.evaluate((el) => [el.clientWidth, el.scrollWidth])
    expect(scroll).toBeLessThanOrEqual(client)
    await expect(ready.getByText('Install puts claude in this account’s home on hetzner-1, with the vendor’s installer.')).toBeVisible()
    await expect(filled(ready)).toHaveText('Install')
    await ready.getByRole('button', { name: /^Fix/ }).click()
    await expect(ready.locator('.machine__fix')).toContainText('claude is installed at /usr/local/bin/claude, but this account cannot run it.')
    await ready.getByRole('button', { name: /^Show What ssh said/ }).click()
    await expect(ready).not.toContainText(/missing|not found/)
    await fits(page)
    await screenshot(page, 'machine', 'problems-2', size)
  })
})

/* Y-701, ADR-0046 §2: the owner terminal, at 390 px and at the desktop. The
   fixture's shell asks for a password on `sudo` and echoes none of it. */
test.describe('the owner terminal on a machine', () => {
  test.skip(({ size }) => size === 'tablet', 'the phone and the desktop are the two sheets')

  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/m/cachyos-g14')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  })

  test('refuses a bad name inline, and keeps a good one for the machine', async ({ page }) => {
    const owner = card(page, 'Owner terminal')
    await owner.getByRole('button', { name: 'Open owner terminal' }).click()
    await expect(owner.getByText('Name the admin account first')).toBeVisible()
    const field = owner.getByRole('textbox', { name: 'Admin account' })
    await field.fill('-x')
    await expect(owner.getByText('An account name cannot start with - or .')).toBeVisible()
    await field.fill('owner')
    await expect(owner.getByText(/cannot start/)).toHaveCount(0)
    await page.reload()
    await expect(card(page, 'Owner terminal').getByRole('textbox', { name: 'Admin account' })).toHaveValue('owner')
  })

  test('shows the authorized_keys line with from=, and fits the screen', async ({ page, size }) => {
    const owner = card(page, 'Owner terminal')
    if (size === 'phone') await owner.getByRole('button', { name: /^Show/ }).click()
    await expect(owner.getByText(/^from="/)).toBeVisible()
    await expect(owner.getByRole('button', { name: 'Copy the authorized_keys line' })).toBeVisible()
    if (size === 'phone') {
      const open = owner.getByRole('button', { name: 'Open owner terminal' })
      expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(40)
    }
    await fits(page)
    await axe(page)
  })

  test('runs sudo with the password as keystrokes, and ends with the shell', async ({ page, size }) => {
    const owner = card(page, 'Owner terminal')
    await owner.getByRole('textbox', { name: 'Admin account' }).fill('owner')
    await owner.getByRole('button', { name: 'Open owner terminal' }).click()

    const name = 'owner on cachyos-g14'
    const sheet = size === 'phone' ? page.getByRole('dialog', { name }) : page.getByRole('complementary', { name })
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('.xterm-rows')).toContainText('owner@cachyos-g14:~$', { timeout: 15_000 })
    await axe(page)

    await sheet.locator('.xterm-helper-textarea').focus()
    // Escape is the shell's inside the sheet: closing on it would hang up sudo.
    await page.keyboard.press('Escape')
    await expect(sheet).toBeVisible()
    await page.keyboard.type('sudo id -u')
    await page.keyboard.press('Enter')
    await expect(sheet.locator('.xterm-rows')).toContainText('password for owner')
    await page.keyboard.type('hunter2')
    await page.keyboard.press('Enter')
    await expect(sheet.locator('.xterm-rows')).not.toContainText('hunter2')
    await page.keyboard.type('exit')
    await page.keyboard.press('Enter')
    await expect(sheet.getByText('The shell ended.')).toBeVisible({ timeout: 15_000 })
    await expect(sheet.getByRole('status').first()).toContainText('exited 0')

    await sheet.getByRole('button', { name: size === 'phone' ? 'Close' : `Close ${name}` }).click()
    await expect(sheet).toBeHidden()
  })
})
