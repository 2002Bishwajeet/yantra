import type { Locator, Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/** Y-350. `/settings` and `/settings/$category` on the busy fleet and on
 *  `nogrant`, where the daemon holds no GitHub grant. Every category is a
 *  route, so each one is opened directly rather than clicked to. */

const CATEGORIES = [
  { id: 'general', label: 'General', shows: 'Home directory for clones' },
  { id: 'notifications', label: 'Notifications', shows: 'Push relay' },
  { id: 'providers', label: 'Providers', shows: 'GitLab' },
  { id: 'agents', label: 'Agents', shows: 'Claude Code' },
  { id: 'appearance', label: 'Appearance', shows: 'Colour' },
  { id: 'devices', label: 'Devices', shows: 'A code for one new device' },
  { id: 'about', label: 'About', shows: 'Listens on' },
] as const

/** Providers writes the boards' shorter string on a phone (row 114). */
const signedIn = (size: string) =>
  size === 'phone'
    ? 'Connected as 2002Bishwajeet'
    : 'signed in as 2002Bishwajeet · repositories, reviews, issues'

/** The list on a desktop and a tablet; a phone pushes the screen instead. */
const list = (page: Parameters<typeof axe>[0]) => page.getByRole('navigation', { name: 'Settings' })

/** Y-379: every segment one width, and the group no wider than the segments it
 *  holds plus its own 1 px edges. The face has to land first, and one layout
 *  read gives both numbers — a swap between two reads reads as a gap. */
const equalSegments = async (page: Page, group: Locator, count: number) => {
  await expect(group.getByRole('radio')).toHaveCount(count)
  await page.evaluate(() => document.fonts.ready)
  const box = await group.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    segments: [...el.querySelectorAll('[role="radio"]')].map((one) => one.getBoundingClientRect().width),
  }))
  expect(new Set(box.segments.map((one) => one.toFixed(2))).size).toBe(1)
  const sum = box.segments.reduce((a, b) => a + b, 0)
  expect(Math.abs(box.width - (sum + 2))).toBeLessThan(1)
}

/** The settings chunk is lazy, so the first heading is a slower wait than the
 *  default; the phone's app bar is the h1 and the screen's own hides under it. */
const opened = async (page: Parameters<typeof axe>[0], label: string, size: string) => {
  const heading =
    size === 'phone'
      ? page.getByRole('heading', { level: 1 }).first()
      : page.getByRole('heading', { level: 2, name: label })
  await expect(heading).toBeVisible({ timeout: 20_000 })
}

for (const one of CATEGORIES) {
  test.describe(`settings · ${one.label}`, () => {
    test.beforeEach(async ({ page, size }) => {
      await scenario(page, 'busy')
      await page.goto(`/settings/${one.id}`)
      await opened(page, one.label, size)
    })

    test('draws its own rows and nobody else’s', async ({ page }) => {
      await expect(page.getByText(one.shows, { exact: true }).first()).toBeVisible()
      for (const other of CATEGORIES) {
        if (other.id === one.id) continue
        await expect(page.getByText(other.shows, { exact: true })).toHaveCount(0)
      }
    })

    test('passes axe', async ({ page }) => {
      await axe(page)
    })

    test('looks like the board', async ({ page, size }) => {
      await screenshot(page, `settings-${one.id}`, 'busy', size)
    })
  })

  test(`settings · ${one.label} passes axe with no grant`, async ({ page, size }) => {
    await scenario(page, 'nogrant')
    await page.goto(`/settings/${one.id}`)
    await opened(page, one.label, size)
    await expect(page.getByText(one.shows, { exact: true }).first()).toBeVisible()
    await axe(page)
  })
}

test.describe('the settings shell', () => {
  test('marks the open category and reaches every other one', async ({ page, size }) => {
    test.skip(size === 'phone', 'the phone draws an index, not a list beside a pane')
    await scenario(page, 'busy')
    await page.goto('/settings')
    // `/settings` itself opens the first category rather than an empty pane.
    await expect(page.getByRole('heading', { level: 2, name: 'General' })).toBeVisible()
    await expect(list(page).getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page')

    for (const one of CATEGORIES) {
      await list(page).getByRole('link', { name: one.label }).click()
      await expect(page).toHaveURL(`/settings/${one.id}`)
      await expect(page.getByRole('heading', { level: 2, name: one.label })).toBeVisible()
      await expect(list(page).getByRole('link', { name: one.label })).toHaveAttribute('aria-current', 'page')
    }
  })

  test('is an index of rows on a phone, each pushing its screen', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the index is the phone board')
    await scenario(page, 'busy')
    await page.goto('/settings')
    await expect(list(page)).toBeHidden()
    for (const one of CATEGORIES) {
      await expect(page.getByRole('link', { name: one.label })).toHaveAttribute(
        'href',
        `/settings/${one.id}`,
      )
    }
    await page.getByRole('link', { name: 'Providers' }).click()
    await expect(page).toHaveURL('/settings/providers')
    await expect(page.getByText('GitLab')).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page).toHaveURL('/settings')
    await screenshot(page, 'settings-index', 'busy', 'phone')
  })

  test('walks by keyboard', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/general')
    await opened(page, 'General', size)
    await keyboardWalk(page, 12)
  })

  test('says a category it does not know is nowhere', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/plugins')
    await expect(page.getByText('The dashboard is where the sessions and machines are.')).toBeVisible()
    // The headline is an h2, so the phone's hidden h1 does not take it.
    await expect(page.getByRole('heading', { name: 'Nothing is at /settings/plugins' })).toBeVisible()
  })
})

