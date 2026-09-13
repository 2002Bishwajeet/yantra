import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'

/** Y-351, inventory group 29, reshaped by D7 §4.1 (Y-390): the first run. `/`
 *  draws the checklist until the appliance has its key and one machine is
 *  ready, so the Setup, TabletSetup and PhoneSetup boards are this route on
 *  `firstrun`: no workspace, no key yet, no relay, six machines asleep and an
 *  iPhone online. */

const REQUIRED = ['The appliance is on your tailnet', 'Add a machine', 'Get it ready', 'Your first session']
const LATER = ['GitHub', 'Push to your phone']

test.describe('the first run', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'firstrun')
    await page.goto(route('dashboard').path)
    // The phone's app bar draws the route's own h1 and hides the screen's
    // from the accessibility tree, so this one is found in the DOM.
    await expect(page.locator('h1', { hasText: 'Set up Yantra' }).first()).toBeAttached()
  })

  test('draws four required steps, two for later, and how far along they are', async ({ page }) => {
    for (const step of [...REQUIRED, ...LATER]) {
      await expect(page.getByText(step, { exact: true }).first()).toBeVisible()
    }
    await expect(page.getByText(/\d of 4 done/)).toBeVisible()
    await expect(page.getByRole('progressbar')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Skip for now' })).toBeVisible()
  })

  /** D7 §3.1: one filled button, and before any join it is Add a device. On
   *  the phone and the tablet the FAB carries it, so the step's copy is tonal. */
  test('fills only Add a device, which opens the guided flow', async ({ page, size }) => {
    await expect(page.locator('main [data-variant="filled"]')).toHaveCount(size === 'desktop' ? 1 : 0)
    await expect(page.getByRole('main').getByRole('link', { name: 'Add a device' })).toHaveAttribute('href', '/machines/add')
  })

  /** D7 S3 and S5: an asleep machine is normal, and ssh cannot answer it. */
  test('draws asleep machines as asleep, with nothing to press', async ({ page }) => {
    await expect(page.getByText(/^asleep · last seen/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Check/ })).toHaveCount(0)
  })

  test('lists phones, tablets and Windows apart, where they block nothing', async ({ page }) => {
    const apart = page.getByRole('list', { name: 'Devices that open the dashboard' })
    for (const name of ['iphone', 'pixel-tablet', 'gaming-pc']) {
      await expect(apart.getByText(name, { exact: true })).toBeVisible()
    }
    await expect(apart.getByText(/Windows · coming soon/)).toBeVisible()
  })

  test('says the key is made by the first join, and reads the relay', async ({ page }) => {
    await expect(page.getByText('the key is made when the first machine joins')).toBeVisible()
    await expect(page.getByText(/yantra ssh-identity/)).toHaveCount(0)
    await expect(page.getByText(/no relay yet/)).toBeVisible()
    await expect(page.getByText(/One step runs in a terminal: the join command/)).toBeVisible()
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
