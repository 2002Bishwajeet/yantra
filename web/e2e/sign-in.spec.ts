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

/** Y-772: on a phone the form sits on the surface under the notch, with no card
 *  around it, and it speaks to the person who is signing in. */
test('the phone sign-in is top-aligned, cardless and says your passkey', async ({ page, size }) => {
  test.skip(size !== 'phone', 'a tablet and a desktop keep the card')
  await scenario(page, 'signedout')
  await page.goto('/')
  const heading = page.getByRole('heading', { name: 'Sign in to Yantra' })
  await expect(heading).toBeVisible()

  // The mark and the title open the card, so the card's top is the page's top plus the inset.
  const top = (await page.locator('.sign-in__card').boundingBox())!.y
  const inset = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.paddingTop = 'env(safe-area-inset-top, 0px)'
    document.body.append(probe)
    const px = parseFloat(getComputedStyle(probe).paddingTop)
    probe.remove()
    return px
  })
  expect(top).toBeLessThanOrEqual(inset + 24)
  expect((await heading.boundingBox())!.y).toBeLessThan(160)
  await expect(page.locator('.sign-in')).toHaveCSS('align-content', 'start')

  await expect(page.locator('.sign-in__card')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('main')).toContainText('your passkey')
})
