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
  { id: 'access', label: 'Access', shows: 'Who may open the dashboard' },
  { id: 'about', label: 'About', shows: 'Listens on' },
] as const

/** Providers writes the boards' shorter string on a phone (row 114). */
const signedIn = (size: string) =>
  size === 'phone'
    ? 'Connected as 2002Bishwajeet'
    : 'signed in as 2002Bishwajeet · repositories, reviews, issues'

/** The list on a desktop and a tablet; a phone pushes the screen instead. */
const list = (page: Parameters<typeof axe>[0]) => page.getByRole('navigation', { name: 'Settings' })

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

  test('says a category it does not know is nowhere', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/plugins')
    await expect(page.getByText('The dashboard is where the sessions and machines are.')).toBeVisible()
    // The phone hides every screen's h1 under the app bar's, and Nowhere puts
    // its sentence in one (shell/Shell.tsx), so only the line under it shows.
    if (size !== 'phone') {
      await expect(page.getByText('Nothing is at /settings/plugins')).toBeVisible()
    }
  })
})

test.describe('settings · Appearance recolours everything', () => {
  test('a seed changes the scheme with no reload, and sage puts it back', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/appearance')
    await opened(page, 'Appearance', size)

    const primary = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim(),
      )
    const sage = await primary()

    await page.getByRole('button', { name: 'terracotta' }).click()
    await expect(page.getByRole('button', { name: 'terracotta' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(primary).not.toBe(sage)
    // The engine wrote both halves, so System still follows the OS.
    expect(await primary()).toContain('light-dark(')

    await page.getByRole('button', { name: 'sage' }).click()
    await expect.poll(primary).toBe(sage)
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
})

test.describe('settings · Providers', () => {
  test('walks the device flow and never draws a token', async ({ page, size }) => {
    await scenario(page, 'nogrant')
    await page.goto('/settings/providers')
    await opened(page, 'Providers', size)
    await expect(page.getByText('Not connected', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Connect', disabled: false }).click()
    const sheet = page.getByRole('dialog', { name: 'Connect GitHub' })
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Sign in with GitHub' }).click()

    await expect(sheet.getByText('WDJB-MJHT')).toBeVisible()
    await expect(sheet.getByRole('link', { name: 'github.com/login/device' })).toHaveAttribute(
      'href',
      'https://github.com/login/device',
    )
    await expect(sheet.getByText('repo', { exact: true })).toBeVisible()
    await screenshot(page, 'settings-connect', 'nogrant', size)

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
    await expect(page.getByText('Later · nothing uses it yet')).toBeVisible()
    await expect(page.getByText(/repositories, reviews, issues/)).toHaveCount(0)
    await expect(page.getByText(/for a future agent/)).toHaveCount(0)
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

    // What the daemon pushes reads rather than sets: no route changes it.
    await expect(page.getByRole('switch', { name: 'When an agent needs you' })).toBeDisabled()

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
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText(/^ntfy\.sh · Set · replaced just now/)).toBeVisible()

    expect(writes.filter((one) => one === 'POST /api/relay')).toHaveLength(1)
    // Nothing reads a relay back (§B4), in either direction.
    expect(writes.filter((one) => one.endsWith('/api/relay'))).toHaveLength(1)
  })
})

test.describe('settings · Access and About read the appliance', () => {
  test('names the key and shows the public half only in the sheet', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/access')
    await opened(page, 'Access', size)
    await expect(page.getByText('/home/<user>/.ssh/id_yantra')).toBeVisible()
    await expect(page.getByText(/^ssh-ed25519 AAAA/)).toBeHidden()
    await page.getByRole('button', { name: 'Show key' }).click()
    const sheet = page.getByRole('dialog', { name: 'Public key' })
    await expect(sheet.getByText(/^ssh-ed25519 AAAA/)).toBeVisible()
  })

  test('says the daemon facts and where its one file lives', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/settings/about')
    await opened(page, 'About', size)
    await expect(page.getByText(/^yantrad 0\.1\.0 · built 6 Sep · running/)).toBeVisible()
    await expect(page.getByText('aarch64-unknown-linux-musl')).toBeVisible()
    await expect(page.getByText('/etc/yantra/daemon.env')).toBeVisible()
  })
})