test.describe('settings · inputs on a touch screen', () => {
  for (const one of CATEGORIES) {
    test(`${one.label} has 16 px inputs, in view, with 44 px hit areas`, async ({ page, size }) => {
      test.skip(size === 'desktop', 'a pointer device does not zoom or tap')
      await scenario(page, 'busy')
      await page.goto(`/settings/${one.id}`)
      await opened(page, one.label, size)
      await expect(page.getByText(one.shows, { exact: true }).first()).toBeVisible()

      const small = await page.evaluate(() =>
        [...document.querySelectorAll('input, select, textarea')]
          .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
          .map((el) => el.outerHTML.slice(0, 80)),
      )
      expect(small, 'inputs under 16 px').toEqual([])

      const found = await page.evaluate(() => {
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            '[role=radio], [role=switch], [role=combobox], select, input:not([aria-hidden=true]), textarea',
          ),
        ].filter((el) => el.getClientRects().length > 0)
        const name = (el: HTMLElement) =>
          el.getAttribute('aria-label') || el.textContent?.trim() || el.id || el.tagName
        const failures: string[] = []
        for (const el of controls) {
          el.scrollIntoView({ block: 'center', inline: 'center' })
          const r = el.getBoundingClientRect()
          if (r.left < 0 || r.right > innerWidth) failures.push(`${name(el)}: outside the viewport`)
          // An overflow ancestor (the card) clips what it cannot hold.
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            if (getComputedStyle(a).overflowX === 'visible') continue
            const box = a.getBoundingClientRect()
            if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
              failures.push(`${name(el)}: clipped by ${a.className || a.tagName}`)
          }
          const x = r.left + r.width / 2
          const y = r.top + r.height / 2
          if (r.height < 44 && !el.matches('[role=radio], [role=switch]'))
            failures.push(`${name(el)}: ${Math.round(r.height)} px tall`)
          for (const dy of [-21, 21]) {
            const hit = document.elementFromPoint(x, y + dy)
            if (
              !hit ||
              !(el === hit || el.contains(hit) || hit.closest('label')?.contains(el))
            )
              failures.push(`${name(el)}: no hit at ${dy}px`)
          }
        }
        return { count: controls.length, failures }
      })
      expect(found.failures).toEqual([])
      if (['general', 'appearance'].includes(one.id)) expect(found.count).toBeGreaterThan(0)
    })
  }
})

test.describe('settings · phone rows', () => {
  for (const one of CATEGORIES) {
    test(`${one.label} stacks a wide trailing control under its text`, async ({ page, size }) => {
      test.skip(size !== 'phone', 'the stack is the phone layout')
      await scenario(page, 'busy')
      await page.goto(`/settings/${one.id}`)
      await opened(page, one.label, size)
      await expect(page.getByText(one.shows, { exact: true }).first()).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const failures = await page.evaluate(() => {
        const out: string[] = []
        for (const row of document.querySelectorAll('.m3-list__row')) {
          const text = row.querySelector('.m3-list-item__text')
          const trailing = row.querySelector('.m3-list-item__trailing')
          if (!text) continue
          for (const line of text.children) {
            const style = getComputedStyle(line)
            const lh = parseFloat(style.lineHeight)
            if (line.getBoundingClientRect().height > lh * 2 + 1) out.push(`${line.textContent}: taller than two lines`)
          }
          if (!trailing) continue
          const t = trailing.getBoundingClientRect()
          if (t.width <= 120) continue
          if (t.top < text.getBoundingClientRect().bottom - 0.5)
            out.push(`${text.textContent}: trailing ${Math.round(t.width)} px wide beside the text`)
        }
        return out
      })
      expect(failures).toEqual([])
    })
  }

  test('each Appearance choice and preview is 160 px tall or less', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the phone layout is the one that stacks')
    await scenario(page, 'busy')
    await page.goto('/settings/appearance')
    await opened(page, 'Appearance', size)
    await expect(page.getByText('Colour', { exact: true }).first()).toBeVisible()
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll('.settings__choice, .settings__preview')].map((el) => ({
        name: el.className,
        height: el.getBoundingClientRect().height,
      })),
    )
    expect(heights.length).toBe(4)
    for (const one of heights) expect(one.height, one.name).toBeLessThanOrEqual(160)
  })
})

