import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { ROUTES } from './lib/routes'

/** Y-358: with nothing behind the proxy, every route draws the same one
 *  screen. The shell owns it, so a route that reads nothing swept — Settings,
 *  Notifications — draws it too, and no screen draws a second alert under it. */

const TITLE = 'Yantra cannot be reached'

/** The four destinations, which keep their navigation on every shell. A
 *  pushed screen on the phone has a back button instead. */
const DESTINATIONS = ['dashboard', 'fleet', 'machines', 'usage']

/** Names only the `busy` fixture knows. None may reach a page that read
 *  nothing: old fleet state on screen during an outage is the failure this
 *  row exists to close. A name in the URL is the address bar, not a read. */
const FIXTURE = ['cachyos-g14', 'price-table', 'thinkpad', 'landing']

for (const one of ROUTES) {
  test(`${one.path} draws the one screen and nothing else`, async ({ page, size }) => {
    await scenario(page, 'down')
    await page.goto(one.path)

    await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
    const board = page.getByRole('alert')
    await expect(board).toHaveCount(1)
    for (const words of [
      'yantrad was not reached: HTTP 502',
      'off the tailnet',
      'yantrad down',
      'retrying every 5 s',
    ]) {
      await expect(board.getByText(words).first()).toBeVisible()
    }
    await expect(board.getByRole('button', { name: 'Try again' })).toBeVisible()

    // Nothing is still loading, and nothing of the fleet is on screen.
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    for (const name of FIXTURE) {
      if (one.path.includes(name)) continue
      await expect(page.getByText(name)).toHaveCount(0)
    }

    if (DESTINATIONS.includes(one.id)) {
      await expect(page.getByRole('link', { name: 'Fleet' }).first()).toBeVisible()
    }

    await axe(page)
    if (one.id === 'dashboard') {
      await keyboardWalk(page, 6)
      await screenshot(page, 'daemon-unreachable', 'down', size)
    }
  })
}
