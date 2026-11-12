import { axe, expect, scenario, screenshot, test } from './lib/test'

/** Y-687, ADR-0044: the sign-in screen at each size. A 401 is all it needs, so
 *  it is drawn on the preview's own address; `passkey.spec.ts` runs the
 *  ceremonies on a hub origin. */
test('the sign-in screen looks like the board', async ({ page, size }) => {
  await scenario(page, 'signedout')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in to Yantra' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible()
  await axe(page)
  await screenshot(page, 'sign-in', 'signedout', size)
})
