import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'

/** Y-351, inventory group 29: the first run. `/` draws the checklist instead
 *  of a Dashboard while no workspace exists (D3 §4.8), so the Setup,
 *  TabletSetup and PhoneSetup boards are this route on the `empty` scenario.
 *  The screen is Y-350's; the six steps and their words are asserted here. */

const STEPS = [
  'The appliance is on your tailnet',
  "This account's ssh key",
  'Machines',
  'GitHub',
  'Push to your phone',
  'Your first session',
]

// D3 §4.8: `/` draws the checklist while the machine list says nothing is on
// the tailnet, and the EmptyDashboard board once a machine is. `firstrun` is
// the fleet with no workspace and no machine online.
test.describe('the first run', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'firstrun')
    await page.goto(route('dashboard').path)
    // The phone's app bar draws the route's own h1 and hides the screen's
    // from the accessibility tree, so this one is found in the DOM.
    await expect(page.locator('h1', { hasText: 'Set up Yantra' })).toBeAttached()
  })

  test('draws six steps, how far along they are, and what each one is waiting on', async ({ page }) => {
    for (const step of STEPS) {
      await expect(page.getByText(step, { exact: true }).first()).toBeVisible()
    }
    await expect(page.getByText(/\d of 6 done/)).toBeVisible()
    await expect(page.getByRole('progressbar')).toBeVisible()
    await expect(page.getByText('waiting on you')).toBeVisible()
    await expect(page.getByRole('link', { name: 'New session' }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Skip for now' })).toBeVisible()
  })

  test('asks a machine for its checks only when told to', async ({ page }) => {
    const ask = page.getByRole('button', { name: /^Check/ }).first()
    await expect(ask).toBeVisible()
    await expect(page.getByText('0 of 6 machines ready')).toBeVisible()
    await ask.click()
    await expect(ask).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('passes axe', async ({ page }) => {
    await axe(page)
  })

  test('walks by keyboard', async ({ page }) => {
    await keyboardWalk(page, 10)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'setup', 'firstrun', size)
  })
})
