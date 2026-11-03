import { expect, scenario, test } from './lib/test'
import { route } from './lib/routes'

/** Y-573 (#510). Chromium cannot emulate insets, so the tests set `--m3-safe-top`
 *  on <html> by hand and prove the arithmetic the stylesheets do with it. */
const INSET = '47px'

const withInset = (page: import('@playwright/test').Page) =>
  page.evaluate((v) => document.documentElement.style.setProperty('--m3-safe-top', v), INSET)

test('the phone top bar keeps 64 px of content below the status-bar inset', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the top app bar is the phone shell')
  await scenario(page, 'busy')
  await page.goto('/')
  const bar = page.locator('header.m3-top-app-bar').first()
  await expect(bar).toBeVisible()
  await withInset(page)
  await expect
    .poll(() =>
      bar.evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          content: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
          total: el.getBoundingClientRect().height,
        }
      }),
    )
    .toEqual({ content: 64, total: 111 })
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the phone strip is a solid ${scheme} surface that stays at the top`, async ({ page, size }) => {
    test.skip(size !== 'phone', 'the strip is the phone shell')
    await page.emulateMedia({ colorScheme: scheme })
    await scenario(page, 'busy')
    await page.goto('/')
    await expect(page.locator('header.m3-top-app-bar').first()).toBeVisible()
    await withInset(page)
    const strip = () =>
      page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('.shell')!, '::before')
        const probe = document.createElement('i')
        probe.style.background = 'var(--md-sys-color-surface)'
        document.body.append(probe)
        const surface = getComputedStyle(probe).backgroundColor
        probe.remove()
        return { position: s.position, height: s.height, top: s.top, background: s.backgroundColor, surface }
      })
    await expect.poll(async () => (await strip()).height).toBe('47px')
    const s = await strip()
    expect(s.position).toBe('fixed')
    expect(s.top).toBe('0px')
    expect(s.background).toBe(s.surface)
    expect(s.background).not.toMatch(/rgba\(.*, 0\)$/)

    await page.evaluate(() => {
      const pad = document.createElement('div')
      pad.style.height = '4000px'
      document.querySelector('.shell__main')?.append(pad)
      window.scrollTo(0, 1500)
    })
    expect((await strip()).top).toBe('0px')
  })
}

test('the tablet and desktop shells pad their top by the inset', async ({ page, size }) => {
  test.skip(size === 'phone', 'the phone pads in its bar')
  await scenario(page, 'busy')
  await page.goto('/')
  const shell = page.locator('.shell')
  await expect(shell).toBeVisible()
  await withInset(page)
  await expect.poll(() => shell.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('47px')
  // content-box would add the insets to min-height: 100dvh and scroll a short page
  expect(await shell.evaluate((el) => getComputedStyle(el).boxSizing)).toBe('border-box')
})

const withSideInsets = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    document.documentElement.style.setProperty('--m3-safe-left', '47px')
    document.documentElement.style.setProperty('--m3-safe-right', '47px')
  })

test('the tablet sudo side sheet clears the side insets', async ({ page, size }) => {
  test.skip(size !== 'tablet', 'the side sheet is the tablet shell')
  await scenario(page, 'install')
  await page.goto('/m/nas')
  const ready = page.getByRole('region', { name: 'Readiness' })
  await ready.getByRole('button', { name: 'Install' }).click()
  await ready.getByRole('button', { name: 'Open a terminal' }).click({ timeout: 15_000 })
  const sheet = page.getByRole('complementary', { name: 'Run it on nas' })
  await expect(sheet).toBeVisible()
  await withInset(page)
  await withSideInsets(page)
  const vw = page.viewportSize()!.width
  await expect
    .poll(() =>
      sheet.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { right: r.right, leftOk: r.left >= 16 + 47, top: r.top }
      }),
    )
    .toEqual({ right: vw - 16 - 47, leftOk: true, top: 16 + 47 })
})

test('the tablet notifications sheet clears every inset', async ({ page, size }) => {
  test.skip(size !== 'tablet', 'the floating notifications sheet is the tablet shell')
  await scenario(page, 'busy')
  await page.goto('/')
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const sheet = page.getByRole('complementary', { name: 'Notifications' })
  await expect(sheet).toBeVisible()
  await withInset(page)
  await withSideInsets(page)
  await page.evaluate(() => document.documentElement.style.setProperty('--m3-safe-bottom', '21px'))
  const { width, height } = page.viewportSize()!
  await expect
    .poll(() =>
      sheet.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { right: r.right, top: r.top, bottom: r.bottom }
      }),
    )
    .toEqual({ right: width - 12 - 47, top: 12 + 47, bottom: height - 12 - 21 })
})

test('the dialog viewport pads its sides by the insets', async ({ page, size }) => {
  test.skip(size === 'phone', 'the phone uses a bottom sheet')
  await scenario(page, 'busy')
  await page.goto(route('session-terminal').path)
  await expect(page.getByRole('heading', { level: 1, name: 'scratch' }).first()).toBeVisible()
  await withSideInsets(page)
  // Dialog.css loads with the dialog chunk, so open a real dialog first.
  await page.getByRole('button', { name: 'Kill', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('.m3-dialog__viewport')!)
        return { left: s.paddingLeft, right: s.paddingRight }
      }),
    )
    .toEqual({ left: '47px', right: '47px' })
})

test('the phone top bar pads its sides by the insets', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the top app bar is the phone shell')
  await scenario(page, 'busy')
  await page.goto('/')
  const bar = page.locator('header.m3-top-app-bar').first()
  await expect(bar).toBeVisible()
  await withSideInsets(page)
  await expect
    .poll(() => bar.evaluate((el) => ({ left: getComputedStyle(el).paddingLeft, right: getComputedStyle(el).paddingRight })))
    .toEqual({ left: '63px', right: '59px' })
})

const effective = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const m = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].find((x) =>
      x.media ? matchMedia(x.media).matches : true,
    )
    return m?.content.toLowerCase() ?? null
  })

const LIGHT = '#f6f0e2'
const DARK = '#151714'

test.describe('theme-color follows the theme', () => {
  test('system follows the OS scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await scenario(page, 'busy')
    await page.goto('/')
    expect(await effective(page)).toBe(DARK)
    await page.emulateMedia({ colorScheme: 'light' })
    expect(await effective(page)).toBe(LIGHT)
  })

  for (const [pref, opposite, want] of [
    ['dark', 'light', DARK],
    ['light', 'dark', LIGHT],
  ] as const) {
    test(`a stored ${pref} pref beats the ${opposite} OS on load`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: opposite })
      await page.addInitScript((theme) => {
        localStorage.setItem('yantra.prefs', JSON.stringify({ v: 1, theme }))
      }, pref)
      await scenario(page, 'busy')
      await page.goto('/')
      expect(await effective(page)).toBe(want)
    })
  }

  test('a change in Appearance moves it', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await scenario(page, 'busy')
    await page.goto('/settings/appearance')
    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect.poll(() => effective(page)).toBe(DARK)
    await page.getByRole('radio', { name: 'System' }).click()
    await expect.poll(() => effective(page)).toBe(LIGHT)
  })
})
