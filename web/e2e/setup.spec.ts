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

// Y-350 wrote `src/screens/setup/Setup.tsx`; nothing renders it. `/` drew it
// while the fleet was empty (D3 §4.8) until Y-346 gave that branch to the
// EmptyDashboard board, so the checklist has no route and these cases are
// held rather than deleted.
test.describe.fixme('the first run', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'empty')
    await page.goto(route('dashboard').path)
    await expect(page.getByRole('heading', { level: 1, name: 'Set up Yantra' })).toBeVisible()
  })

  test('draws six steps, how far along they are, and what each one is waiting on', async ({ page }) => {
    for (const step of STEPS) {
      await expect(page.getByText(step, { exact: true }).first()).toBeVisible()
    }
    await expect(page.getByText(/\d of 6 done/)).toBeVisible()
    await expect(page.getByRole('progressbar')).toBeVisible()
    await expect(page.getByText('waiting on you')).toBeVisible()
    await expect(page.getByRole('link', { name: 'New session' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Skip for now' })).toBeVisible()
  })

  test('asks a machine for its checks only when told to', async ({ page }) => {
    const ask = page.getByRole('button', { name: /^Check/ }).first()
    await expect(ask).toBeVisible()
    await expect(page.getByText('not checked yet · a check costs one ssh round trip').first()).toBeVisible()
    await ask.click()
    await expect(page.getByText('not checked yet · a check costs one ssh round trip')).toHaveCount(0)
  })

  test('passes axe', async ({ page }) => {
    await axe(page)
  })

  test('walks by keyboard', async ({ page }) => {
    await keyboardWalk(page, 10)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'setup', 'empty', size)
  })
})
