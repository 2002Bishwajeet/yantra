import { expect, scenario, test } from './lib/test'

/** Y-736: the bell opened in 400 ms or more because React holds a lazy Suspense
 *  reveal back for 300 ms. The popup is now mounted closed once the page is idle,
 *  so the click only opens it. The ceiling is generous; the fault cost 300 ms by itself. */
test('opens the bell popover within a quarter second of the first click', async ({ page, size }) => {
  test.skip(size !== 'desktop', 'only the desktop bar has a popover')
  await scenario(page, 'notifications')
  await page.route('**/api/notifications', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const rows = body.data
    body.data = Array.from({ length: 30 }, (_, i) => ({ ...rows[i % rows.length], at: rows[i % rows.length].at - i * 7 }))
    await route.fulfill({ response: res, json: body })
  })
  const loaded = page.waitForResponse(/\/BellPopover-/)
  await page.goto('/')
  const bell = page.getByRole('button', { name: /^Notifications/ })
  await expect(bell).toBeVisible()
  await page.waitForLoadState('networkidle')
  await loaded
  // Let the idle mount land; a click before it is the slow path this guards against.
  await page.waitForTimeout(500)

  const took = await bell.evaluate(
    (el) =>
      new Promise<number>((done) => {
        const t0 = performance.now()
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const poll = () => {
          const pop = document.querySelector('.m3-popover')
          if (pop?.checkVisibility()) done(performance.now() - t0)
          else requestAnimationFrame(poll)
        }
        poll()
      }),
  )
  expect(took).toBeLessThan(250)
})
