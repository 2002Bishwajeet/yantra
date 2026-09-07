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
      await axe(page)
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
    await axe(page)
  })

  test('offers Try again', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible()
  })
})

/* No Dashboard board offers Start, so the refusal a write draws is Fleet's
   (states.spec.ts sweeps the rest). */
test.describe('/fleet on refused', () => {
  test("a write shows the daemon's text", async ({ page, size }) => {
    // The phone keeps the idle rows behind a disclosure, so Start is not on
    // screen; `states.spec.ts` sweeps the wire at every route.
    test.skip(size !== 'desktop', 'the verb is not on the phone board')
    await scenario(page, 'refused')
    await page.goto('/fleet')
    const start = page.getByRole('button', { name: 'Start', exact: true }).first()
    await expect(start).toBeVisible()
    await start.click()
    await expect(page.getByRole('alert').filter({ hasText: REFUSAL }).first()).toBeVisible()
  })
})

test.describe('/ on flaky', () => {
  test('Try again recovers from a read that failed once', async ({ page }) => {
    await scenario(page, 'flaky')
    await page.goto('/')
    await expect(page.getByRole('alert').first()).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).first().click()
    await firstReading(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
