import { devices, type BrowserContext, type Page } from '@playwright/test'
import { expect, test as base } from './lib/test'
import { SIZES, WEB_PORT } from './lib/sizes'

/** Y-652: a page on the daemon's plain-HTTP port moves to its HTTPS origin,
 *  where the browser offers the microphone, and takes its draft along.
 *
 *  Both engines run under the `phone` project, at 390 px with touch. The
 *  project's browser is Chromium, and `browserName` is a worker option that a
 *  describe block may not set (Playwright 1.64.1 refuses it), so the WebKit
 *  block launches its own browser. Both hosts are routed to the preview
 *  server, so no DNS or TLS is needed: `box.test` over http is not a secure
 *  context, and a routed https URL is one. */
const PLAIN = 'http://box.test:7717'
const HTTPS = 'https://box.test:8443'
const PREVIEW = `http://127.0.0.1:${WEB_PORT}`
const NAME = 'yantra-web'
const DRAFT = `yantra.chat.draft.workspace/${NAME}`
const SEED = '/seed'
const WORDS = 'half a thought, typed on the plain port'

// The fixture's busy scenario has no machine with `yantra-mic`; Talk draws only where doctor found one.
const MIC = {
  looked: 'ok',
  age_seconds: 0,
  data: {
    machine: 'cachyos-g14',
    age_seconds: 0,
    checks: [{ check: 'mic', state: 'present', detail: 'yantra-mic is installed there' }],
  },
}

type Engine = 'chromium' | 'webkit'

const test = base.extend<{ engine: Engine; phone: Page }>({
  engine: ['chromium', { option: true }],
  phone: async ({ engine, browser, playwright }, provide) => {
    const webkit = engine === 'webkit' ? await playwright.webkit.launch() : null
    const shape = webkit ? { ...devices['iPhone 15'], ...SIZES.phone } : SIZES.phone
    const context = await (webkit ?? browser).newContext({ ...shape, serviceWorkers: 'block' })
    await provide(await context.newPage())
    // A route.fetch still in flight when the test ends is an error outside any test.
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
    await webkit?.close()
  },
})

// oxlint-disable-next-line no-empty-pattern -- Playwright's fixture signature
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'phone', 'each engine is launched here, under the phone project')
})

async function serve(context: BrowserContext, { healthz }: { healthz: 'answers' | 'unreachable' }) {
  await context.route(/^(http:\/\/box\.test:7717|https:\/\/box\.test:8443)\//, async (route) => {
    const url = new URL(route.request().url())
    // A page with no dashboard on it, so nothing moves while the draft is written.
    if (url.pathname === SEED) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' })
    if (url.origin === HTTPS && url.pathname === '/healthz' && healthz === 'unreachable') {
      return route.abort('connectionrefused')
    }
    if (url.pathname === '/api/machines/cachyos-g14/readiness') return route.fulfill({ json: MIC })
    const response = await route.fetch({ url: `${PREVIEW}${url.pathname}${url.search}` })
    if (url.pathname === '/api/about') {
      return route.fulfill({ response, json: { ...(await response.json()), https: HTTPS } })
    }
    return route.fulfill({ response })
  })
}

/** A draft typed on :7717 before this visit, as the composer keeps it. */
async function typedOnThePlainPort(page: Page) {
  await page.goto(`${PLAIN}${SEED}`)
  await page.evaluate(([key, words]) => localStorage.setItem(key, words), [DRAFT, WORDS])
}

const composer = (page: Page) => page.getByLabel(`Message Claude in ${NAME}`, { exact: true })
const talk = (page: Page) => page.getByRole('button', { name: 'Hold to talk' })

for (const [title, engine] of [
  ['Chromium', 'chromium'],
  ['WebKit', 'webkit'],
] as const) {
  test.describe(`${title} on a phone`, () => {
    test.use({ engine })

    test('moves to the HTTPS origin, where the mic works and the draft is still there', async ({ phone }) => {
      await serve(phone.context(), { healthz: 'answers' })
      await typedOnThePlainPort(phone)

      await phone.goto(`${PLAIN}/w/${NAME}#chat`)

      await expect(composer(phone)).toHaveValue(WORDS)
      const at = new URL(phone.url())
      expect([at.origin, at.pathname, at.hash]).toEqual([HTTPS, `/w/${NAME}`, '#chat'])
      expect(await phone.evaluate(() => window.isSecureContext)).toBe(true)
      expect(await phone.evaluate(() => navigator.mediaDevices !== undefined)).toBe(true)
      await expect(talk(phone)).toBeEnabled()
    })

    test('stays on the plain port and says why the mic is off when the HTTPS origin does not answer', async ({
      phone,
    }) => {
      await serve(phone.context(), { healthz: 'unreachable' })
      await typedOnThePlainPort(phone)

      await phone.goto(`${PLAIN}/w/${NAME}`)

      await expect(composer(phone)).toHaveValue(WORDS)
      expect(new URL(phone.url()).origin).toBe(PLAIN)
      expect(await phone.evaluate(() => window.isSecureContext)).toBe(false)
      await expect(talk(phone)).toBeDisabled()
      await expect(
        phone.getByRole('status').filter({ hasText: 'The microphone works only on the HTTPS address' }),
      ).toBeVisible()
    })
  })
}
