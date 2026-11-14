import type { Page } from '@playwright/test'

export type Scenario =
  | 'busy'
  | 'problems'
  | 'empty'
  | 'unreachable'
  | 'down'
  | 'nogrant'
  | 'refused'
  | 'ownaddress'
  | 'flaky'
  | 'contract'
  | 'broken'
  | 'repair'
  | 'firstrun'
  | 'install'
  | 'notifications'
  | 'adding'
  | 'stranger'
  | 'setup'
  | 'difffails'
  | 'gitfails'
  | 'mergefails'
  | 'removefails'
  | 'rooms'
  | 'composer'
  | 'background'
  | 'longrepo'
  | 'longtitle'
  | 'avatar'
  | 'avatarbroken'
  | 'hub'
  | 'fresh'
  | 'freshdefect'
  | 'checks'
  | 'loop'
  | 'signedout'

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
  options: { slow?: number; update?: boolean } = {},
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
  if (!options.update) {
    // Y-712: busy and notifications hold a newer release; keep its notice out of every other screenshot.
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem
      Storage.prototype.getItem = function (k: string) {
        const v = get.call(this, k)
        if (k !== 'yantra.prefs') return v
        try {
          return JSON.stringify({ v: 1, ...JSON.parse(v ?? '{}'), updateDismissed: '0.4.0', updateOpened: '0.4.0' })
        } catch {
          return v
        }
      }
    })
  }
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
