import type { Locator, Page } from '@playwright/test'
import type { Scenario } from './lib/scenario'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { at } from './lib/sizes'
import { endGap, scrollTo } from './lib/scroller'

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

// The shell's FAB, found by class because the page's own links share its name.
const fab = (page: Page) => page.locator('.shell__fab, .shell__rail-fab')

/** D7 §4.1, S11 and S12 (Y-401): on the first run the checklist is `/`. */
test.describe('the FAB on the first run', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'firstrun')
    await page.goto('/')
    await expect(page.locator('h1', { hasText: 'Set up Yantra' }).first()).toBeAttached()
  })

  test('carries Add a device on the phone and the tablet, and the step draws no copy', async ({
    page,
    size,
  }) => {
    const add = page.getByRole('main').getByRole('link', { name: 'Add a device' })
    if (size === 'desktop') {
      await expect(add).toHaveAttribute('data-variant', 'filled')
      await expect(fab(page)).toHaveCount(0)
    } else {
      await expect(page.getByRole('link', { name: 'Add a device, quick action' })).toHaveAttribute('href', '/machines/add')
      await expect(add).toHaveCount(0)
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

/** Y-590: the tablet rail is sticky, so only the content scrolls. */
test.describe('the tablet rail on a scrolling page', () => {
  test.beforeEach(async ({ page, size }) => {
    test.skip(size !== 'tablet', 'the rail is the tablet shell')
    await scenario(page, 'busy')
  })

  const rail = (page: Page) => page.locator('.m3-rail')
  const scrollY = (page: Page) => page.evaluate(() => window.scrollY)

  test('stays put and fills the screen while the page scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 500 })
    await page.goto('/fleet')
    await expect(heading(page, 'Fleet')).toBeVisible()
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    const tall = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)
    expect(tall).toBe(true)

    const before = (await rail(page).boundingBox())!
    const mainBefore = (await page.getByRole('main').boundingBox())!
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0)

    const after = (await rail(page).boundingBox())!
    expect(after.x).toBe(before.x)
    expect(after.y).toBe(before.y)
    expect(after.height).toBe(await page.evaluate(() => window.innerHeight))
    expect((await page.getByRole('main').boundingBox())!.y).toBeLessThan(mainBefore.y)

    await expect(page.locator('.shell__rail-fab')).toBeInViewport()
    await expect(rail(page).getByRole('button', { name: /Notifications/ })).toBeInViewport()
    await expect(rail(page).getByRole('button', { name: 'Account' })).toBeInViewport()

    await page.evaluate(() => document.documentElement.style.setProperty('--m3-safe-top', '47px'))
    const inset = (await rail(page).boundingBox())!
    expect(inset.y).toBe(47)
    expect(inset.y + inset.height).toBe(await page.evaluate(() => window.innerHeight))
  })

})

test('draws no FAB while yantrad cannot be reached', async ({ page }) => {
  await scenario(page, 'down')
  await page.goto('/')
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(fab(page)).toHaveCount(0)
})