test.describe('settings · Appearance recolours everything', () => {
  test('a seed changes the scheme with no reload, and brass puts it back', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/appearance')
    await opened(page, 'Appearance', size)

    const primary = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim(),
      )
    const brass = await primary()

    await page.getByRole('button', { name: 'terracotta' }).click()
    await expect(page.getByRole('button', { name: 'terracotta' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(primary).not.toBe(brass)
    // The engine wrote both halves, so System still follows the OS.
    expect(await primary()).toContain('light-dark(')

    await page.getByRole('button', { name: 'brass' }).click()
    await expect.poll(primary).toBe(brass)
  })

  test('holds the choice across a reload, on this device', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/appearance')
    await opened(page, 'Appearance', size)
    await page.getByRole('button', { name: /^Compact/ }).click()
    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
    expect(await page.evaluate(() => localStorage.getItem('yantra.prefs'))).toContain('"density":"compact"')
  })

  /** Y-379, the owner: *the custom hex colour and text input is colliding*.
   *  The field passes a `placeholder`, which overrode `TextField`'s `" "` and
   *  drew `#48674B` under the resting *Custom hex* label. */
  test('keeps the hex placeholder out of the label’s way', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/appearance')
    await opened(page, 'Appearance', size)

    const hex = page.getByRole('textbox', { name: 'Custom hex' })
    const ink = () => hex.evaluate((el) => getComputedStyle(el, '::placeholder').color)
    await expect.poll(ink).toBe('rgba(0, 0, 0, 0)')

    // The label floats on focus, and the placeholder takes the space it left.
    await hex.focus()
    await expect.poll(ink).not.toBe('rgba(0, 0, 0, 0)')
  })

  /** Y-379, the owner: *the switchbar for system option is too wide*. Material
   *  gives every segment one width, and the group hugs them. */
  test('draws the three theme segments at one width', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/appearance')
    await opened(page, 'Appearance', size)
    await equalSegments(page, page.getByRole('radiogroup', { name: 'Theme' }), 3)
  })
})

test.describe('settings · General', () => {
  /** Y-379 again, on a group of two: whatever squares three segments has to
   *  square two, and `Age` carries a check that `Clock` does not. */
  test('draws the two time-format segments at one width', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/general')
    await opened(page, 'General', size)
    await equalSegments(page, page.getByRole('radiogroup', { name: 'Time format' }), 2)
  })
})

test.describe('settings · Providers', () => {
  test('walks the device flow and never draws a token', async ({ page, size, browserName }) => {
    // WebKit has no clipboard permission to grant, and lets a tap write the clipboard without one.
    if (browserName !== 'webkit') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await scenario(page, 'nogrant')
    await page.goto('/settings/providers')
    await opened(page, 'Providers', size)
    await expect(page.getByText('Not connected', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Connect', disabled: false }).click()
    const sheet = page.getByRole('dialog', { name: 'Connect GitHub' })
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Sign in with GitHub' }).click()

    await expect(sheet.getByText('WDJB-MJHT')).toBeVisible()
    await expect(sheet.getByText('repo', { exact: true })).toBeVisible()
    await screenshot(page, 'settings-connect', 'nogrant', size)

    await sheet.getByRole('button', { name: 'Copy the code' }).click()
    await expect(sheet.getByRole('button', { name: 'Copied the code' })).toBeVisible()
    // WebKit lets a page write the clipboard on a tap but never lets the test read it back.
    const readable = browserName !== 'webkit'
    if (readable) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('WDJB-MJHT')
    if (readable) await page.evaluate(() => navigator.clipboard.writeText(''))

    // One tap copies the code and opens GitHub in a new tab; the route keeps the test off the network.
    await page.context().route('https://github.com/login/device', (route) => route.fulfill({ body: 'github' }))
    const popup = page.waitForEvent('popup')
    await sheet.getByRole('link', { name: 'Copy code and open GitHub' }).click()
    const tab = await popup
    await tab.waitForLoadState()
    expect(tab.url()).toBe('https://github.com/login/device')
    if (readable) await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('WDJB-MJHT')

    // The fixture's daemon completes the flow itself, as the real one polls.
    await expect(sheet.getByText('Signed in as 2002Bishwajeet.')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('body')).not.toContainText(/gh[pousr]_/)
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText(signedIn(size))).toBeVisible()
  })

  /** Row 114: the 390 px row clips rather than wraps, so the phone takes the
   *  boards' shorter strings (PhoneSettingsProviders). */
  test('shortens every row on a phone', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the shorter strings are the phone’s')
    await scenario(page, 'busy')
    await page.goto('/settings/providers')
    await opened(page, 'Providers', size)
    await expect(page.getByText('Connected as 2002Bishwajeet')).toBeVisible()
    await expect(page.getByText('nothing uses it yet · Later')).toBeVisible()
    await expect(page.getByText(/repositories, reviews, issues/)).toHaveCount(0)
    await expect(page.getByText(/for a future agent/)).toHaveCount(0)
  })

  /** D7 §4.6, N6: GitLab and OpenAI are not yet connectable, and a disabled
   *  Connect looked broken rather than later. */
  test('draws GitLab and OpenAI as "Later", never a disabled button', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/providers')
    await opened(page, 'Providers', size)
    await expect(page.getByText(/ · Later$/)).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Connect', disabled: true })).toHaveCount(0)
  })

  test('signs out from Manage', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/providers')
    await opened(page, 'Providers', size)
    await page.getByRole('button', { name: 'Manage' }).click()
    const sheet = page.getByRole('dialog', { name: 'GitHub' })
    await sheet.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  })
})

