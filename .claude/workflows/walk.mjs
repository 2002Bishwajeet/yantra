// Y-660: walk.sh runs this in the Playwright image, from web/, so the dashboard's own @playwright/test is used.
import { createRequire } from 'node:module'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [base, out, ...routes] = process.argv.slice(2)
const { chromium, webkit, devices } = createRequire(`${process.cwd()}/package.json`)('@playwright/test')
const looks = [
  ['phone-webkit', webkit, { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } }],
  ['desktop-chromium', chromium, { viewport: { width: 1440, height: 1024 } }],
]
const slug = (route) => route.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-') || 'home'
// Y-687: walk.sh's second hop is a device of the owner's with no cookie, so its home is the sign-in screen.
// A route ending in @dark is shot in the dark scheme (Y-770); the others stay light.
const shots = routes.map((route) => [`${base}${route.replace(/@dark$/, '')}`, slug(route), route.endsWith('@dark') ? 'dark' : 'light'])
if (process.env.WALK_SIGNIN) shots.push([`${process.env.WALK_SIGNIN}/`, 'sign-in', 'light'])
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
// Y-746: the phone taps the top bar's Search button; the desktop presses the pill. Typing shows the results list too.
async function searchScene(page, name, url, out) {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const opener = name === 'desktop-chromium' ? page.getByRole('button', { name: /^Search anything/ }) : page.getByRole('button', { name: 'Search', exact: true })
  if (name === 'desktop-chromium') await opener.click()
  else await opener.tap()
  await page.getByRole('dialog', { name: 'Search' }).waitFor()
  await page.waitForTimeout(1000)
  await snap(page, `${out}/search-open-${name}`, false)
  await page.getByRole('combobox', { name: 'Search anything' }).fill('a')
  await page.waitForTimeout(800)
  await snap(page, `${out}/search-typed-${name}`, false)
  await page.keyboard.press('Escape')
}
// Y-761: the Account menu's heading and vertical shape, shot open.
async function accountScene(page, name, url, out) {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const avatar = page.getByRole('button', { name: 'Account', exact: true })
  if (name === 'desktop-chromium') await avatar.click()
  else await avatar.tap()
  // A visibility wait passes a popup that Base UI holds at opacity 0 until it has a position, and one under
  // another layer. Neither is in the picture, so the scene asks what is painted and reports what is not.
  const fault = () =>
    page.evaluate(() => {
      const menu = document.querySelector('.m3-menu[data-open]')
      if (!menu) return 'no menu is open'
      const box = menu.getBoundingClientRect()
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      const opacity = [menu, menu.closest('.m3-menu__positioner')].map((one) => getComputedStyle(one).opacity).join(' in ')
      if (opacity === '1 in 1' && menu.contains(top)) return ''
      return `opacity ${opacity}, box ${[box.x, box.y, box.width, box.height].map(Math.round)}, on top <${top?.tagName ?? 'nothing'} class="${top?.getAttribute('class') ?? ''}">`
    })
  let wrong = await fault()
  for (let n = 0; wrong && n < 20; n++) {
    await page.waitForTimeout(150)
    wrong = await fault()
  }
  if (wrong) errors.push(`${name} account scene: the open menu is not painted: ${wrong}`)
  const text = await page.locator('.m3-menu[data-open]').innerText({ timeout: 1000 }).catch(() => '')
  writeFileSync(`${out}/account-open-${name}.txt`, text)
  await page.screenshot({ path: `${out}/account-open-${name}.png` })
  if (!wrong && (await fault())) errors.push(`${name} account scene: the menu closed while the picture was taken`)
  await page.keyboard.press('Escape')
}
// Y-754: a phone's Needs-you row is the link and a desktop's row ends in one. A GitHub row leaves the dashboard, so it is not opened.
async function needsScene(page, name, url, out) {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(5000)
  const desktop = name === 'desktop-chromium'
  const band = page.getByRole('region', { name: 'Needs you' })
  const link = band.locator(desktop ? '.m3-row a.m3-button:not([target])' : 'a.m3-row:not([target])').first()
  if ((await link.count()) === 0) return
  if (desktop) await link.click()
  else await link.tap()
  await page.waitForTimeout(2000)
  await snap(page, `${out}/needs-you-open-${name}${desktop ? '' : '-1'}`, desktop)
}
// Y-757: the phone keeps the status and Stop in the More menu, so the walk opens it. The row's 40 % is a
// number, so the phone's text file gets the measured tops; a reader cannot take them from a picture.
async function workspaceScene(page, name, file, menu) {
  const phone = name !== 'desktop-chromium'
  await page.evaluate(() => window.scrollTo(0, 0))
  if (phone) {
    const top = async (part) => Math.round((await part.boundingBox()).y)
    const thread = await top(page.getByRole('region', { name: 'Conversation' }))
    const picker = await top(page.getByRole('button', { name: /^Threads,/ }))
    const git = await top(page.locator('.git__split'))
    const { height } = page.viewportSize()
    appendFileSync(
      `${file}.txt`,
      `\n\nThe walk measured, on a ${height} px screen: the conversation starts at ${thread} px, ${Math.round((thread / height) * 100)} % down. The thread picker starts at ${picker} px and the git action at ${git} px.\n`,
    )
  }
  const more = page.getByRole('button', { name: 'More actions' })
  if (phone) await more.tap()
  else await more.click()
  // The picture is of a menu that is on screen: Delete is its last item, and a menu that Base UI holds closed
  // or off the viewport never shows it. A tap that opened and shut the menu fails here, not in the PR.
  const last = page.getByRole('menuitem', { name: 'Delete' })
  await last.waitFor({ state: 'visible' })
  const box = await last.boundingBox()
  const { width, height } = page.viewportSize()
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height) {
    errors.push(`${name} workspace scene: the menu's Delete is outside the screen at ${JSON.stringify(box)}`)
    return
  }
  await page.waitForTimeout(500)
  // The phone's picture ends in -1, as its other screens do, so walk.sh publish puts it in the PR's table.
  const shot = `${phone ? `${menu}-1` : menu}.png`
  await snap(page, phone ? `${menu}-1` : menu, false)
  if (readFileSync(shot).equals(readFileSync(`${file}.png`))) {
    errors.push(`${name} workspace scene: menu shot equals the closed screen`)
  }
  await page.keyboard.press('Escape')
}
for (const [name, type, options] of looks) {
  const browser = await type.launch()
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce', colorScheme: 'light' })
  let belled = false
  let searched = false
  let accounted = false
  // The loop below adds to the queue, so each look starts from the routes the walk named.
  const queue = [...shots]
  for (const [url, shot, scheme] of queue) {
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(`${name} ${shot}: ${e.message}`))
    // Every read on the sign-in hop is a 401 on purpose, and the browser logs each one.
    const expected = (m) => shot === 'sign-in' && m.text().includes('401')
    page.on('console', (m) => m.type() === 'error' && !expected(m) && errors.push(`${name} ${shot}: console: ${m.text()}`))
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(url, { waitUntil: 'load' })
    // The fleet arrives over a socket after load, so no network-idle moment exists to wait for.
    await page.waitForTimeout(5000)
    const file = `${out}/${shot}-${name}`
    // A reviewer reading an image corrects a misspelt word without noticing (Y-660's planted fault), so the text goes beside it.
    writeFileSync(`${file}.txt`, await page.locator('body').innerText())
    if (name === 'desktop-chromium') {
      await page.screenshot({ path: `${file}.png`, fullPage: true })
      // Y-749: no walked page is taller than 1024 px, so a short window shoots the pinned bar over scrolled content.
      await page.setViewportSize({ width: 1440, height: 600 })
      await page.waitForTimeout(300)
      if (await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)) {
        await page.evaluate(() => window.scrollTo(0, 400))
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${file}-scrolled.png` })
      }
      await page.setViewportSize({ width: 1440, height: 1024 })
    } else {
      // WebKit draws fixed bars mid-page in a full-page capture, over the content, so the phone is shot a screen at a time.
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      for (let n = 1, y = 0; y < height && n <= 6; n++, y += 844) {
        await page.evaluate((top) => window.scrollTo(0, top), y)
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${file}-${n}.png` })
      }
      // Y-761: the phone scrolls `main`, not the window (Y-670), and no walked page is taller than the screen.
      // A spacer inside `main` makes it scroll, so the shot shows the bar toned over content. Sign-in has no shell.
      const scrolled = await page.evaluate(() => {
        const main = document.querySelector('[data-shell="phone"] .shell__main')
        if (!main) return false
        const spacer = document.createElement('div')
        spacer.id = 'walk-spacer'
        spacer.style.cssText = 'flex: none; height: 1600px'
        main.append(spacer)
        main.scrollTop = 400
        return main.scrollTop > 0
      })
      if (scrolled) {
        await page.waitForTimeout(400)
        if (!(await page.locator('[data-shell="phone"][data-scrolled]').count())) errors.push(`${name} ${shot}: the bar kept its resting tone over scrolled content`)
        await page.screenshot({ path: `${file}-scrolled.png` })
      }
      // The scenes below shoot this page again.
      await page.evaluate(() => {
        const main = document.querySelector('[data-shell="phone"] .shell__main')
        document.getElementById('walk-spacer')?.remove()
        if (main) main.scrollTop = 0
      })
    }
    if (shot === 'machines') {
      const also = (route) => queue.some(([, other]) => other === slug(route)) || queue.push([`${base}${route}`, slug(route), 'light'])
      // Y-740: a card lists a failing check and the machine's page holds its fix, so the walk reads both.
      // Y-775: a card of a machine that ssh cannot reach lists no check; it holds what ssh said.
      const faulted = page.locator('.machines__card').filter({ has: page.locator('.machines__check, .m3-disclosure') })
      for (const link of await faulted.getByRole('link', { name: 'Open' }).all()) also(await link.getAttribute('href'))
      // Y-775: a phone, a tablet and a Windows PC get no card, so no link leads to their pages. The daemon's list names them.
      try {
        const fleet = await page.evaluate(() => fetch('/api/machines').then((answer) => answer.json()))
        for (const one of fleet.data ?? []) {
          if (one.ownership === 'yours' && one.os !== 'linux' && one.os !== 'macOS') also(`/m/${encodeURIComponent(one.name)}`)
        }
      } catch (e) {
        errors.push(`${name} machines: the daemon's list could not be read: ${e.message}`)
      }
    }
    if (/^\/w\/[^/]+$/.test(new URL(url).pathname)) {
      try {
        await workspaceScene(page, name, file, `${out}/${shot}-menu-${name}`)
      } catch (e) {
        errors.push(`${name} workspace scene: ${e.message}`)
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
    if (shot !== 'sign-in' && !accounted) {
      accounted = true
      try {
        await accountScene(page, name, url, out)
      } catch (e) {
        errors.push(`${name} account scene: ${e.message}`)
      }
    }
    if (shot !== 'sign-in' && !searched) {
      searched = true
      try {
        await searchScene(page, name, url, out)
      } catch (e) {
        errors.push(`${name} search scene: ${e.message}`)
      }
    }
    if (shot === 'home') {
      try {
        await needsScene(page, name, url, out)
      } catch (e) {
        errors.push(`${name} needs-you scene: ${e.message}`)
      }
    }
    await page.close()
  }
  await browser.close()
}
writeFileSync(`${out}/errors.txt`, errors.join('\n'))
if (errors.length) console.log(errors.join('\n'))
