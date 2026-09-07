import {
  axe,
  expect,
  firstReading,
  keyboardWalk,
  scenario,
  screenshot,
  test,
} from './lib/test'

// write.rs `Refused::NotYours`, as refused.json carries it.
const REFUSAL = 'node biswas-iphone is on this tailnet but is not yours'

/** `/` on a busy fleet and an empty one, at every size. Phase 2 replaces the
 *  page under this spec, not the spec. */
for (const fleet of ['busy', 'empty'] as const) {
  test.describe(`/ on ${fleet}`, () => {
    test.beforeEach(async ({ page }) => {
      await scenario(page, fleet)
      await page.goto('/')
      await firstReading(page)
    })

    test('passes axe', async ({ page }) => {
      // The old page: the destructive badge is 3.98:1 and the kbd 4.34:1.
      // Phase 2's page removes this list, and the test fails if it does not.
      await axe(page, { known: ['color-contrast'] })
    })

    test('walks by keyboard', async ({ page }) => {
      await keyboardWalk(page, 8)
    })

    test('looks like the board', async ({ page, size }) => {
      await screenshot(page, 'dashboard', fleet, size)
    })
  })
}

/** The error scenarios (owner, 2026-09-06: errors are designed and tested).
 *  Where the old page falls short the step is `fixme` with the reason, so
 *  Phase 2's ErrorSurface turns it green by deleting a line. */
test.describe('/ on unreachable', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'unreachable')
    await page.goto('/')
  })

  test('draws an error surface, and axe still passes', async ({ page }) => {
    await expect(page.getByRole('alert').first()).toBeVisible()
    await axe(page, { known: ['color-contrast'] })
  })

  test('offers Try again', async ({ page }) => {
    test.fixme(true, 'the old page has no Try again; ErrorSurface is Y-339')
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  })
})

test.describe('/ on refused', () => {
  test("a write shows the daemon's text", async ({ page }) => {
    await scenario(page, 'refused')
    await page.goto('/')
    await firstReading(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: REFUSAL })).toBeVisible()
  })
})

test.describe('/ on flaky', () => {
  test('Try again recovers from a read that failed once', async ({ page }) => {
    await scenario(page, 'flaky')
    await page.goto('/')
    await expect(page.getByRole('alert').first()).toBeVisible()
    test.fixme(true, 'the old page has no Try again; it repolls in 5 s instead')
    await page.getByRole('button', { name: 'Try again' }).click()
    await firstReading(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
