import type { Page } from '@playwright/test'

export type Scenario =
  | 'busy'
  | 'empty'
  | 'unreachable'
  | 'nogrant'
  | 'refused'
  | 'flaky'
  | 'contract'

/** Every stamp in the scenarios is aged against this instant, so an age reads
 *  the same on every run and in every screenshot. */
export const NOW = '2026-09-06T12:00:00Z'

/** Point the page at one scenario, on a copy of its state that no other test
 *  shares. Call before the first `goto`. `slow` holds every read for that many
 *  milliseconds, which is how a pending state is drawn. */
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
