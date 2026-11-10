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
   *  the phone and the tablet the FAB carries it, and the page draws no copy (Y-615). */
  test('fills only Add a device, which opens the guided flow', async ({ page, size }) => {
    await expect(page.locator('main [data-variant="filled"]')).toHaveCount(size === 'desktop' ? 1 : 0)
    const add = page.getByRole('main').getByRole('link', { name: 'Add a device' })
    if (size === 'desktop') {
      await expect(add).toHaveAttribute('href', '/machines/add')
    } else {
      await expect(add).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Add a device, quick action' })).toHaveAttribute('href', '/machines/add')
    }
  })

  /** D7 S3 and S5: an asleep machine is normal, and ssh cannot answer it. */
  test('draws asleep machines as asleep, with nothing to press', async ({ page }) => {
    await expect(page.getByText(/^asleep · last seen/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Check/ })).toHaveCount(0)
  })

  /** Y-582: phones, tablets and Windows are listed on Machines, not here. */
  test('lists no devices that only open the dashboard', async ({ page }) => {
    await expect(page.getByText('Devices that open the dashboard')).toHaveCount(0)
    for (const name of ['iphone', 'pixel-tablet', 'gaming-pc']) {
      await expect(page.getByText(name, { exact: true })).toHaveCount(0)
    }
  })

  test('says the key is made by the first join, and reads the relay', async ({ page }) => {
    await expect(page.getByText('the key is made when the first machine joins')).toBeVisible()
    await expect(page.getByText(/yantra ssh-identity/)).toHaveCount(0)
    await expect(page.getByText(/no relay yet/)).toBeVisible()
    await expect(page.getByText(/One step runs in a terminal: the join command/)).toBeVisible()
  })

  /** Y-576: the walkthrough opens the push setup in place, not in Settings. */
  test('walks push setup from the app links to a test that arrived', async ({ page }) => {
    const later = page.getByRole('list', { name: 'Later, when you want them' })
    await later.getByRole('button', { name: 'Set up' }).click()
    const sheet = page.getByRole('dialog', { name: 'Push relay' })
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    await expect(sheet.getByRole('link', { name: /iPhone/ })).toHaveAttribute('href', /apps\.apple\.com/)
    await expect(sheet.getByRole('link', { name: /Android/ })).toHaveAttribute('href', /play\.google\.com/)
    await sheet.getByRole('button', { name: 'Generate' }).click()
    await expect(sheet.getByRole('img', { name: /QR code/ })).toBeVisible()
    await expect(sheet.getByRole('link', { name: 'Open the topic' })).toHaveAttribute('href', /^https:\/\/ntfy\.sh\/yantra-/)
    await expect(sheet.getByRole('button', { name: 'Copy the topic URL' })).toBeVisible()
    await sheet.getByRole('button', { name: 'Save and send a test' }).click()
    await expect(sheet.getByText('The test message arrived at the relay.')).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Restart now' })).toBeVisible()
    await sheet.getByRole('button', { name: 'No', exact: true }).click()
    await expect(sheet.getByText(/Subscribe to this topic in the ntfy app/)).toBeVisible()
    await sheet.getByRole('button', { name: 'Send another test' }).click()
    await sheet.getByRole('button', { name: 'Yes' }).click()
    await expect(sheet.getByText(/^Push works\./)).toBeVisible()
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(sheet).toBeHidden()
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

/** Y-582: a fresh install. The hub is the daemon's own node and is ready, so
 *  step 1 shows it with nothing to press, and step 3 lists only the other
 *  machines. The key is not made yet, so `/` still draws the checklist. */
test.describe('a fresh install with a ready hub', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'hub')
    await page.goto(route('dashboard').path)
    await expect(page.locator('h1', { hasText: 'Set up Yantra' }).first()).toBeAttached()
  })

  test('shows the hub ready under step 1, with no action', async ({ page }) => {
    const hub = page.getByRole('list', { name: 'The hub' })
    await expect(hub.getByText('yantra-box', { exact: true })).toBeVisible()
    await expect(hub.getByText(/^ready · /)).toBeVisible()
    await expect(hub.getByRole('button')).toHaveCount(0)
    await expect(hub.getByRole('link')).toHaveCount(0)
    await expect(page.getByText(/yantra-box is the hub and needs no adding · more machines can be added later/)).toBeVisible()
  })

  test('lists only the other machines under step 3', async ({ page }) => {
    const others = page.getByRole('list', { name: 'Other machines' })
    const step3 = page.locator('.setup__list > li', { hasText: 'Get it ready' })
    await expect(step3.locator('xpath=following-sibling::li[1]').getByRole('list', { name: 'Other machines' })).toBeAttached()
    await expect(others.getByText('macbook', { exact: true })).toBeVisible()
    await expect(others.getByText('yantra-box', { exact: true })).toHaveCount(0)
    await expect(page.getByText('iphone', { exact: true })).toHaveCount(0)
  })

  test('passes axe', async ({ page }) => {
    await axe(page)
  })
})

test.describe('the first run with a real key', () => {
  test('keeps the key fingerprint inside the phone', async ({ page, size }) => {
    test.skip(size !== 'phone', 'only a phone is narrower than a fingerprint')
    await scenario(page, 'firstrun')
    await page.route('**/api/ssh-identity', (route) =>
      route.fulfill({
        json: {
          fingerprint: 'SHA256:aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefgHiJkLmNoPqRsTuVwXyZ',
          kind: 'ed25519',
          path: '/home/a/.ssh/id_yantra',
          public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB<key> yantra',
        },
      }),
    )
    await page.goto(route('dashboard').path)
    const key = page.getByText(/SHA256:aBcDe/)
    await expect(key).toBeVisible()
    await expect(key).toHaveAttribute('title', /^SHA256:aBcDe/)
    const box = (await key.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  })
})
