import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import type { Size } from './lib/sizes'
import { endGap, scrollTo } from './lib/scroller'

/* Y-347's screen, first pictured by Y-352. What the Fleet, TabletFleet and
   PhoneFleet boards say the page must carry, at all three sizes.
   `states.spec.ts` holds its empty and unreachable states. */

const band = (page: Page, name: string) => page.getByRole('region', { name })

test.describe('the fleet on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/fleet')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  })

  test('sorts every workspace into a band, each row a mark and a word', async ({ page }) => {
    const needs = band(page, 'Needs you')
    await expect(needs.getByText('waiting for trust')).toBeVisible()
    await expect(needs.getByText('crashed, exit 1')).toBeVisible()
    await expect(needs.getByRole('link', { name: 'Answer' })).toBeVisible()

    const running = band(page, 'Running')
    await expect(running.getByText('running', { exact: true })).toHaveCount(3)
    await expect(running.getByRole('link', { name: 'Open' })).toHaveCount(3)
    await expect(running.getByRole('button', { name: 'Stop' })).toHaveCount(3)

    const idle = band(page, 'Idle')
    await expect(idle.getByText('nothing running')).toBeVisible()
  })

  /* D3 §4.1: a dead machine is one row, and the workspaces behind it are not
     listed under it. */
  test('rolls the machine that did not answer into one row', async ({ page, size }) => {
    const needs = band(page, 'Needs you')
    await expect(needs.getByText('unreachable')).toBeVisible()
    await expect(needs.getByRole('link', { name: 'thinkpad' })).toBeVisible()
    await expect(needs.getByText('1 workspace', { exact: true })).toBeVisible()
    // Only the desktop board keeps a detail column; the other two drop it.
    if (size === 'desktop') await expect(needs.getByText(/can’t reach thinkpad over ssh/)).toBeVisible()
    await expect(needs.getByText(/No route to host/)).toHaveCount(0)
    await expect(needs.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', '/m/thinkpad')
    // The workspace on it is the row's cause, not a row of its own.
    await expect(page.getByRole('link', { name: 'cargo-zig' })).toHaveCount(0)
  })

  /* D6 §3: GitHub sits inside Needs you, under its own heading, and its links
     go to GitHub and nowhere else. */
  test('draws the GitHub block inside Needs you', async ({ page }) => {
    const github = band(page, 'On GitHub')
    await expect(github.getByRole('heading', { name: 'Reviews' })).toBeVisible()
    await expect(github.getByRole('heading', { name: 'Issues' })).toBeVisible()
    await expect(github.getByRole('link', { name: 'Review' })).toHaveCount(2)
    await expect(github.getByText('Y-330: the options round for D7')).toBeVisible()
  })

  test('folds Idle behind its own button and opens it again', async ({ page, size }) => {
    const show = band(page, 'Idle').getByRole('button', { name: /^Show/ })
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await expect(show).toContainText(size === 'phone' ? 'Show 4' : 'Show 1 more')
    await show.click()
    await expect(show).toHaveAttribute('aria-expanded', 'true')
    await expect(band(page, 'Idle').getByRole('link', { name: 'landing-copy' })).toBeVisible()
  })

  /* D3 §4.4: the order recomputes only when a person asks, so with nothing
     changed the pill has nothing to apply. */
  test('offers Reorder, disabled while no row has moved', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Reorder/ })).toBeDisabled()
  })

  test('has one h1, which on the phone is the app bar', async ({ page, size }) => {
    const h1 = page.locator('h1:visible')
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Fleet')
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveCount(
      size === 'phone' ? 1 : 0,
    )
  })

  test('passes axe and walks by keyboard', async ({ page }) => {
    await axe(page)
    await keyboardWalk(page, 12)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'fleet', 'busy', size)
  })
})

/* Finding 131. When nothing answers, the page used to title itself with a bare
   `<h1>Fleet</h1>` in the browser's own type beside a Material surface. */
