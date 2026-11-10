import { expect, scenario, test } from './lib/test'

/** R14 §5 and §7 in a browser: the spring runs where motion is welcome, and
 *  a spatial transition lands in one frame under reduce while the fade stays.
 *  The desktop bell's popover is the surface; every project runs under
 *  `reduce` for the screenshots, so the first block opts out of it. */
const open = async (page: Parameters<typeof scenario>[0], watch = false) => {
  // A count taken after the open races the 0.36s spring on a loaded runner; a listener cannot miss the run.
  if (watch)
    await page.addInitScript(() => {
      const seen = { runs: 0 }
      Object.assign(window, { popoverRuns: seen })
      addEventListener(
        'transitionrun',
        (event) => {
          if ((event.target as Element).classList?.contains('m3-popover')) seen.runs++
        },
        true,
      )
    })
  await scenario(page, 'busy')
  await page.goto('/')
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const popup = page.locator('.m3-popover')
  await expect(popup).toBeVisible()
  // Base UI mounts with `data-starting-style` and an inline `transition:
  // none` for one frame, so it can jump to the starting values instead of
  // animating from the default ones; reading the transition before that
  // frame ends sees "none". Wait for the real, transitioning state.
  await expect(popup).not.toHaveAttribute('data-starting-style')
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
    const popup = await open(page, true)
    expect(await popup.evaluate(durationOf, 'transform')).toBe('0.36s')
    const ran = await page.evaluate(() => (window as unknown as { popoverRuns: { runs: number } }).popoverRuns.runs)
    expect(ran).toBeGreaterThan(0)
    await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    expect(await popup.evaluate((el) => getComputedStyle(el).transform)).toBe('none')
  })

  test('the Idle disclosure opens on a grid-template-rows transition', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'one surface is enough to prove the animation survived')
    await scenario(page, 'busy')
    await page.goto('/')
    const show = page.getByRole('button', { name: /Show/ })
    await show.click()
    const panel = page.locator('#' + (await show.getAttribute('aria-controls')))
    expect(await panel.evaluate(durationOf, 'grid-template-rows')).toBe('0.435s')
    expect(await panel.evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0)
    await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
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

/** Y-678: a route change runs one view transition, typed by direction. */
const watchTransitions = (page: Parameters<typeof scenario>[0]) =>
  page.addInitScript(() => {
    const seen: string[][] = []
    Object.assign(window, { transitions: seen })
    const start = document.startViewTransition?.bind(document)
    if (!start) return
    document.startViewTransition = ((arg: unknown) => {
      seen.push((arg as { types?: string[] }).types ?? [])
      return start(arg as never)
    }) as typeof document.startViewTransition
  })
const transitions = (page: Parameters<typeof scenario>[0]) =>
  page.evaluate(() => (window as unknown as { transitions: string[][] }).transitions)

const goMachines = async (page: Parameters<typeof scenario>[0], size: string) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  const nav = size === 'phone' ? page.getByRole('navigation', { name: 'Main' }) : page
  await nav.getByRole('link', { name: 'Machines' }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Machines' })).toBeVisible()
}

test.describe('route changes with motion', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('each change runs one transition and back runs it backwards', async ({ page, size }) => {
    test.skip(size === 'tablet', 'the phone bar and the desktop links are enough')
    await scenario(page, 'busy')
    await watchTransitions(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    const bar = page.getByRole('navigation', { name: 'Main' })
    const before = size === 'phone' ? await bar.boundingBox() : null
    await goMachines(page, size)
    await page.locator('a[href^="/m/"]').first().click()
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Machines')
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1, name: 'Machines' })).toBeVisible()
    const seen = await transitions(page)
    expect(seen).toHaveLength(3)
    expect(seen.map((types) => types[0])).toEqual(['forward', 'forward', 'back'])
    // The chrome is its own transition group, so the bar does not slide.
    if (before) expect(await bar.boundingBox()).toEqual(before)
  })
})

test.describe('route changes under reduce', () => {
  test.use({ reducedMotion: 'reduce' })

  test('no transition runs and the screen still changes', async ({ page, size }) => {
    await scenario(page, 'busy')
    await watchTransitions(page)
    await goMachines(page, size)
    expect(await transitions(page)).toHaveLength(0)
  })
})
