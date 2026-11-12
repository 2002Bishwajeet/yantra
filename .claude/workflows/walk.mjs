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
const snap = async (page, file, full) => {
  writeFileSync(`${file}.txt`, await page.locator('body').innerText())
  await page.screenshot({ path: `${file}.png`, fullPage: full })
}
// Y-743: both scenes press only what the walk's own namespace can take back; the channel file is the walk's copy (walk.sh up).
async function channelScene(page, name, file) {
  const group = page.getByRole('radiogroup', { name: 'Release channel' })
  const checked = async () => (await group.getByRole('radio', { checked: true }).innerText()).trim()
  const first = await checked()
  const full = name === 'desktop-chromium'
  const flip = async (to) => {
    let release
    const held = new Promise((r) => (release = r))
    await page.route('**/api/update/channel', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback()
      await held
      await route.continue()
    })
    const done = page.waitForResponse((r) => r.url().includes('/api/update/channel') && r.request().method() === 'PUT')
    await group.getByRole('radio', { name: to }).click()
    await page.waitForTimeout(500)
    await snap(page, file(`about-switching-${to.toLowerCase()}`), full)
    release()
    const answer = (await done).status()
    if (answer !== 204) errors.push(`${name} channel switch to ${to}: answered ${answer}`)
    await page.waitForTimeout(3000)
    await snap(page, file(`about-${to.toLowerCase()}`), full)
  }
  const other = first === 'Stable' ? 'Nightly' : 'Stable'
  try {
    await flip(other)
    await flip(first)
  } finally {
    if ((await checked().catch(() => first)) !== first) {
      await group.getByRole('radio', { name: first }).click().catch(() => {})
      await page.waitForTimeout(1000)
    }
  }
}
async function bellScene(page, name, url, out) {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  // The phone's bell is a link to the notifications screen; the desktop's is a button that opens a popover.
  const bell = page.getByRole(name === 'desktop-chromium' ? 'button' : 'link', { name: /^Notifications/ })
  if (name === 'desktop-chromium') {
    await page.waitForTimeout(500)
    const took = await bell.evaluate(
      (el) =>
        new Promise((done) => {
          const t0 = performance.now()
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          const poll = () => (document.querySelector('.m3-popover')?.checkVisibility() ? done(performance.now() - t0) : requestAnimationFrame(poll))
          poll()
        }),
    )
    await page.waitForTimeout(800)
    const text = await page.locator('.m3-popover').innerText()
    writeFileSync(`${out}/bell-open-${name}.txt`, `${text}\n\nopened in ${Math.round(took)} ms\n`)
    await page.screenshot({ path: `${out}/bell-open-${name}.png` })
  } else {
    await bell.tap()
    await page.waitForTimeout(1500)
    await snap(page, `${out}/bell-open-${name}`, false)
  }
  await page.keyboard.press('Escape')
}
for (const [name, type, options] of looks) {
  const browser = await type.launch()
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce', colorScheme: 'light' })
  let belled = false
  // The loop below adds to the queue, so each look starts from the routes the walk named.
  const queue = [...shots]
  for (const [url, shot] of queue) {
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
    if (shot === 'machines') {
      // Y-740: a card lists a failing check and the machine's page holds its fix, so the walk reads both.
      const faulted = page.locator('.machines__card').filter({ has: page.locator('.machines__check') })
      for (const link of await faulted.getByRole('link', { name: 'Open' }).all()) {
        const route = await link.getAttribute('href')
        if (!queue.some(([, other]) => other === slug(route))) queue.push([`${base}${route}`, slug(route)])
      }
    }
    if (shot === 'settings-about') {
      try {
        await channelScene(page, name, (scene) => `${out}/${scene}-${name}`)
      } catch (e) {
        errors.push(`${name} channel scene: ${e.message}`)
      }
    }
    if (shot !== 'sign-in' && !belled) {
      belled = true
      try {
        await bellScene(page, name, url, out)
      } catch (e) {
        errors.push(`${name} bell scene: ${e.message}`)
      }
    }
    await page.close()
  }
  await browser.close()
}
writeFileSync(`${out}/errors.txt`, errors.join('\n'))
if (errors.length) console.log(errors.join('\n'))
