import type { Locator, Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/** The shell (Y-345): the four destinations at three widths, the palette,
 *  the bell, on the busy fleet. The screens under it are stubs until their
 *  rows land; this spec asks nothing of them but their heading. */
const DESTINATIONS = [
  ['Dashboard', '/'],
  ['Fleet', '/fleet'],
  ['Machines', '/machines'],
  ['Usage', '/usage'],
] as const

// The phone's app bar is a second h1 over the screen's hidden one.
const heading = (page: Parameters<typeof axe>[0], name: string) =>
  page.getByRole('heading', { level: 1, name }).first()

// The shell's FAB. A page may keep a tonal copy of the same action, so a
// query by name alone would find both.
const fab = (page: Page) => page.locator('.shell__fab, .shell__rail-fab')

/** D7 §4.1, S11 and S12 (Y-401): on the first run the checklist is `/`. */
test.describe('the FAB on the first run', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'firstrun')
    await page.goto('/')
    await expect(page.locator('h1', { hasText: 'Set up Yantra' }).first()).toBeAttached()
  })

  test('carries Add a device on the phone and the tablet, and the step keeps a tonal copy', async ({
    page,
    size,
  }) => {
    const add = page.getByRole('main').getByRole('link', { name: 'Add a device' })
    if (size === 'desktop') {
      await expect(add).toHaveAttribute('data-variant', 'filled')
      await expect(fab(page)).toHaveCount(0)
    } else {
      await expect(fab(page)).toHaveAccessibleName('Add a device')
      await expect(fab(page)).toHaveAttribute('href', '/machines/add')
      await expect(add).toHaveAttribute('data-variant', 'tonal')
    }
    // D7 §3.1: one filled action in the view, and it is the next thing.
    await expect(page.locator('main [data-variant="filled"]')).toHaveCount(size === 'desktop' ? 1 : 0)
    await axe(page)
  })

  test('hides the sessions rail on the desktop', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'the rail is the desktop shell')
    await expect(page.getByRole('link', { name: 'Add a device' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(0)
  })
})

test('draws no FAB while yantrad cannot be reached', async ({ page }) => {
  await scenario(page, 'down')
  await page.goto('/')
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(fab(page)).toHaveCount(0)
})

