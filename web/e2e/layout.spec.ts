import { axe, expect, scenario, test } from './lib/test'
import { ROUTES, type Route } from './lib/routes'

/** Y-566: every route draws its body in one `Page` under one `PageHeader`, so
 *  the title and the first card share a left edge, the width stops at the
 *  token, and nothing scrolls sideways. The phone project is 390 px, the
 *  tablet 834 and the desktop 1440. */

const MAX = { wide: 1280, reading: 760 } as const

/** `/new` is a dialog over the dashboard except on the phone, where it is a page. */
const DIALOG_OFF_PHONE = ['new']

/** The four destinations keep the app bar's title without a back arrow. */
const TOP = ['dashboard', 'fleet', 'machines', 'usage', 'setup']

for (const one of ROUTES) {
  test(`${one.id} ${one.path} keeps one left edge, one width and one scroll`, async ({ page, size }) => {
    test.skip(size !== 'phone' && DIALOG_OFF_PHONE.includes(one.id), 'a dialog, not a page, off the phone')
    await scenario(page, (one as Route).scenario ?? 'busy')
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
