import type { Page } from '@playwright/test'
import { at } from './lib/sizes'
import { expect, scenario, test } from './lib/test'

/* Finding 107, WCAG 1.4.4. A name, a path or an ssh error used to end in an
   ellipsis with the cut words nowhere else on the page, and the more a person
   zoomed the less of it was left.

   200 % page zoom halves the viewport in CSS pixels and leaves the text at the
   size it already had, so a viewport at half a board's width lays out exactly
   what that board lays out zoomed. Each test below reads its route at 100 %,
   halves the viewport, and asks every box that promises not to overflow
   whether its content still fits. */

/** The boxes that promise it: `.m3-wrap`, which the screens use in place of
 *  the old ellipsis, and the two rows in `Fleet.css` that cut their own line.
 *
 *  `.m3-clip` still cuts inside `Row`, `ListItem` and `TopAppBar`, and those
 *  are `m3/` files another wave owns — see §4. */
const BOXES = '.m3-wrap, .fleet__name, .fleet__machine'

/** Never under 320 CSS pixels: that is the floor 1.4.10 names for reflow, and
 *  the phone's 195 crushes every row layout the build has, which is a
 *  different defect from this one. */
async function halve(page: Page, size: 'phone' | 'tablet' | 'desktop') {
  const { width, height } = at(size).viewport
  await page.setViewportSize({
    width: Math.max(320, Math.round(width / 2)),
    height: Math.round(height / 2),
  })
}

/** Every box whose content is wider than the box, named by what it holds. */
function cut(page: Page) {
  return page.evaluate((selector) => {
    const boxes = [...document.querySelectorAll<HTMLElement>(selector)]
    return boxes
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.className} — ${el.textContent?.trim().slice(0, 60) ?? ''}`)
  }, BOXES)
}

/** How many were measured, so a route that drew none cannot pass by drawing
 *  nothing. */
function measured(page: Page) {
  return page.evaluate((selector) => document.querySelectorAll(selector).length, BOXES)
}

const looked = (page: Page) => page.locator('[data-slot="looked"]').first()

const PAGES = [
  {
    path: '/',
    ready: (page: Page) => page.getByText(/as of /).first(),
    // Both of the dashboard's names sit in the Idle band, which the busy board
    // draws folded.
    reveal: (page: Page) => page.getByRole('button', { name: /^Show/ }).first().click(),
  },
  { path: '/fleet', ready: looked },
  { path: '/machines', ready: looked },
  // `/m/cachyos-g14` is not here: its rows crush the text column at 390, so
  // the two sites finding 107 names there still clip — see §4.
  { path: '/w/landing', ready: (page: Page) => page.getByRole('heading', { name: 'landing' }) },
]

test.describe('at 200 % zoom no name, path or error is cut', () => {
  for (const one of PAGES) {
    test(one.path, async ({ page, size }) => {
      await scenario(page, 'busy')
      await page.goto(one.path)
      await expect(one.ready(page).first()).toBeVisible({ timeout: 15_000 })
      if ('reveal' in one && one.reveal) await one.reveal(page)

      await halve(page, size)
      await expect(one.ready(page).first()).toBeVisible()

      expect(await measured(page)).toBeGreaterThan(0)
      // Polled: a read can land after the resize and lay the page out again.
      await expect.poll(() => cut(page), { timeout: 5_000 }).toEqual([])
    })
  }

  /* Usage names a model and a workspace only after the fan-out, so this one
     asks for the read first. */
  test('/usage', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/usage')
    await page.getByRole('button', { name: 'Read spend' }).click()
    const read = page.getByText('10 workspaces read')
    await expect(read).toBeVisible({ timeout: 15_000 })

    await halve(page, size)
    await expect(read).toBeVisible()

    expect(await measured(page)).toBeGreaterThan(0)
    await expect.poll(() => cut(page), { timeout: 5_000 }).toEqual([])
  })
})

/* The proof by hand, on the longest string the busy fixture carries. */
test('the whole ssh error is laid out on /machines at 200 % zoom', async ({ page, size }) => {
  await scenario(page, 'busy')
  await page.goto('/machines')
  await expect(looked(page)).toBeVisible({ timeout: 15_000 })
  await halve(page, size)

  const detail = page.getByText('connect to host thinkpad port 22: No route to host').first()
  await expect(detail).toBeVisible()
  const box = await detail.evaluate((el) => ({ content: el.scrollWidth, box: el.clientWidth }))
  expect(box.content).toBeLessThanOrEqual(box.box + 1)
})
