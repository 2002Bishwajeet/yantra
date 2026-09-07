import { expect, scenario, test } from './lib/test'

/** R14 §5 and §7 in a browser: the spring runs where motion is welcome, and
 *  a spatial transition lands in one frame under reduce while the fade stays.
 *  The desktop bell's popover is the surface; every project runs under
 *  `reduce` for the screenshots, so the first block opts out of it. */
const open = async (page: Parameters<typeof scenario>[0]) => {
  await scenario(page, 'busy')
  await page.goto('/')
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const popup = page.locator('.m3-popover')
  await expect(popup).toBeVisible()
  return popup
}

// Runs in the page, so the property travels as the argument.
const durationOf = (el: Element, property: string) => {
  const style = getComputedStyle(el)
  const index = style.transitionProperty.split(', ').indexOf(property)
  return style.transitionDuration.split(', ')[index] ?? null
}

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('the popover opens on the spring and settles', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'the popover is the desktop bell')
    const popup = await open(page)
    expect(await popup.evaluate(durationOf, 'transform')).toBe('0.36s')
    const ran = await popup.evaluate((el) => el.getAnimations().length)
    expect(ran).toBeGreaterThan(0)
    await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    expect(await popup.evaluate((el) => getComputedStyle(el).transform)).toBe('none')
  })
})

test.describe('under reduce', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the popover moves in one frame', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'the popover is the desktop bell')
    const popup = await open(page)
    expect(await popup.evaluate(durationOf, 'transform')).toBe('0.001s')
  })

  test('and still fades', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'the popover is the desktop bell')
    test.fixme(true, 'index.css:354 floors every transition at 1ms; Phase 3 deletes that sheet')
    const popup = await open(page)
    expect(await popup.evaluate(durationOf, 'opacity')).toBe('0.15s')
  })
})
