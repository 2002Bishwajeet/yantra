import { axe, expect, scenario, test } from './lib/test'
import { ROUTES, type Route } from './lib/routes'

/** Y-566: every route draws its body in one `Page` under one `PageHeader`, so
 *  the title and the first card share a left edge, the width stops at the
 *  token, and nothing scrolls sideways. The phone project is 390 px, the
 *  tablet 834 and the desktop 1440. */

const MAX = { wide: 1280, reading: 760 } as const

/** `/new` is a dialog over the dashboard except on the phone, where it is a page. */
const DIALOG_OFF_PHONE = ['new']

/** The five top-level routes keep the app bar's title without a back arrow. */
const TOP = ['dashboard', 'fleet', 'machines', 'usage', 'setup']

/** The terminal view is the one session column drawn at the wide width. */
const SWEEP = [
  ...ROUTES,
  { id: 'session-terminal-view', path: '/w/landing?view=terminal', heading: 'landing' },
] as readonly (Route | { id: string; path: string; heading: string })[]

for (const one of SWEEP) {
  test(`${one.id} ${one.path} keeps one left edge, one width and one scroll`, async ({ page, size }) => {
    test.skip(size !== 'phone' && DIALOG_OFF_PHONE.includes(one.id), 'a dialog, not a page, off the phone')
    await scenario(page, ('scenario' in one && one.scenario) || 'busy')
    await page.goto(one.path)
    const body = page.locator('.m3-page').first()
    await expect(body).toBeVisible()
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)

    // The first thing under the header that has a box: a `display: contents`
    // wrapper has none, so its children are the ones measured.
    const card = (await page.evaluate(() => {
      const page = document.querySelector('.m3-page')!
      const boxed = (parent: Element): DOMRect | null => {
        for (const child of Array.from(parent.children)) {
          if (child.matches('[data-slot="page-header"], .m3-sr-only')) continue
          if (getComputedStyle(child).display === 'contents') {
            const inner = boxed(child)
            if (inner) return inner
            continue
          }
          const rect = child.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) return rect
        }
        return null
      }
      const rect = boxed(page)
      return rect && { x: rect.x, width: rect.width }
    }))!
    expect(card, 'the page has nothing under its header').not.toBeNull()
    const column = (await body.boundingBox())!

    if (size === 'phone') {
      // The app bar is the title; its h1 and the page's are not both drawn.
      await expect(page.locator('.m3-page-header__h1')).toBeHidden()
      expect(Math.abs(card.x - 16)).toBeLessThanOrEqual(1)
      if (TOP.includes(one.id)) {
        const title = (await page.locator('.m3-top-app-bar__title').boundingBox())!
        expect(Math.abs(title.x - card.x)).toBeLessThanOrEqual(1)
      }
    } else {
      const title = page.locator('.m3-page-header__h1')
      await expect(title).toHaveText(one.heading)
      const box = (await title.boundingBox())!
      expect(Math.abs(box.x - card.x)).toBeLessThanOrEqual(1)
    }

    const width = (await body.getAttribute('data-width')) as keyof typeof MAX
    expect(column.width).toBeLessThanOrEqual(MAX[width] + 0.5)
    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(scrolls, 'the page scrolls sideways').toBe(false)
    await axe(page)
  })
}

test('every reading page starts where the wide column starts, the conversations included', async ({ page, size }) => {
  test.skip(size !== 'desktop', 'the frame is wider than the wide column only on the desktop')
  const edge = async (path: string, which: 'busy' | 'adding' | 'rooms') => {
    await scenario(page, which)
    await page.goto(path)
    return (await page.locator('.m3-page-header__h1').boundingBox())!.x
  }
  // The sessions rail narrows the frame on the dashboard, the session and New session, so each group
  // is compared with a wide page under the same shell.
  const groups = [
    ['/machines', 'busy', [['/machines/add', 'adding'], ['/no-such-page', 'busy'], ['/rooms/release', 'rooms'], ['/rooms', 'rooms']]],
    ['/', 'busy', [['/w/landing', 'busy'], ['/new', 'busy']]],
  ] as const
  for (const [wide, which, others] of groups) {
    const start = await edge(wide, which)
    for (const [path, one] of others) {
      expect(Math.abs((await edge(path, one)) - start), path).toBeLessThanOrEqual(1)
    }
  }
})

