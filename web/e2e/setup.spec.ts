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

const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'

// D3 §4.8: `/` draws the checklist while the machine list says nothing that
// runs a session is online. `firstrun` is the fleet with no workspace, no
// key yet, no relay, six machines asleep and an iPhone online (Y-388).
test.describe('the first run', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'firstrun')
    await page.goto(route('dashboard').path)
    // The phone's app bar draws the route's own h1 and hides the screen's
    // from the accessibility tree, so this one is found in the DOM.
    await expect(page.locator('h1', { hasText: 'Set up Yantra' }).first()).toBeAttached()
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

  test('lists phones, tablets and Windows apart, where they block nothing', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Check/ })).toHaveCount(6)
    const apart = page.getByRole('list', { name: 'Devices that open the dashboard' })
    for (const name of ['iphone', 'pixel-tablet', 'gaming-pc']) {
      await expect(apart.getByText(name, { exact: true })).toBeVisible()
    }
    await expect(apart.getByText(/Windows · coming soon/)).toBeVisible()
  })

  test('says the key is made by the first join, and reads the relay', async ({ page }) => {
    await expect(page.getByText(/made when the first machine joins/)).toBeVisible()
    await expect(page.getByText(/yantra ssh-identity/)).toHaveCount(0)
    await expect(page.getByText(/no relay yet/)).toBeVisible()
    await expect(page.getByText(/One step runs in a terminal: the join command/)).toBeVisible()
  })

  test('selects the join command where the page has no clipboard', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }))
    await page.reload()
    await expect(page.getByText(COMMAND)).toBeVisible()
    await page.getByRole('button', { name: 'Copy the join command' }).click()
    await expect(page.getByText(/this page has no clipboard, so the text is selected/)).toBeVisible()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(COMMAND)
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
