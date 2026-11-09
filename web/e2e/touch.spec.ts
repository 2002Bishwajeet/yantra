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
  // Linux WebKit has no text-size-adjust (an iOS property) and reports ''.
  if (adjust !== '') expect(adjust).toBe('100%')

  await expect(page.locator('a').first()).toHaveCSS('touch-action', 'manipulation')
  const button = page.getByRole('button', { name: /Show/ })
  await expect(button).toHaveCSS('touch-action', 'manipulation')
  await expect(button).toHaveCSS('user-select', 'none')

  // A Segmented segment is a span[role=radio], not a button.
  await page.goto('/settings/appearance')
  const segment = page.getByRole('radio', { name: 'Dark' })
  await expect(segment).toHaveCSS('touch-action', 'manipulation')
  await expect(segment).toHaveCSS('user-select', 'none')
  await page.goto('/')
  await firstReading(page)

  // A tap must not leave the hover layer lit.
  await button.tap()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(() => button.evaluate((el) => Number(getComputedStyle(el, '::before').opacity)))
    .toBe(0)
})
