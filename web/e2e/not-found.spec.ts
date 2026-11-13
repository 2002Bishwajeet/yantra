import { axe, expect, scenario, screenshot, test } from './lib/test'

/** Y-772: every missing name or path draws the one NotFound screen. The phone
 *  hides the PageHeader's h1 under the app bar's, so "Not found" is read from
 *  whichever of the two is on screen. */
const MISSING = [
  { path: '/nope', way: 'Dashboard' },
  { path: '/m/nosuch', way: 'Machines' },
  { path: '/m/nosuch/home', way: 'Machines' },
  { path: '/w/nosuch', way: 'Fleet' },
  { path: '/rooms/nosuch', way: 'All rooms' },
  { path: '/settings/plugins', way: 'Dashboard' },
] as const

for (const one of MISSING) {
  test(`${one.path} is the one not-found screen`, async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto(one.path)

    await expect(page.getByRole('heading', { level: 1, name: 'Not found' }).first()).toBeVisible()
    const way = page.getByRole('link', { name: one.way, exact: true }).and(page.locator('[data-variant="tonal"]'))
    await expect(way).toHaveCount(1)
    await expect(page.locator('.m3-not-found').getByRole('link')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Details' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)

    const box = await page.locator('.m3-not-found').boundingBox()
    const main = await page.locator('.shell__main').boundingBox()
    expect(box).not.toBeNull()
    expect(main).not.toBeNull()
    const gap = Math.abs(box!.x + box!.width / 2 - (main!.x + main!.width / 2))
    expect(gap, 'the block is centred in what the pane has left').toBeLessThanOrEqual(8)

    if (size === 'phone') {
      const tap = await way.boundingBox()
      expect(tap!.height).toBeGreaterThanOrEqual(48)
    }

    await axe(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    if (one.path === '/nope') await screenshot(page, 'not-found-nope', 'busy', size)
    if (one.path === '/m/nosuch') await screenshot(page, 'not-found-machine', 'busy', size)
  })
}