// Y-721: the daemon answered and every read failed, so New session has nowhere to go.
for (const path of ['/', '/fleet']) {
  test(`draws no New session while nothing on ${path} can be read`, async ({ page }) => {
    await scenario(page, 'unreachable')
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'The daemon could not read the fleet' })).toBeVisible()
    await expect(fab(page)).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^(New session|New)$/ })).toHaveCount(0)
  })
}

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

  test('opens the palette with ⌘K, finds landing, and runs no verb for a place', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'only the desktop board draws a search; the rest list everything')
    await page.keyboard.press('ControlOrMeta+k')
    const dialog = page.getByRole('dialog', { name: 'Search' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox').fill('lan')
    await expect(dialog.getByRole('option', { name: /^landing running/ })).toBeVisible()
    await expect(dialog.getByText('Finds a place or a thread by its title, or runs a step of the coding loop.')).toBeVisible()
    // The palette is a surface over the page: a full-page shot scrolls the
    // page under it and sometimes catches the dashboard alone.
    await screenshot(page, 'shell-palette', 'busy', size, { overlay: true })

    // `logs`, `tokens` and `threads` are reads a person asked for, POSTed by design
    // (ADR-0019); `viewing` is presence. None is a verb.
    const READS = /\/api\/viewing$|\/(logs|tokens|threads)$/
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

  /** M16 (Y-499): on a chat the palette runs the loop's verbs, and each opens the dialog that asks. */
  test('lists the loop on a chat, and Merge asks before it merges', async ({ page }) => {
    await page.goto('/w/yantra-web?thread=1a2b3c4d')
    await expect(page.getByText('Is the core crate green?')).toBeVisible()
    await page.locator('.chat__header').getByRole('button', { name: 'Git actions' }).click()
    await page.getByRole('menuitem', { name: 'Open PR' }).click()
    await expect(page.locator('.chat__header').getByRole('link', { name: 'PR #497' })).toBeVisible()

    const writes: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/') && request.method() === 'POST' && request.url().endsWith('/merge')) {
        writes.push(request.url())
      }
    })
    await page.keyboard.press('ControlOrMeta+k')
    // Two issues in the fixture, so Start from issue lists twice, then Diff, Commit, Push, Open PR and Merge.
    const dialog = page.getByRole('dialog', { name: 'Search' })
    const commands = dialog.getByRole('group', { name: 'Commands' })
    await expect(commands.getByRole('option')).toHaveCount(7)
    await dialog.getByRole('combobox').fill('merge')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Merge PR #497' })).toBeVisible()
    expect(writes).toEqual([])
  })

  test('shows the shortcuts under ?', async ({ page }) => {
    await page.keyboard.press('Shift+Slash')
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('term')).toHaveCount(8)
    await axe(page)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
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

  /** Y-375: the menu, the popover and the sheet's list are chunks that arrive
   *  with the first press of their trigger, not with a cold `/`. */
  test('fetches a popup chunk with its first press, not with the shell', async ({ page, size }) => {
    const scripts: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname)
    })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Account' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    const fetched = (name: RegExp) => scripts.filter((one) => name.test(one))
    // Y-736: the desktop bell's popup loads once the page is idle, so the click only opens it.
    if (size !== 'desktop') expect(fetched(/\/(BellPopover|Notifications)-/)).toEqual([])

    await page.getByRole('button', { name: 'Account' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    // Y-765: the Account chunk now loads once the page is idle, so the press may find it fetched.
    expect(fetched(/\/Account-/).length).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()

    if (size === 'phone') return
    await page.getByRole('button', { name: /^Notifications/ }).click()
    const list =
      size === 'desktop'
        ? page.getByRole('dialog', { name: 'Notifications' })
        : page.getByRole('complementary', { name: 'Notifications' })
    await expect(list.getByText('yantra-web is waiting for trust')).toBeVisible()
    expect(fetched(size === 'desktop' ? /\/BellPopover-/ : /\/Notifications-/)).toHaveLength(1)
  })

  /** Y-375: the trigger is one element for the shell's life, so the first
   *  press never drops the focus to the body. */
  test('keeps the focus on the account trigger or in its menu', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Account' })
    await trigger.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement
          return active !== document.body && (active?.getAttribute('aria-haspopup') === 'menu' || !!active?.closest('[role="menu"]'))
        }),
      )
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
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
    await expect(list.getByText('Nothing unread')).toBeVisible()
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
      else await expect(page.getByRole('link', { name: `${label}, quick action` })).toBeVisible()
    }
  })

  /** The Readiness card holds this page's action, so a FAB would repeat it. */
  test('draws none on the machine page', async ({ page }) => {
    await page.goto('/m/nas')
    await expect(heading(page, 'nas')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'tmux, git and claude are missing' })).toBeVisible({ timeout: 15_000 })
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

    // Visible is not focused: the popup takes focus a frame later, and an arrow
    // pressed before that lands on the avatar and moves nothing.
    await expect(page.locator('[role="menu"]:focus-within')).toHaveCount(1)
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

/** Y-583: the GitHub profile image fills the account button at every width,
 *  and an image that does not load leaves the icon in the same box. */