test('the session title and tabs stay put on the chat, the terminal and the open diff', async ({ page, size }) => {
  test.skip(size === 'phone', 'the phone draws its title in the app bar')
  await scenario(page, 'busy')
  const at = async () => ({
    title: (await page.locator('.m3-page-header__h1').boundingBox())!,
    tabs: (await page.getByRole('navigation', { name: 'Views' }).boundingBox())!,
  })
  await page.goto('/w/landing?view=chat')
  await expect(page.locator('.m3-page.session')).toHaveAttribute('data-width', 'wide')
  const chat = await at()
  await page.goto('/w/landing?view=terminal')
  const terminal = await at()
  await page.goto('/w/yantra-web?thread=1a2b3c4d')
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  const first = await at()
  await page.getByRole('button', { name: 'Diff', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Branch diff' })).toBeVisible()
  const diff = await at()
  expect(Math.abs(terminal.title.x - chat.title.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(terminal.tabs.x - chat.tabs.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(diff.title.x - first.title.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(diff.title.y - first.title.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(diff.tabs.x - first.tabs.x)).toBeLessThanOrEqual(1)
})

test.describe('at the iPad portrait width, 768 px', () => {
  test.use({ viewport: { width: 768, height: 1024 } })

  for (const path of ['/fleet', '/machines', '/', '/usage', '/notifications']) {
    test(`${path} keeps every button inside its row and its card`, async ({ page, size }) => {
      test.skip(size !== 'tablet', 'one project owns the 768 px viewport')
      await scenario(page, path === '/notifications' ? 'notifications' : 'busy')
      await page.goto(path)
      await expect(page.locator('.m3-page-header__h1')).toBeVisible()
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
      const out = await page.evaluate(() => {
        const bad: string[] = []
        const inside = (inner: DOMRect, outer: DOMRect) =>
          inner.left >= outer.left - 1 && inner.right <= outer.right + 1
        for (const control of document.querySelectorAll('.m3-page button, .m3-page a[role="button"]')) {
          const box = control.getBoundingClientRect()
          if (box.width === 0) continue
          const row = control.closest('.fleet__row, .m3-row, .github__item')
          if (row && !inside(box, row.getBoundingClientRect())) bad.push(`${control.textContent} leaves its row`)
          const card = control.closest('.m3-card')
          if (card && !inside(box, card.getBoundingClientRect())) bad.push(`${control.textContent} leaves its card`)
        }
        return bad
      })
      expect(out).toEqual([])
    })
  }

  test('a machine check drops its detail under its name', async ({ page, size }) => {
    test.skip(size !== 'tablet', 'one project owns the 768 px viewport')
    await scenario(page, 'busy')
    await page.goto('/machines')
    await expect(page.locator('.machines__check').first()).toBeVisible()
    for (const line of await page.locator('.machines__check').all()) {
      const name = (await line.locator('.m3-state').boundingBox())!
      const detail = (await line.locator('.machines__detail').boundingBox())!
      expect(detail.y).toBeGreaterThanOrEqual(name.y + name.height - 1)
      // Three lines at most, not a column of words.
      expect(detail.height).toBeLessThanOrEqual(52)
    }
  })

  test('a fleet row keeps its name, machine and age readable', async ({ page, size }) => {
    test.skip(size !== 'tablet', 'one project owns the 768 px viewport')
    await scenario(page, 'busy')
    await page.goto('/fleet')
    await expect(page.locator('.fleet__row').first()).toBeVisible()
    for (const title of await page.locator('.github__title').all()) {
      // A title in a column a word wide wraps to six lines.
      expect((await title.boundingBox())!.height).toBeLessThanOrEqual(48)
    }
    for (const name of await page.locator('.fleet__name').all()) {
      expect((await name.boundingBox())!.height).toBeLessThanOrEqual(48)
    }
  })
})

test('a supporting line with a state and an age keeps a gap between them', async ({ page }) => {
  await scenario(page, 'busy')
  await page.goto('/')
  const supporting = page.locator('.m3-row__supporting:has(> .m3-state)').first()
  await expect(supporting).toBeVisible()
  const gap = await supporting.evaluate((line) => {
    const clone = line.cloneNode(true) as HTMLElement
    const age = document.createElement('span')
    age.textContent = '3h'
    clone.append(age)
    line.after(clone)
    const state = clone.querySelector('.m3-state')!.getBoundingClientRect()
    return age.getBoundingClientRect().left - state.right
  })
  expect(gap).toBeGreaterThanOrEqual(6)
})

for (const [label, path, scrolls] of [
  ['an empty thread', '/w/landing', false],
  ['a short thread', '/w/yantra-web?thread=1a2b3c4d', true],
] as const) {
  test(`the last block of ${label} stays clear of the dock's scrim on a phone`, async ({ page, size }) => {
    test.skip(size !== 'phone', 'the dock is sticky only on the phone')
    await scenario(page, 'busy')
    await page.goto(path)
    const dock = page.locator('.chat__dock')
    await expect(dock).toBeVisible()
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible()
    // The thread list loads after the dock draws and must not leave the last block under it.
    await expect
      .poll(async () => {
        // A thread opens at its top, so only the empty page is read as it opens; it carries itself to the end.
        if (scrolls) await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        return dock.evaluate((el) => {
          const scrim = parseFloat(getComputedStyle(el, '::before').height)
          // The text, not its box: the intro and a turn can run past the block that holds them.
          const last = Math.max(
            ...[...el.previousElementSibling!.querySelectorAll('p, .turn, .chat__tool')].map((one) => one.getBoundingClientRect().bottom),
          )
          return el.getBoundingClientRect().top - scrim - last
        })
      })
      .toBeGreaterThanOrEqual(-0.5)
  })
}

test('the fleet keeps its stamp and its action in one row on a phone', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the phone is the one size that can wrap')
  await scenario(page, 'busy')
  await page.goto('/fleet')
  const stamp = page.locator('.m3-page-header__stamp')
  const action = page.locator('.m3-page-header__actions')
  await expect(stamp).toBeVisible()
  const [a, b] = [(await stamp.boundingBox())!, (await action.boundingBox())!]
  expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThanOrEqual(2)
})

test('all four session tabs fit in 390 px with none clipped', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the phone is the narrowest size')
  await scenario(page, 'busy')
  await page.goto('/w/landing')
  const nav = page.getByRole('navigation', { name: 'Views' })
  await expect(nav.getByRole('link')).toHaveCount(4)
  const edge = (await nav.boundingBox())!
  for (const link of await nav.getByRole('link').all()) {
    const box = (await link.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(edge.x - 0.5)
    expect(box.x + box.width).toBeLessThanOrEqual(edge.x + edge.width + 0.5)
  }
  expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test('a name does not break per character on a phone row', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the phone is the narrowest size')
  await scenario(page, 'busy')
  await page.goto('/fleet')
  for (const name of await page.locator('.fleet__name').all()) {
    const box = (await name.boundingBox())!
    // One line of body text, not a column of letters.
    expect(box.height).toBeLessThanOrEqual(24)
  }
})

test('a notification line is cut with an ellipsis or not at all', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the phone is the narrowest size')
  await scenario(page, 'notifications')
  await page.goto('/notifications')
  await expect(page.locator('.m3-row').first()).toBeVisible()
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll('.m3-clip')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .filter((el) => getComputedStyle(el).display !== 'block' || getComputedStyle(el).textOverflow !== 'ellipsis')
      .map((el) => el.textContent),
  )
  expect(cut, 'a line cut with no ellipsis').toEqual([])
  // The cut lines exist, so the check above is not vacuous.
  expect(await page.locator('.m3-row__supporting.m3-clip').count()).toBeGreaterThan(0)
})

test('an unclaimed session name does not break per character on a phone row', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the phone is the narrowest size')
  await scenario(page, 'busy')
  await page.goto('/machines')
  const names = page.locator('.machines__session .machines__name')
  await expect(names.first()).toBeVisible()
  for (const name of await names.all()) {
    expect((await name.boundingBox())!.height).toBeLessThanOrEqual(24)
  }
})
