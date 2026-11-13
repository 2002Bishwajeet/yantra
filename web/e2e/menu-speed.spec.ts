import type { Locator, Page } from '@playwright/test'
import { expect, scenario, test } from './lib/test'

async function mountedClosed(page: Page) {
  await page.waitForLoadState('networkidle')
  // Let the idle mount land; a tap before it is the slow path this guards against.
  await page.waitForTimeout(500)
  // Reduced motion hides a late enter transition from the timing below, so also require the closed menu to be mounted before the tap.
  await expect(page.locator('.m3-menu')).toBeAttached()
}

/** Y-765: a menu first mounted by the tap opened after 300 ms or more in WebKit. Both menus
 *  now mount closed once the page is idle, so the tap only opens them. */
async function opens(trigger: Locator) {
  const page = trigger.page()
  await mountedClosed(page)
  await page.evaluate(() => {
    const seen = { t0: 0, visible: 0 }
    Object.assign(window, { menuSeen: seen })
    addEventListener('pointerdown', () => (seen.t0 = performance.now()), { capture: true, once: true })
    const poll = () => {
      if (seen.t0 && document.querySelector('.m3-menu')?.checkVisibility()) seen.visible = performance.now()
      else requestAnimationFrame(poll)
    }
    poll()
  })
  await trigger.tap()
  await page.waitForFunction(() => (window as unknown as { menuSeen: { visible: number } }).menuSeen.visible > 0)
  const took = await page.evaluate(() => {
    const it = (window as unknown as { menuSeen: { t0: number; visible: number } }).menuSeen
    return it.visible - it.t0
  })
  expect(took).toBeLessThan(250)
}

test.describe('the phone menus open within a quarter second of the first tap', () => {
  test.skip(({ size }) => size !== 'phone', 'the phone projects run Chromium and WebKit at 390 px')

  test('Account', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/')
    const account = page.getByRole('button', { name: 'Account' })
    await expect(account).toBeVisible()
    await opens(account)
  })

  test('More actions', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/w/yantra-web')
    const more = page.getByRole('button', { name: 'More actions' })
    await expect(more).toBeVisible()
    await opens(more)
  })
})

/** Runs in the page, from before the tap to 600 ms after it. WebKit has no long-task entry, so a
 *  MessageChannel ping-pong (React's scheduler does the same) times each task and rendering update. */
const watchOpen = () => {
  const popup = document.querySelector('.m3-menu')!
  const count = () => ({
    items: popup.querySelectorAll('[role=menuitem]').length,
    // The page polls the daemon every 5 s; a chunk or a stylesheet is what the tap must not fetch.
    fetched: performance.getEntriesByType('resource').filter((entry) => !entry.name.includes('/api/')).length,
  })
  const before = count()
  const properties = new Set<string>()
  const easings = new Set<string>()
  let tap = 0
  let gap = 0
  let offset = 0
  addEventListener('pointerdown', () => (tap = performance.now()), { capture: true, once: true })
  const over = () => tap > 0 && performance.now() - tap > 600
  const frame = () => {
    for (const animation of popup.getAnimations()) {
      if (!(animation instanceof CSSTransition)) continue
      properties.add(animation.transitionProperty)
      easings.add(getComputedStyle(popup).transitionTimingFunction)
    }
    if (!over()) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  const result = () => ({ gap, offset, before, after: count(), properties: [...properties], easings: [...easings] })
  const done = new Promise<ReturnType<typeof result>>((resolve) => {
    const { port1, port2 } = new MessageChannel()
    let last = performance.now()
    port1.onmessage = () => {
      const now = performance.now()
      if (tap && now - last > gap) {
        gap = now - last
        offset = last - tap
      }
      last = now
      if (!over()) return port2.postMessage(null)
      port1.close()
      resolve(result())
    }
    port2.postMessage(null)
  })
  // Wrapped: a handle to the bare promise would wait for a tap that has not happened yet.
  return { done }
}

/** Y-806: the open stuttered on an iPhone. Safari below 27.3 runs a `linear()` easing on the main
 *  thread. CI's WebKit is the Linux port and has no such limit, so the easing is asserted by name. */
async function opensSmoothly(trigger: Locator) {
  const page = trigger.page()
  await mountedClosed(page)
  const runs = []
  for (let run = 0; run < 5; run++) {
    const watch = await page.evaluateHandle(watchOpen)
    await trigger.tap()
    runs.push(await watch.evaluate((it) => it.done))
    await page.keyboard.press('Escape')
    await expect(page.locator('.m3-menu')).toBeHidden()
  }
  for (const { before, after, properties, easings } of runs) {
    expect(before.items).toBeGreaterThan(0)
    expect(after).toEqual(before)
    expect(properties.sort()).toEqual(['opacity', 'transform'])
    expect(easings.filter((easing) => easing.includes('linear('))).toEqual([])
  }
  const report = runs.map((it) => `${it.gap.toFixed(1)} ms starting ${it.offset.toFixed(1)} ms after the tap`).join('; ')
  const median = runs.map((it) => it.gap).sort((a, b) => a - b)[2]
  expect(median, `the longest main-thread gap of each open: ${report}`).toBeLessThan(16)
}

test.describe('the phone menus open on transform and opacity without holding the main thread', () => {
  test.skip(({ size }) => size !== 'phone', 'the phone projects run Chromium and WebKit at 390 px')
  test.use({ reducedMotion: 'no-preference' })

  for (const [name, path] of [['Account', '/'], ['More actions', '/w/yantra-web']]) {
    test(name, async ({ page }) => {
      await scenario(page, 'busy')
      await page.goto(path)
      const trigger = page.getByRole('button', { name })
      await expect(trigger).toBeVisible()
      await opensSmoothly(trigger)
    })
  }
})
