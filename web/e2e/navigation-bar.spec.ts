import { expect, scenario, test } from './lib/test'

/** R14 §6.1: the bar is 64 above the home-indicator inset. Chromium cannot
 *  emulate the inset, so the test sets the bar's own variable by hand and
 *  proves the arithmetic the stylesheet does with `env()`. */
test('the phone bar keeps 64 px of content above the safe-area inset', async ({ page, size }) => {
  test.skip(size !== 'phone', 'the bar is the phone shell')
  await scenario(page, 'busy')
  await page.goto('/')
  const bar = page.locator('nav.m3-navigation-bar')
  await expect(bar).toBeVisible()
  const measure = () =>
    bar.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        content: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        total: el.getBoundingClientRect().height,
      }
    })
  expect(await measure()).toEqual({ content: 64, total: 64 })
  await bar.evaluate((el) => el.style.setProperty('--m3-safe-bottom', '34px'))
  expect(await measure()).toEqual({ content: 64, total: 98 })
})