test.describe('the account button', () => {
  const account = (page: Page) => page.getByRole('button', { name: 'Account' })
  const open = async (page: Page, name: Scenario) => {
    await scenario(page, name)
    await page.goto('/')
    await expect(account(page)).toBeVisible()
  }

  test('draws the profile image', async ({ page }) => {
    await open(page, 'avatar')
    const image = account(page).locator('img')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  test('falls back to the icon in the same box when the image does not load', async ({ page }) => {
    await open(page, 'contract')
    const icon = await account(page).boundingBox()

    await open(page, 'avatarbroken')
    await expect(account(page).locator('svg')).toBeVisible()
    await expect(account(page).locator('img')).toHaveCount(0)
    expect(await account(page).boundingBox()).toEqual(icon)
  })
})

/** Y-675: a short window without touch keeps the rail; a touch screen this short gets the phone shell. */
test.describe('the tablet rail on a short window', () => {
  test.beforeEach(async ({ size }) => {
    test.skip(size !== 'desktop', 'the desktop project has no touch, and 1024 px is under 1240')
  })

  const rail = (page: Page) => page.locator('.m3-rail')
  const scrollY = (page: Page) => page.evaluate(() => window.scrollY)

  test('scrolls its own items on a short landscape screen', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 400 })
    await page.goto('/fleet')
    await expect(heading(page, 'Fleet')).toBeVisible()

    const box = (await rail(page).boundingBox())!
    expect(box.height).toBe(await page.evaluate(() => window.innerHeight))
    const overflow = await rail(page).evaluate((el) => [el.scrollHeight, el.clientHeight])
    expect(overflow[0]).toBeGreaterThan(overflow[1])

    const account = rail(page).getByRole('button', { name: 'Account' })
    await account.scrollIntoViewIfNeeded()
    await expect(account).toBeInViewport()
    await account.click({ trial: true })

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
    expect((await rail(page).boundingBox())!.y).toBe(box.y)
  })
})

/** Y-675: a phone held sideways is a phone, whatever its width. */
test.describe('the phone shell on a phone held sideways', () => {
  test('is chosen on a touch screen under 480 px tall, and not on a mouse', async ({ page, size }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await page.goto('/')
    const shell = page.locator('[data-shell]')
    if (size === 'desktop') {
      await expect(shell).toHaveAttribute('data-shell', 'tablet')
      return
    }
    await expect(shell).toHaveAttribute('data-shell', 'phone')
    await expect(page.locator('nav.m3-navigation-bar')).toBeVisible()
    await expect(page.locator('.m3-rail')).toHaveCount(0)
  })
})

