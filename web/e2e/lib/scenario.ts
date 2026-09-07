import type { Page } from '@playwright/test'

export type Scenario =
  | 'busy'
  | 'empty'
  | 'unreachable'
  | 'down'
  | 'nogrant'
  | 'refused'
  | 'flaky'
  | 'contract'
  | 'broken'
  | 'repair'
  | 'firstrun'

/** Every stamp in the scenarios is aged against this instant, so an age reads
 *  the same on every run and in every screenshot. */
export const NOW = '2026-09-06T12:00:00Z'

/** Point the page at one scenario, on a copy of its state that no other test
 *  shares. Call before the first `goto`. `slow` holds every read for that many
 *  milliseconds, which is how a pending state is drawn.
 *
 *  **The clock is fixed and the timers still run.** `setFixedTime` pins
 *  `Date.now()` and `new Date()` so an age reads the same on every run, and it
 *  leaves `setTimeout` and `setInterval` on real time. A poll fires, a retry
 *  fires and a transition ends; code that measures a duration by differencing
 *  two `Date.now()` calls measures zero. Assert what the page draws, never how
 *  long it took to draw.
 *
 *  **Do not close that gap with `install()` and `pauseAt()`.** The dashboard
 *  needs its timers. Under a paused clock 49 of the 54 desktop cases in
 *  `down`, `smoke`, `dashboard` and `session` fail, and the page never draws a
 *  first reading at all (Y-360, 2026-09-07). */
export async function scenario(
  page: Page,
  name: Scenario,
  options: { slow?: number } = {},
) {
  const key = Math.random().toString(36).slice(2, 8)
  const cookie = (n: string, value: string) => ({
    name: n,
    value,
    domain: '127.0.0.1',
    path: '/',
  })
  await page.context().addCookies([
    cookie('fixture-scenario', `${name}#${key}`),
    ...(options.slow ? [cookie('fixture-slow', String(options.slow))] : []),
  ])
  await page.clock.setFixedTime(NOW)
  return `${name}#${key}`
}

/** The page has drawn its first reading: the skeleton is gone and a stamp is
 *  on screen. Today's page stamps `as of`; a page that changes its idiom
 *  changes this one place. */
export async function firstReading(page: Page) {
  const { expect } = await import('@playwright/test')
  await expect(page.locator('[data-slot="reading"]')).toHaveCount(0)
  await expect(page.getByText(/as of /).first()).toBeVisible()
}
