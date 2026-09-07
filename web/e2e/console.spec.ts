import { expect, scenario, test } from './lib/test'
import { ROUTES } from './lib/routes'
import type { Scenario } from './lib/scenario'

/* Y-352: the console stays clean. Every route on every scenario at every size
 * prints nothing but the browser's own line for a non-2xx response. */

const SCENARIOS: readonly Scenario[] = [
  'busy',
  'empty',
  'firstrun',
  'broken',
  'nogrant',
  'repair',
  'unreachable',
  'down',
]

/** The browser logs a failed response itself, from outside the page; no code
 *  in the page can suppress it. */
const ALLOWED = /^Failed to load resource: the server responded with a status of \d+/

const PATHS = [
  ...ROUTES.map((one) => one.path),
  '/w/landing?view=spend',
  '/settings/providers',
  '/nowhere',
]

for (const name of SCENARIOS) {
  test(`on ${name}: no console error, warning or page error`, async ({ page }) => {
    const seen: string[] = []
    let path = ''
    page.on('pageerror', (error) => {
      seen.push(`${path}: pageerror ${error.message}`)
    })
    page.on('console', (message) => {
      const type = message.type()
      if (type !== 'error' && type !== 'warning') return
      if (ALLOWED.test(message.text())) return
      seen.push(`${path}: ${type} ${message.text()}`)
    })

    await scenario(page, name)
    for (path of PATHS) {
      await page.goto(path)
      // The screen has drawn: its own heading, or the board a failed read puts
      // in its place, which carries no `h1`.
      await expect(page.locator('h1, [role="alert"]').first()).toBeVisible()
      await page.waitForLoadState('networkidle')
    }

    expect(seen, `console messages:\n${seen.join('\n')}`).toEqual([])
  })
}
