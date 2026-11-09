import { axe, expect, firstReading, keyboardWalk, scenario, screenshot, test } from './lib/test'
import type { Page } from '@playwright/test'

/* Y-346. `smoke.spec.ts` holds `/`'s screenshots against the board; this spec
   is what the Main, MainCompact, MainDark and EmptyDashboard boards say the
   page must carry, at all three sizes. */

/** Write `shell/prefs.ts`'s key before the first paint, which is where
   `index.html` reads the theme and the density from. */
async function prefer(page: Page, patch: { theme?: string; density?: string }) {
  await page.addInitScript((prefs) => {
    localStorage.setItem(
      'yantra.prefs',
      JSON.stringify({ v: 1, seenAt: null, seed: null, general: {}, theme: 'system', density: 'clean', ...prefs }),
    )
  }, patch)
}

const region = (page: Page, name: string) => page.getByRole('region', { name })

test.describe('the dashboard on a busy fleet', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/')
    await firstReading(page)
  })

  test('draws the strip, the hero, Running and Worth a look', async ({ page }) => {
    await expect(page.getByText('5 of 6 machines online')).toBeVisible()
    // D7 §3.3 and §4.9: a machine the tailnet sees off is asleep, and Open
    // replaces Fix.
    await expect(page.getByText(/thinkpad asleep/)).toBeVisible()
    await expect(page.getByRole('link', { name: /^Open/ }).and(page.locator('[href="/m/thinkpad"]'))).toBeVisible()

    const hero = region(page, 'Needs you')
    await expect(hero.getByText('things are waiting on you')).toBeVisible()
    await expect(hero.getByText('yantra-web is waiting for trust')).toBeVisible()
    await expect(hero.getByRole('link', { name: 'Answer' })).toBeVisible()

    const running = region(page, 'Running')
    await expect(running.getByRole('progressbar')).toHaveCount(3)

    const worth = region(page, 'Worth a look')
    await expect(worth.getByRole('link', { name: 'Attach' })).toHaveCount(2)
    await expect(worth.getByRole('button', { name: 'Kill' })).toHaveCount(2)
    await expect(worth.getByRole('button', { name: 'Adopt' })).toHaveCount(0)
  })

  test('keeps the New session button off the "waiting on you" headline', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the FAB floats over the page only on a phone')
    // nogrant leaves GitHub unset, so Finish setup sits above the hero and pushes the headline down.
    await scenario(page, 'nogrant')
    await page.goto('/')
    await firstReading(page)
    await expect(region(page, 'Finish setup')).toBeVisible()
    const words = page.locator('.dash__hero-words')
    await expect(words).toBeVisible()
    // Y-670: .shell__main scrolls and this fixture is not tall enough to scroll the line to the FAB.
    // A spacer above the dashboard puts the line level with the FAB, then the test measures the text and not the box.
    await words.evaluate((el) => {
      const text = el.getBoundingClientRect()
      const fab = document.querySelector('.shell__fab')!.getBoundingClientRect()
      const spacer = document.createElement('div')
      spacer.style.height = `${Math.max(0, fab.top + fab.height / 2 - (text.top + text.height / 2))}px`
      document.querySelector('.dash')!.before(spacer)
    })
    const gap = await page.evaluate(() => {
      const fab = document.querySelector('.shell__fab')!.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('.dash__hero-words')!)
      return [...range.getClientRects()].map(
        (line) => line.top < fab.bottom && fab.top < line.bottom && line.left < fab.right && fab.left < line.right,
      )
    })
    expect(gap.length).toBeGreaterThan(0)
    expect(gap.some(Boolean)).toBe(false)
  })

  test('has one h1, which on the phone is the app bar', async ({ page, size }) => {
    const h1 = page.locator('h1:visible')
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Dashboard')
    // Only the phone's title belongs to the shell's app bar.
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveCount(
      size === 'phone' ? 1 : 0,
    )
  })

  test('opens Idle from its disclosure', async ({ page }) => {
    const show = page.getByRole('button', { name: /Show/ })
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await show.click()
    await expect(show).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('link', { name: /docs-sweep/ }).first()).toBeVisible()
  })

  test('asks before Kill and never before Attach', async ({ page }) => {
    await region(page, 'Worth a look').getByRole('button', { name: 'Kill' }).first().click()
    const asking = page.getByRole('dialog')
    await expect(asking).toBeVisible()
    // The question repeats the row it was asked from (BRIEF.md).
    await expect(asking.getByText('scratch', { exact: true })).toBeVisible()
    await expect(asking.getByRole('button', { name: 'Cancel' })).toBeVisible()
    // Escape rather than the tap: the phone's bottom sheet draws under the
    // navigation bar, which is Shell.css's z-index and not this screen's.
    await page.keyboard.press('Escape')
    await expect(asking).toBeHidden()
    await expect(page.getByRole('link', { name: 'Attach' }).first()).toBeVisible()
  })

  test('passes axe and walks by keyboard', async ({ page }) => {
    await axe(page)
    await keyboardWalk(page, 12)
  })
})

test.describe('the dashboard on an empty fleet', () => {
  test('says what each block would hold, and offers New session', async ({ page }) => {
    await scenario(page, 'empty')
    await page.goto('/')
    await firstReading(page)
    await expect(region(page, 'Needs you').getByText('Nothing needs you')).toBeVisible()
    await expect(region(page, 'Running').getByText('Nothing is running')).toBeVisible()
    await expect(
      region(page, 'Worth a look').getByText(
        'every tmux session on the machines that answered belongs to a workspace',
      ),
    ).toBeVisible()
    await expect(page.getByText('No workspaces yet')).toBeVisible()
    // The shell's FAB offers the same verb; this is the hero's own.
    await expect(page.getByRole('main').getByRole('link', { name: 'New session' })).toBeVisible()
    await axe(page)
  })
})

test.describe('the dashboard in Compact', () => {
  test.beforeEach(async ({ page }) => {
    await prefer(page, { density: 'compact' })
    await scenario(page, 'busy')
    await page.goto('/')
    await firstReading(page)
  })

  test('expands Idle and draws Recent beside it', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
    await expect(page.getByRole('button', { name: /Show/ })).toHaveCount(0)
    await expect(region(page, 'Idle').getByRole('link')).toHaveCount(4)
    await expect(region(page, 'Recent').getByText('last 3 session events')).toBeVisible()
    await axe(page)
  })

  test('looks like the board', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'MainCompact is a desktop board')
    await screenshot(page, 'dashboard-compact', 'busy', size)
  })
})

test.describe('the dashboard in the dark', () => {
  test.beforeEach(async ({ page }) => {
    await prefer(page, { theme: 'dark' })
    await scenario(page, 'busy')
    await page.goto('/')
    await firstReading(page)
  })

  test('draws the same page on the dark roles, and axe still passes', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(region(page, 'Needs you').getByText('things are waiting on you')).toBeVisible()
    await axe(page)
  })

  test('looks like the board', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'MainDark is a desktop board')
    await screenshot(page, 'dashboard-dark', 'busy', size)
  })
})