test.describe('the shell on busy', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/')
    await expect(heading(page, 'Dashboard')).toBeVisible()
  })

  test('reaches every destination, and says which is open', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' })
    for (const [label, path] of DESTINATIONS) {
      await nav.getByRole('link', { name: label }).click()
      await expect(page).toHaveURL(path)
      await expect(heading(page, label)).toBeVisible()
      await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page')
    }
  })

  test('passes axe', async ({ page }) => {
    await axe(page)
  })

  test('walks by keyboard', async ({ page }) => {
    await keyboardWalk(page, 8)
  })

  /** WCAG 2.4.11: the navigation bar and the FAB above it are fixed over the
   *  foot of the phone's scroll, so the page keeps room under whatever takes
   *  focus there and scrolls it clear of both. */
  test('keeps a control focused at the foot of the page clear of the fixed bar', async ({
    page,
    size,
  }) => {
    test.skip(size !== 'phone', 'the navigation bar and the FAB are the phone shell')
    await page.goto('/fleet')
    await expect(heading(page, 'Fleet')).toBeVisible()

    // The last control of a long page. The poll is the fleet's rows arriving,
    // and it is also the guard: a control already on screen proves nothing.
    const last = page.locator('main').locator('a[href], button:not([disabled])').last()
    const view = page.viewportSize()!
    await expect.poll(async () => (await last.boundingBox())?.y ?? 0).toBeGreaterThan(view.height)

    await last.focus()
    const focused = (await last.boundingBox())!
    const bar = (await page.locator('.m3-navigation-bar').boundingBox())!
    expect(focused.y + focused.height).toBeLessThanOrEqual(bar.y)
  })

  test('looks like the board', async ({ page, size }) => {
    // The heading is drawn before the reads land, and a picture of the
    // skeletons is a picture of no board at all.
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    // The rail's ages arrive with the sessions read, after the heading.
    if (size === 'desktop') {
      await expect(page.getByRole('complementary', { name: 'Sessions' }).getByText('39m')).toBeVisible()
    }
    await screenshot(page, 'shell', 'busy', size)
  })

  test('opens the palette with ⌘K, finds landing, and never runs a verb', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'only the desktop board draws a search; the rest list everything')
    await page.keyboard.press('ControlOrMeta+k')
    const dialog = page.getByRole('dialog', { name: 'Search' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox').fill('lan')
    await expect(dialog.getByRole('option', { name: /^landing running/ })).toBeVisible()
    await expect(dialog.getByText('Never runs a verb.')).toBeVisible()
    // The palette is a surface over the page: a full-page shot scrolls the
    // page under it and sometimes catches the dashboard alone.
    await screenshot(page, 'shell-palette', 'busy', size, { overlay: true })

    // `logs` and `tokens` are reads a person asked for, POSTed by design
    // (ADR-0019); `viewing` is presence. None is a verb.
    const READS = /\/api\/viewing$|\/(logs|tokens)$/
    const verbs: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/') && request.method() !== 'GET' && !READS.test(request.url())) {
        verbs.push(`${request.method()} ${request.url()}`)
      }
    })
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/w/landing?view=chat')
    await expect(heading(page, 'landing')).toBeVisible()
    expect(verbs).toEqual([])
  })

  /** Finding 129: the boards put the bell and the avatar at the foot of the
   *  rail, inside the one landmark, and draw no search. */
  test('gives the tablet no search, and its bell a sheet to name', async ({ page, size }) => {
    test.skip(size !== 'tablet', 'the rail is the tablet shell')
    await expect(page.getByRole('button', { name: /Search anything/ })).toHaveCount(0)
    const bell = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Notifications/ })
    await expect(bell).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Account' })).toBeVisible()
    const id = (await bell.getAttribute('aria-controls'))!
    await expect(page.locator(`#${id}`)).toHaveAttribute('aria-label', 'Notifications')
    await expect(bell).toHaveAttribute('aria-expanded', 'false')
  })

  /** Finding 112: five session boards draw the sessions rail beside the
   *  screen, and the rail marks the one that is open. */
  test('keeps the sessions rail beside a session', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'the rail is the desktop shell')
    await page.goto('/w/landing?view=chat')
    const rail = page.getByRole('complementary', { name: 'Sessions' })
    await expect(rail).toBeVisible()
    await expect(rail.getByRole('link', { name: /^landing running/ })).toHaveAttribute('data-tone', 'selected')
  })

  test('opens notifications, and Mark all read empties Unread', async ({ page, size }) => {
    const bell = page.getByRole(size === 'phone' ? 'link' : 'button', { name: /^Notifications/ })
    await expect(bell).toHaveAccessibleName(/unread/)
    // WCAG 1.4.10: the tablet's sheet floats over the page rather than taking
    // 420 px out of it, so the page reflows for nobody when it opens.
    const before = (await page.getByRole('main').boundingBox())!
    await bell.click()
    if (size === 'tablet') {
      const after = (await page.getByRole('main').boundingBox())!
      expect(after.width).toBe(before.width)
    }
    const list =
      size === 'desktop'
        ? page.getByRole('dialog', { name: 'Notifications' })
        : size === 'tablet'
          ? page.getByRole('complementary', { name: 'Notifications' })
          : page.getByRole('main')
    if (size === 'phone') await expect(page).toHaveURL('/notifications')
    await expect(list.getByText('yantra-web is waiting for trust')).toBeVisible()
    await expect(list.getByRole('link', { name: 'Answer' })).toHaveAttribute('href', '/w/yantra-web?view=chat')
    await expect(list.getByRole('heading', { name: 'Today' })).toBeVisible()
    await expect(list.getByRole('heading', { name: 'Earlier' })).toBeVisible()
    await screenshot(page, 'shell-notifications', 'busy', size, { overlay: size !== 'phone' })
    await axe(page)

    await list.getByRole('button', { name: 'Mark all read' }).click()
    await expect(list.getByText('Nothing unread.')).toBeVisible()
    await list.getByRole('radio', { name: 'All', exact: true }).click()
    await expect(list.getByText('yantra-web is waiting for trust')).toBeVisible()
  })

  /** D7 §3.6 (Y-401): the FAB carries the page's one next action, or is not
   *  drawn. The desktop keeps the action in the page. */
  test('carries each route’s next action on the phone and the tablet, and none on the desktop', async ({
    page,
    size,
  }) => {
    for (const [path, title, label] of [
      ['/', 'Dashboard', 'New session'],
      ['/fleet', 'Fleet', 'New session'],
      ['/machines', 'Machines', 'Add a device'],
      ['/usage', 'Usage', null],
    ] as const) {
      await page.goto(path)
      await expect(heading(page, title)).toBeVisible()
      if (size === 'desktop' || label === null) await expect(fab(page)).toHaveCount(0)
      else await expect(fab(page)).toHaveAccessibleName(label)
    }
  })

  /** The Readiness card holds this page's action, so a FAB would repeat it. */
  test('draws none on the machine page', async ({ page }) => {
    await page.goto('/m/nas')
    await expect(heading(page, 'nas')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'tmux and claude are missing' })).toBeVisible({ timeout: 15_000 })
    await expect(fab(page)).toHaveCount(0)
  })

  test('is a real control that the keyboard reaches and presses', async ({ page, size }) => {
    test.skip(size === 'desktop', 'the desktop draws no FAB')
    await page.goto('/machines')
    await expect(heading(page, 'Machines')).toBeVisible()
    await fab(page).focus()
    await expect(fab(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/machines/add')
  })

  /** In thumb reach: the bottom-right corner, above the navigation bar and
   *  inside the screen, however long its label is. */
  test('sits in thumb reach on the phone, clear of the navigation bar', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the extended FAB is the phone’s')
    const view = page.viewportSize()!
    const box = (await fab(page).boundingBox())!
    const bar = (await page.locator('.m3-navigation-bar').boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(view.width - 16)
    expect(box.x).toBeGreaterThanOrEqual(16)
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y)
    expect(box.height).toBe(56)
  })

  /** Y-379, the owner: the account menu answered nothing under the pointer.
   *  `.m3-menu-item` had no `.m3-interactive`, and the `[data-highlighted]`
   *  rule it did have mixed a unitless `0.08` into `color-mix`, which is
   *  invalid, so the browser dropped it. One layer paints now, not two. */
  test('lights the account menu under the pointer', async ({ page, size }) => {
    await page.getByRole('button', { name: 'Account' }).click()
    const about = page.getByRole('menuitem', { name: 'About' })
    await expect(about).toBeVisible()

    const layer = (one: Locator) =>
      one.evaluate((el) => Number(getComputedStyle(el, '::before').opacity))
    // A tap opens on no item and a click opens on the first, so the arrow lands
    // on a different row at each size. Which one it is does not matter here.
    const hot = page.locator('[role="menuitem"][data-highlighted]')
    const cold = page.locator('[role="menuitem"]:not([data-highlighted])')

    await page.keyboard.press('ArrowDown')
    await expect(hot).toHaveCount(1)
    await expect.poll(() => layer(hot)).toBeGreaterThan(0)
    await expect.poll(() => layer(cold.first())).toBe(0)
    // The layer is the pseudo-element and nothing else: a fill on the item
    // itself would tint it twice under the pointer (`Menu.css`).
    await expect(hot).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    test.skip(size !== 'desktop', 'the pointer is the desktop’s')
    await about.hover()
    await expect.poll(() => layer(about)).toBeGreaterThan(0)
    await expect(about).toHaveCSS('cursor', 'pointer')
  })
})
