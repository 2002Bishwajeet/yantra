// Y-660: walk.sh runs this in the Playwright image, from web/, so the dashboard's own @playwright/test is used.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

const [base, out, ...routes] = process.argv.slice(2)
const { chromium, webkit, devices } = createRequire(`${process.cwd()}/package.json`)('@playwright/test')
const looks = [
  ['phone-webkit', webkit, { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } }],
  ['desktop-chromium', chromium, { viewport: { width: 1440, height: 1024 } }],
]
const slug = (route) => route.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-') || 'home'
// Y-687: walk.sh's second hop is a device of the owner's with no cookie, so its home is the sign-in screen.
const shots = routes.map((route) => [`${base}${route}`, slug(route)])
if (process.env.WALK_SIGNIN) shots.push([`${process.env.WALK_SIGNIN}/`, 'sign-in'])
const errors = []
for (const [name, type, options] of looks) {
  const browser = await type.launch()
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce', colorScheme: 'light' })
  for (const [url, shot] of shots) {
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(`${name} ${shot}: ${e.message}`))
    // Every read on the sign-in hop is a 401 on purpose, and the browser logs each one.
    const expected = (m) => shot === 'sign-in' && m.text().includes('401')
    page.on('console', (m) => m.type() === 'error' && !expected(m) && errors.push(`${name} ${shot}: console: ${m.text()}`))
    await page.goto(url, { waitUntil: 'load' })
    // The fleet arrives over a socket after load, so no network-idle moment exists to wait for.
    await page.waitForTimeout(5000)
    const file = `${out}/${shot}-${name}`
    // A reviewer reading an image corrects a misspelt word without noticing (Y-660's planted fault), so the text goes beside it.
    writeFileSync(`${file}.txt`, await page.locator('body').innerText())
    if (name === 'desktop-chromium') await page.screenshot({ path: `${file}.png`, fullPage: true })
    else {
      // WebKit draws fixed bars mid-page in a full-page capture, over the content, so the phone is shot a screen at a time.
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      for (let n = 1, y = 0; y < height && n <= 6; n++, y += 844) {
        await page.evaluate((top) => window.scrollTo(0, top), y)
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${file}-${n}.png` })
      }
    }
    await page.close()
  }
  await browser.close()
}
writeFileSync(`${out}/errors.txt`, errors.join('\n'))
if (errors.length) console.log(errors.join('\n'))
