// Y-835: look.sh runs this in the Playwright image, from web/, so the dashboard's own @playwright/test is used.
// It opens pages on the owner's real box and presses nothing. walk.mjs presses the channel switch, so it is not reused.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const [origin, out, session, ...named] = process.argv.slice(2)
const { chromium, webkit, devices } = createRequire(`${process.cwd()}/package.json`)('@playwright/test')
const looks = [
  ['phone-webkit', webkit, { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } }],
  ['desktop-chromium', chromium, { viewport: { width: 1440, height: 1024 } }],
]
// Same list as `CATEGORIES` in web/src/screens/settings/categories.tsx.
const SETTINGS = ['general', 'notifications', 'providers', 'agents', 'appearance', 'devices', 'about']
const slug = (route) => route.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-') || 'home'
const errors = []
const answers = []

/** The pages the owner uses: each of the owner's machines and the first workspace are read from the box. */
async function pages(context) {
  const read = async (path) => {
    const answer = await context.request.get(`${origin}${path}`)
    if (!answer.ok()) throw new Error(`${path} answered ${answer.status()}`)
    return (await answer.json()).data ?? []
  }
  const routes = ['/', '/fleet', '/machines']
  try {
    for (const one of await read('/api/machines')) {
      if (one.ownership === 'yours') routes.push(`/m/${encodeURIComponent(one.name)}`)
    }
    const loaded = (await read('/api/workspaces')).find((one) => one.loaded === 'yes')
    if (loaded) routes.push(`/w/${encodeURIComponent(loaded.name)}`)
  } catch (e) {
    errors.push(`the box's machines and workspaces could not be listed, so their pages are not shot: ${e.message}`)
  }
  return [...routes, '/usage', '/notifications', '/rooms', '/settings', ...SETTINGS.map((id) => `/settings/${id}`)]
}

/** One line for an answer of 400 or more. The box's own refusal says why, and a read-only 403 starts with
 *  "this session is read-only", which is how the reader tells it from a defect. */
async function refused(look, route, response) {
  const url = new URL(response.url())
  const ours = url.origin === origin
  let said = ''
  if (ours) said = (await response.text().catch(() => '')).split('\n')[0].slice(0, 160)
  answers.push(`${look} ${route}: ${response.status()} ${response.request().method()} ${ours ? '' : url.origin}${url.pathname} ${said}`.trimEnd())
}

let routes
for (const [name, type, options] of looks) {
  const browser = await type.launch()
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce', colorScheme: 'light' })
  // A cookie for this origin alone. A header on every request would also reach avatars.githubusercontent.com.
  await context.addCookies([
    { name: '__Host-yantra_session', value: readFileSync(session, 'utf8').trim(), url: origin, httpOnly: true, sameSite: 'Strict' },
  ])
  // look.sh saw a 200 with this session, so a 401 here means this browser did not send the cookie.
  const probe = await context.request.get(`${origin}/api/workspaces`)
  if (probe.status() !== 200) {
    errors.push(`${name}: the browser's read answered ${probe.status()}, so its pages would show the sign-in screen; none is shot`)
    await browser.close()
    continue
  }
  routes ??= named.length ? named : await pages(context)
  for (const route of routes) {
    const page = await context.newPage()
    const pending = []
    page.on('pageerror', (e) => errors.push(`${name} ${route}: ${e.message}`))
    page.on('response', (response) => response.status() >= 400 && pending.push(refused(name, route, response)))
    try {
      await page.goto(`${origin}${route}`, { waitUntil: 'load' })
      // The fleet arrives after load, so no network-idle moment exists to wait for.
      await page.waitForTimeout(5000)
      const file = `${out}/${slug(route)}-${name}`
      // A reader corrects a misspelt word in a picture without noticing, so the text goes beside it.
      writeFileSync(`${file}.txt`, await page.locator('body').innerText())
      if (name === 'desktop-chromium') {
        await page.screenshot({ path: `${file}.png`, fullPage: true })
      } else {
        // WebKit draws fixed bars mid-page in a full-page capture, so the phone is shot a screen at a time.
        // The phone scrolls `.shell__main`, and a page with no shell scrolls the window.
        const scroll = (top) =>
          page.evaluate((top) => {
            const main = document.querySelector('[data-shell="phone"] .shell__main')
            if (main && main.scrollHeight > main.clientHeight) {
              main.scrollTop = top
              return { height: main.scrollHeight, step: main.clientHeight }
            }
            window.scrollTo(0, top)
            return { height: document.documentElement.scrollHeight, step: window.innerHeight }
          }, top)
        for (let n = 1, top = 0; n <= 6; n++) {
          const { height, step } = await scroll(top)
          await page.waitForTimeout(300)
          await page.screenshot({ path: `${file}-${n}.png` })
          top += step
          if (top >= height) break
        }
      }
    } catch (e) {
      errors.push(`${name} ${route}: ${e.message}`)
    }
    await Promise.all(pending)
    await page.close()
  }
  await browser.close()
}
writeFileSync(`${out}/responses.txt`, answers.join('\n'))
writeFileSync(`${out}/errors.txt`, errors.join('\n'))
if (errors.length) console.log(errors.join('\n'))