/** Y-670: the phone shell is an app frame. The top bar and the navigation bar hold still, and `.shell__main` scrolls. */
test.describe('the phone shell is an app frame', () => {
  test.beforeEach(async ({ page, size }) => {
    test.skip(size !== 'phone', 'the app frame is the phone shell')
    await scenario(page, 'busy')
  })

  const main = (page: Page) => page.locator('.shell__main')
  const frame = (page: Page) =>
    page.evaluate(() => ({
      barTop: document.querySelector('header')!.getBoundingClientRect().top,
      navBottom: document.querySelector('nav.m3-navigation-bar')?.getBoundingClientRect().bottom ?? window.innerHeight,
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      docOverflow: document.documentElement.scrollHeight - window.innerHeight,
    }))

  async function holdsWhileMainScrolls(page: Page, path: string, by = 300) {
    await page.goto(path)
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    const tall = await main(page).evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(tall).toBeGreaterThan(by)

    const before = await frame(page)
    await main(page).evaluate((el, y) => el.scrollTo(0, y), by)
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBe(by)
    const after = await frame(page)

    expect(after.barTop).toBe(0)
    expect(after.navBottom).toBe(after.innerHeight)
    expect(before.navBottom).toBe(before.innerHeight)
    expect(after.scrollY).toBe(0)
    expect(after.docOverflow).toBeLessThanOrEqual(0)
  }

  test('keeps both bars still while main scrolls', async ({ page }) => {
    await holdsWhileMainScrolls(page, '/')
  })

  test('keeps the back bar at the top of a pushed route', async ({ page }) => {
    await holdsWhileMainScrolls(page, '/notifications', 60)
    await expect(page.getByRole('button', { name: 'Back' })).toBeInViewport()
  })

  test('hands the scroll to main and stops the rubber band', async ({ page, browserName }) => {
    await page.goto('/')
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe('none')
    const style = await main(page).evaluate((el) => {
      const css = getComputedStyle(el)
      return { overflowY: css.overflowY, overscroll: css.overscrollBehaviorY }
    })
    expect(style).toEqual({ overflowY: 'auto', overscroll: 'contain' })
    // Y-660: Playwright has no wheel in mobile WebKit, so WebKit proves the styles and Chromium proves the scroll.
    if (browserName === 'webkit') return

    const box = (await main(page).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('restores the scroll position of main on back', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await main(page).evaluate((el) => el.scrollTo(0, 500))
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBe(500)
    await page.getByRole('link', { name: 'Fleet' }).last().click()
    await expect(page).toHaveURL(/\/fleet$/)
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBe(0)
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect.poll(() => main(page).evaluate((el) => el.scrollTop)).toBe(500)
  })
})

test('the tablet and desktop shells still scroll the document', async ({ page, size }) => {
  test.skip(size === 'phone', 'the phone shell is the app frame')
  await scenario(page, 'busy')
  await page.goto('/')
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  const style = await page.locator('.shell__main').evaluate((el) => getComputedStyle(el).overflowY)
  expect(style).toBe('visible')
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-shell]')!).overflow)).toBe('visible')
})

/** Y-673, Y-738: the FAB floats over the page as M3 draws it; scrolled to the end, nothing the reader can use or read sits under it. */
test.describe('the FAB on the phone leaves the end of the page clear', () => {
  const routes: [string, string, Scenario][] = [
    ['Dashboard', '/', 'busy'],
    ['Fleet', '/fleet', 'busy'],
    ['Machines', '/machines', 'busy'],
    ['Dashboard with Finish setup', '/', 'nogrant'],
  ]
  for (const [name, path, kind] of routes) {
    test(`lays the FAB over no control or text at the end: ${name}`, async ({ page, size }) => {
      test.skip(size !== 'phone', 'the FAB floats over the page only on a phone')
      await scenario(page, kind)
      await page.goto(path)
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
      await expect(page.locator('.shell__fab')).toBeVisible()

      await expect(async () => {
        await scrollTo(page, 'end')
        expect(await endGap(page)).toBe(0)
        const offenders = await page.evaluate(() => {
          const main = document.querySelector('.shell__main')!
          const box = main.getBoundingClientRect()
          const fab = document.querySelector('.shell__fab')!
          const f = fab.getBoundingClientRect()
          const rects: { text: string; r: DOMRect }[] = []
          for (const el of main.querySelectorAll('a, button')) {
            if (fab.contains(el)) continue
            rects.push({ text: (el.textContent ?? '').trim() || el.tagName, r: el.getBoundingClientRect() })
          }
          const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.textContent?.trim() || fab.contains(n)) continue
            const range = document.createRange()
            range.selectNodeContents(n)
            for (const r of range.getClientRects()) rects.push({ text: n.textContent.trim(), r })
          }
          return rects
            .filter(({ r }) => {
              const w = Math.min(r.right, box.right, f.right) - Math.max(r.left, box.left, f.left)
              const h = Math.min(r.bottom, box.bottom, f.bottom) - Math.max(r.top, box.top, f.top)
              return w > 0 && h > 0
            })
            .map(({ text }) => text.slice(0, 40))
        })
        expect(offenders, `under the FAB at the end of the page`).toEqual([])
      }).toPass()
    })
  }

  test('collapses to the icon on scroll down, keeps its name, and expands at the top', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the FAB floats over the page only on a phone')
    await scenario(page, 'busy')
    await page.goto('/')
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    const fab = page.locator('.shell__fab')
    await expect(fab).toBeVisible()
    const name = await fab.getAttribute('aria-label')
    expect(name).toContain('New session')
    const wide = (await fab.boundingBox())!.width
    await scrollTo(page, 300)
    await expect.poll(() => page.locator('.shell__main').evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
    await expect.poll(async () => (await fab.boundingBox())!.width).toBeLessThan(60)
    await expect(fab).toHaveAttribute('aria-label', name!)
    await scrollTo(page, 0)
    await expect.poll(() => page.locator('.shell__main').evaluate((el) => el.scrollTop)).toBe(0)
    await expect.poll(async () => (await fab.boundingBox())!.width).toBeGreaterThanOrEqual(wide - 1)
  })
})

/** Y-689: the palette finds a thread by its title, from the store, on a machine that is offline. */
test.describe('the palette on a phone finds a thread', () => {
  test.use(at('phone'))

  test('lists an offline machine’s thread, fits 390 px, and opens it', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/')
    await expect(heading(page, 'Dashboard')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    const dialog = page.getByRole('dialog', { name: 'Search' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox').fill('thread store')

    const row = dialog.getByRole('option', { name: /Keep a thread store/ })
    await expect(row).toBeVisible()
    await expect(row).toContainText('cargo-zig · thinkpad · offline')
    await expect(dialog.getByText('Finds a place or a thread by its title, or runs a step of the coding loop.')).toBeVisible()
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    expect(fits).toBe(true)
    await axe(page)

    await row.tap()
    await expect(page).toHaveURL(/\/w\/cargo-zig\?view=chat&thread=1a2b3c4d$/)
  })
})