test.describe('the fleet when nothing answers', () => {
  test('keeps the screen’s own title', async ({ page }) => {
    await scenario(page, 'unreachable')
    await page.goto('/fleet')
    const title = page.locator('h1.m3-page-header__h1')
    await expect(title).toHaveText('Fleet')
    await expect(page.getByRole('alert')).toBeVisible()
  })
})

/* Y-581. A review or an issue is one row at every width: the GitHub rows fill the
   card, a title keeps its words whole, and the actions stay inside the row. Each
   width is owned by one project, as layout.spec.ts owns 768. */
const WIDTHS: readonly { width: number; height: number; owner: Size }[] = [
  { width: 390, height: 844, owner: 'phone' },
  { width: 768, height: 1024, owner: 'tablet' },
  { width: 1280, height: 900, owner: 'desktop' },
  { width: 2000, height: 1000, owner: 'desktop' },
]

for (const { width, height, owner } of WIDTHS) {
  test.describe(`the GitHub queue at ${width} px`, () => {
    test.use({ viewport: { width, height } })

    test.beforeEach(async ({ page, size }) => {
      test.skip(size !== owner, `the ${owner} project owns ${width} px`)
      await scenario(page, 'longtitle')
      await page.goto('/fleet')
      await expect(band(page, 'On GitHub').getByRole('heading', { name: 'Issues' })).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    })

    test('fills the card, keeps whole words, and holds the actions inside the row', async ({ page }) => {
      const found = await page.evaluate(() => {
        const bad: string[] = []
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.github__item'))
        const inner = (card: HTMLElement) => {
          const style = getComputedStyle(card)
          return card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        }
        // A line break between two letters or digits is a word split in the middle.
        const split = (el: Element) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
            const text = node.data
            const range = document.createRange()
            let top: number | null = null
            let last = ''
            for (let i = 0; i < text.length; i++) {
              range.setStart(node, i)
              range.setEnd(node, i + 1)
              const rect = range.getClientRects()[0]
              if (text[i] === ' ') last = ''
              if (!rect || text[i] === ' ') continue
              if (top !== null && Math.abs(rect.top - top) > 4 && /[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(text[i]!))
                return `${text.slice(Math.max(0, i - 6), i)}|${text.slice(i, i + 6)}`
              top = rect.top
              last = text[i]!
            }
          }
          return null
        }
        for (const li of rows) {
          const name = li.querySelector('.github__ref')!.textContent
          const card = li.closest<HTMLElement>('.fleet__card')!
          const row = li.getBoundingClientRect()
          if (Math.abs(row.width - inner(card)) > 1) bad.push(`${name}: row ${row.width} is not the card's inner ${inner(card)}`)
          const actions = li.querySelector('.github__actions')!.getBoundingClientRect()
          const box = li.querySelector('.github__row')!.getBoundingClientRect()
          if (actions.left < box.left - 1 || actions.right > box.right + 1 || actions.bottom > box.bottom + 1)
            bad.push(`${name}: actions leave the row`)
          for (const part of li.querySelectorAll('.github__ref, .github__title')) {
            const at = split(part)
            if (at) bad.push(`${name}: a word breaks at ${at}`)
          }
        }
        return { bad, count: rows.length }
      })
      expect(found.count).toBe(13)
      expect(found.bad).toEqual([])
    })

    test('looks the same', async ({ page, size }) => {
      await screenshot(page, 'fleet', `longtitle-${width}`, size)
    })
  })
}

/* The phone's last row clears the FAB above the navigation bar. */
test('the last card on the phone clears the floating action button', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the FAB floats over the page on the phone only')
  await scenario(page, 'longtitle')
  await page.goto('/fleet')
  await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  const fab = page.locator('.shell__fab')
  await expect(fab).toBeVisible()
  await scrollTo(page, 'end')
  await expect.poll(() => endGap(page)).toBeGreaterThanOrEqual(-1)
  const last = (await page.locator('.fleet__card').last().boundingBox())!
  const button = (await fab.boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(button.y + 0.5)
})
