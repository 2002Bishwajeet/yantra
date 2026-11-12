import type { BrowserContext, Page } from '@playwright/test'
import { axe, expect, scenario, test } from './lib/test'
import { WEB_PORT } from './lib/sizes'

/** Y-687, ADR-0044: a 401 draws the sign-in screen, a code enrols a passkey,
 *  and the passkey signs the device back in after it signs out. Chromium's
 *  virtual authenticator answers both ceremonies over CDP, with user
 *  verification, as a phone's Face ID would.
 *
 *  A passkey needs a secure context and a domain for its relying party, which
 *  127.0.0.1 is not, so the page is served as `https://hub.test:8443`, routed
 *  to the preview server the way `secure.spec.ts` routes `box.test`. */
const HUB = 'https://hub.test:8443'
const PREVIEW = `http://127.0.0.1:${WEB_PORT}`
const CODE = 'ABCD2345'

// oxlint-disable-next-line no-empty-pattern -- Playwright's fixture signature
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'phone', 'the virtual authenticator is Chromium’s, and one width proves the flow')
})

/** The hub's origin, on the scenario `selected` names; the fixture reads the
 *  host it binds the passkey to from `x-forwarded-host`. */
async function serve(context: BrowserContext, selected: string) {
  await context.route(/^https:\/\/hub\.test:8443\//, async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({
      url: `${PREVIEW}${url.pathname}${url.search}`,
      headers: { ...route.request().headers(), 'x-fixture-scenario': selected, 'x-forwarded-host': 'hub.test' },
    })
    return route.fulfill({ response })
  })
}

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

const signIn = (page: Page) => page.getByRole('heading', { name: 'Sign in to Yantra' })

async function enrol(page: Page, code: string) {
  await page.getByRole('button', { name: 'Set up this device with a code' }).tap()
  await page.getByLabel("This device's name").fill('Test phone')
  await page.getByLabel('Code').fill(code)
  await page.getByRole('button', { name: 'Set up this device', exact: true }).tap()
}

test.afterEach(async ({ page }) => {
  await page.context().unrouteAll({ behavior: 'ignoreErrors' })
})

test('a 401 draws the sign-in screen, and a code enrols this device', async ({ page }) => {
  await serve(page.context(), await scenario(page, 'signedout'))
  await authenticator(page)

  await page.goto(`${HUB}/settings/devices`)

  await expect(signIn(page)).toBeVisible()
  await axe(page)
  await enrol(page, CODE)
  await expect(signIn(page)).toBeHidden()
  await expect(page.getByText('Passkeys work at cachyos-g14.tail3a1b.ts.net.')).toBeVisible()
  await expect(page.getByText('Test phone', { exact: true }).first()).toBeVisible()
})

test('a wrong code says the daemon’s words and signs nothing in', async ({ page }) => {
  await serve(page.context(), await scenario(page, 'signedout'))
  await authenticator(page)
  await page.goto(`${HUB}/`)

  await enrol(page, 'WRONG234')

  await expect(page.getByRole('alert')).toContainText('that code is wrong, used, or expired')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(signIn(page)).toBeVisible()
})

test('this device signs out, and its passkey signs it back in', async ({ page }) => {
  await serve(page.context(), await scenario(page, 'signedout'))
  await authenticator(page)
  await page.goto(`${HUB}/settings/devices`)
  await enrol(page, CODE)
  await expect(signIn(page)).toBeHidden()

  const mine = page.getByRole('listitem').filter({ hasText: /^.*this device · /i })
  await mine.getByRole('button', { name: 'Sign out' }).tap()
  await expect(signIn(page)).toBeVisible()

  await page.getByRole('button', { name: 'Sign in with a passkey' }).tap()
  await expect(signIn(page)).toBeHidden()
  await expect(page.getByText('Passkeys work at cachyos-g14.tail3a1b.ts.net.')).toBeVisible()
})