test.describe('settings · Notifications', () => {
  test('saves a relay through the one route that writes it', async ({ page, size }) => {
    await scenario(page, 'busy')
    const writes: string[] = []
    page.on('request', (one) => {
      if (one.method() !== 'GET') writes.push(`${one.method()} ${new URL(one.url()).pathname}`)
    })
    await page.goto('/settings/notifications')
    await opened(page, 'Notifications', size)

    // `about.relay` says the running daemon holds one (D7 §4.7).
    await expect(page.getByText('On · pushes to your relay')).toBeVisible()

    await page.getByRole('button', { name: 'Edit' }).click()
    const sheet = page.getByRole('dialog', { name: 'Push relay' })
    await expect(sheet).toBeVisible()
    const token = sheet.getByLabel('Token')
    await expect(token).toHaveAttribute('type', 'password')
    await sheet.getByLabel('Topic URL').fill('https://ntfy.sh/a-topic-nobody-guesses')
    await token.fill('tk_notarealtoken')
    await sheet.getByRole('button', { name: 'Show token' }).click()
    await expect(token).toHaveAttribute('type', 'text')
    await screenshot(page, 'settings-relay', 'busy', size)

    await sheet.getByRole('button', { name: 'Save and send a test' }).click()
    await expect(sheet.getByText('The test message arrived at the relay.')).toBeVisible()
    // Y-576: only the phone knows whether the test arrived, so the sheet asks.
    await expect(sheet.getByRole('heading', { name: 'Did it arrive?' })).toBeVisible()
    await sheet.getByRole('button', { name: 'Yes' }).click()
    await expect(sheet.getByText(/^Push works\./)).toBeVisible()
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(
      page.getByText('On · pushes to your relay · saved, used after a restart'),
    ).toBeVisible()

    expect(writes.filter((one) => one === 'POST /api/relay')).toHaveLength(1)
    // Nothing reads a relay back (§B4), in either direction.
    expect(writes.filter((one) => one.endsWith('/api/relay'))).toHaveLength(1)
  })

  /** ADR-0021: a daemon that never held a relay says so plainly, not just
   *  the sheet's own "nothing is read back" note. */
  test('says off when the daemon holds no relay', async ({ page, size }) => {
    await scenario(page, 'firstrun')
    await page.goto('/settings/notifications')
    await opened(page, 'Notifications', size)
    await expect(page.getByText('Off · nothing is pushed')).toBeVisible()
  })
})

test.describe('settings · About reads the appliance', () => {
  test('says who can open the dashboard', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/about')
    await opened(page, 'About', size)
    await expect(page.getByText('Only devices on your tailnet')).toBeVisible()
    await expect(page.getByText('No separate login')).toBeVisible()
  })

  // The key moved to Add a device, so the old link opens its new home.
  test('sends the old Access link to Add a device', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/access')
    await expect(page).toHaveURL(/\/machines\/add/)
    await expect(page.getByRole('heading', { level: 1, name: 'Add a device' })).toBeVisible()
  })

  test('says the daemon facts', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/about')
    await opened(page, 'About', size)
    await expect(page.getByText(/^yantrad 0\.1\.0 · built 6 Sep · running/)).toBeVisible()
    await expect(page.getByText('aarch64-unknown-linux-musl')).toBeVisible()
  })

  // Y-368: the fixture answers 202 and never restarts, so the page stays on
  // its updating line.
  test('asks for an update after saying what the restart ends', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/about')
    await opened(page, 'About', size)
    await page.getByRole('button', { name: 'Update to v0.4.0' }).click()
    const sheet = page.getByRole('dialog', { name: 'Update to v0.4.0?' })
    await expect(sheet.getByText(/A chat turn in flight dies/)).toBeVisible()
    await sheet.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Updating from' })).toBeVisible()
  })
})
