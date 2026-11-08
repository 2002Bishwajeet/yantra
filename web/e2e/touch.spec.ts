import { expect, firstReading, scenario, test } from './lib/test'

/** Y-671 (#660, research note 25 F2): the base touch rules and the gated hover. */
test('the base touch rules hold on a touch screen', async ({ page, size }) => {
  test.skip(size === 'desktop', 'the touch projects are phone, phone-webkit and tablet')
  await scenario(page, 'busy')
  await page.goto('/')
  await firstReading(page)

  const html = page.locator('html')
  await expect(html).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)')
  const adjust = await html.evaluate((el) => {
    const s = getComputedStyle(el) as CSSStyleDeclaration & { textSizeAdjust?: string }
    return s.textSizeAdjust ?? s.getPropertyValue('-webkit-text-size-adjust')
  })
  expect(adjust).toBe('100%')

  await expect(page.locator('a').first()).toHaveCSS('touch-action', 'manipulation')
  const button = page.getByRole('button', { name: /Show/ })
  await expect(button).toHaveCSS('touch-action', 'manipulation')
  await expect(button).toHaveCSS('user-select', 'none')

  // A tap must not leave the hover layer lit.
  await button.tap()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(() => button.evaluate((el) => Number(getComputedStyle(el, '::before').opacity)))
    .toBe(0)
})
