import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'
import type { Page } from '@playwright/test'

/** The chat flows the unit tests cannot reach (Y-484): they need a real
 *  mounted Session, a second tab, or a reload. The fixture's chat socket acts
 *  as chat.rs does for each. */
const NAME = 'yantra-web'
const PATH = `/w/${NAME}`
const THREAD = '1a2b3c4d'

const views = (page: Page) => page.getByRole('navigation', { name: 'Views' })
const asking = (page: Page) => page.getByText('Claude asks to run')
const composer = (page: Page) => page.getByLabel(`Message Claude in ${NAME}`, { exact: true })

async function send(page: Page) {
  await composer(page).fill('run the core tests')
  await page.getByRole('button', { name: 'Send' }).click()
}

async function turn(page: Page) {
  await send(page)
  await expect(asking(page)).toBeVisible()
}

async function fullAccess(page: Page) {
  await page.getByRole('button', { name: /^Permissions: / }).click()
  await page.getByRole('menuitemradio', { name: 'Full access' }).click()
  await expect(page.getByRole('button', { name: 'Permissions: Full access' })).toBeVisible()
}

test.describe('the chat, across views, tabs and reloads', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(page.getByRole('heading', { level: 1, name: NAME }).first()).toBeVisible()
  })

  test('Terminal and back keeps a turn running', async ({ page }) => {
    await turn(page)
    await views(page).getByRole('link', { name: 'Terminal' }).click()
    await expect(views(page).getByRole('link', { name: 'Terminal' })).toHaveAttribute('aria-current', 'page')
    await views(page).getByRole('link', { name: 'Chat' }).click()

    await expect(asking(page)).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('Claude is waiting for your answer.')
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
  })

  test('a second tab cannot revert during a turn', async ({ page }) => {
    await turn(page)
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    const revert = page.getByRole('button', { name: 'Revert to before this turn' })
    await expect(revert).toBeVisible()

    const other = await page.context().newPage()
    await other.goto(`${PATH}?thread=${THREAD}`)
    await expect(other.getByText('Is the core crate green?')).toBeVisible()
    await turn(other)

    await revert.click()
    await page
      .getByRole('dialog', { name: 'Revert to before turn 1?' })
      .getByRole('button', { name: 'Revert', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText(
      'another tab is running a turn or a revert in this thread',
    )
    await expect(page.getByText('Reverted')).toHaveCount(0)

    await other.getByRole('button', { name: 'Stop Claude' }).click()
    await expect(other.getByRole('status')).toHaveText('Claude stopped.')
    await revert.click()
    await page
      .getByRole('dialog', { name: 'Revert to before turn 1?' })
      .getByRole('button', { name: 'Revert', exact: true })
      .click()
    await expect(page.getByText('Reverted')).toBeVisible()
  })

  test('Full access draws no permission card', async ({ page }) => {
    await fullAccess(page)
    await send(page)
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    await expect(asking(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    await page.getByText('Output').click()
    await expect(page.getByText('test result: ok')).toBeVisible()
  })

  test('the mode survives a reload', async ({ page }) => {
    await fullAccess(page)
    await send(page)
    await expect(page).toHaveURL(new RegExp(`thread=${THREAD}`))
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Permissions: Full access' })).toBeVisible()
  })
})

/** Y-560: one composer for the Chat and the Room, copied from T3 Code's. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG })
// A phone's picture is the screen as held: its composer is pinned to the foot, and a whole-page capture moves it.
const shell = (page: Page) => page.locator('[data-slot="composer-shell"]')
/** Write `shell/prefs.ts`'s key before the first paint, as dashboard.spec.ts does. */
async function dark(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'yantra.prefs',
      JSON.stringify({ v: 1, seenAt: null, seed: null, general: {}, theme: 'dark', density: 'clean' }),
    )
  })
}
const kept = (page: Page) => page.evaluate(() => localStorage.getItem(`yantra.chat.draft.workspace/yantra-web`))

test.describe('the composer', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(page.getByRole('heading', { level: 1, name: NAME }).first()).toBeVisible()
  })

  test('rests as one line, and looks like the board', async ({ page, size }) => {
    await expect(shell(page)).toHaveAttribute('data-empty', '')
    const box = await composer(page).boundingBox()
    expect(box?.height ?? 0).toBeLessThanOrEqual(32)
    await screenshot(page, 'composer-resting', 'busy', size, { overlay: size === 'phone' })
  })

  test('grows with a three-line draft and looks like the board', async ({ page, size }) => {
    await composer(page).fill('Fix the parser for nested fences.\nKeep the old tests.\nThen run the core suite.')
    await composer(page).focus()
    await expect(shell(page)).not.toHaveAttribute('data-empty', '')
    const box = await composer(page).boundingBox()
    expect(box?.height ?? 0).toBeGreaterThan(72)
    await screenshot(page, 'composer-draft', 'busy', size, { overlay: size === 'phone' })
  })

  test('shows the keyboard focus on the card, since the field draws no outline', async ({ page }) => {
    const edge = () =>
      page.locator('.composer__card').evaluate((card) => getComputedStyle(card, '::after').borderTopColor)
    const resting = await edge()
    await page.keyboard.press('Tab')
    await expect(composer(page)).toBeFocused()
    await expect.poll(edge).not.toBe(resting)
  })

  test('focuses the field on a press on the card that lands on no control', async ({ page }) => {
    await expect(composer(page)).not.toBeFocused()
    const controls = page.locator('.composer__controls')
    const box = (await controls.boundingBox())!
    await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2)
    await expect(composer(page)).toBeFocused()
    await composer(page).blur()
    await page.getByRole('button', { name: /^Permissions: / }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(composer(page)).not.toBeFocused()
  })

  test('words its resting line so that no placeholder is cut mid-word', async ({ page }) => {
    const fits = await composer(page).evaluate((field: HTMLTextAreaElement) => {
      const style = getComputedStyle(field)
      const context = document.createElement('canvas').getContext('2d')!
      context.font = style.font
      const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return context.measureText(field.placeholder).width <= room
    })
    expect(fits).toBe(true)
  })

  test('keeps the remove button of a tile off the next tile', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([png('a.png'), png('b.png')])
    const images = page.getByRole('list', { name: 'Images' })
    await expect(images.getByRole('listitem')).toHaveCount(2)
    const remove = page.getByRole('button', { name: 'Remove image 1' })
    const next = page.getByRole('button', { name: 'Preview image 2' })
    const owns = async (button: typeof remove, dx: number, dy: number, from: 'middle' | 'corner') => {
      const box = (await button.boundingBox())!
      const at = from === 'middle' ? [box.x + dx, box.y + box.height / 2 + dy] : [box.x + dx, box.y + dy]
      return button.evaluate((one, point) => document.elementFromPoint(point[0]!, point[1]!)?.closest('button') === one, at)
    }
    // The tiles settle a frame after they are drawn, so each point is read with its box in one step.
    await expect
      .poll(async () => [
        // A point 23 px right of the button's middle is still its own 48 px target.
        await owns(remove, 12 + 23, 0, 'middle'),
        // The next tile's near edge, level with the first button's hit area, belongs to its preview.
        await owns(next, 1, 0, 'middle'),
        await owns(next, 1, 16, 'corner'),
      ])
      .toEqual([true, true, true])
  })

  test('stops growing at 40vh and then scrolls', async ({ page }) => {
    await composer(page).fill(Array.from({ length: 80 }, (_, at) => `line ${at}`).join('\n'))
    const { height, scrolls } = await composer(page).evaluate((box) => ({
      height: box.getBoundingClientRect().height,
      scrolls: box.scrollHeight > box.clientHeight,
    }))
    expect(height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.4 + 1)
    expect(scrolls).toBe(true)
  })

  test('keeps a draft across a reload', async ({ page }) => {
    await composer(page).fill('a draft to keep')
    await expect.poll(() => kept(page)).toBe('a draft to keep')
    await page.reload()
    await expect(composer(page)).toHaveValue('a draft to keep')
    await composer(page).fill('')
    await expect.poll(() => kept(page)).toBeNull()
  })

  test('ArrowUp brings back the last prompt and ArrowDown goes forward', async ({ page }) => {
    await fullAccess(page)
    await send(page)
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    await composer(page).focus()
    await page.keyboard.press('ArrowUp')
    await expect(composer(page)).toHaveValue('run the core tests')
    await page.keyboard.press('ArrowDown')
    await expect(composer(page)).toHaveValue('')
  })

  test('Shift+Enter writes a new line, and Enter sends where the setting says so', async ({ page, size }) => {
    await fullAccess(page)
    await composer(page).fill('one')
    await composer(page).press('Shift+Enter')
    await composer(page).pressSequentially('two')
    await expect(composer(page)).toHaveValue('one\ntwo')
    // A phone keeps Enter for a new line, and sends from its button.
    if (size === 'phone') {
      await composer(page).press('Enter')
      await expect(composer(page)).toHaveValue('one\ntwo\n')
      await composer(page).press('Control+Enter')
    } else {
      await composer(page).press('Enter')
    }
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
  })

  test('draws two images, one failed, and looks like the board', async ({ page, size }) => {
    await page.locator('input[type="file"]').setInputFiles([png('a.png'), { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') }])
    const images = page.getByRole('list', { name: 'Images' })
    await expect(images.getByRole('listitem')).toHaveCount(2)
    await expect(images.getByRole('listitem').first()).toHaveAttribute('data-state', 'attached')
    await expect(page.getByRole('alert').getByRole('heading')).toHaveText('Image 2 is not attached')
    await composer(page).fill('What is in these?')
    await screenshot(page, 'composer-images', 'busy', size, { overlay: size === 'phone' })
  })

  test('opens an image large', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([png('a.png')])
    await page.getByRole('button', { name: 'Preview image 1' }).click()
    await expect(page.getByRole('dialog', { name: 'Image 1' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('shows a closed chat with its reason, and looks like the board', async ({ page, size }) => {
    await page.goto(`${PATH}?thread=ffffffff`)
    await expect(page.getByRole('alert')).toContainText('This workspace has no chat with that id.')
    await expect(page.getByLabel(/^Message .* in yantra-web$/)).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(
      'The chat is not connected, so nothing can be sent.',
    )
    // Where a phone ends up scrolled depends on whether the thread list or the banner arrived first, so the capture is the top.
    await expect(page.getByRole('link', { name: /^3a1b2c3d4e5f6a7b/ })).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 0))
    await screenshot(page, 'composer-closed', 'busy', size, { overlay: size === 'phone' })
  })

  test('draws the logged-out surface under the composer', async ({ page }) => {
    await page.getByRole('button', { name: 'Harness: Claude' }).click()
    await page.getByRole('menuitemradio', { name: 'Gemini' }).click()
    await page.getByLabel(`Message Gemini in ${NAME}`, { exact: true }).fill('hello')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByRole('alert').getByRole('heading')).toHaveText('Gemini is not logged in on cachyos-g14')
    await expect(page.getByLabel(`Message Gemini in ${NAME}`, { exact: true })).toHaveValue('hello')
    // The banner and the card are one column: the same left edge and the same width.
    const column = async (locator: ReturnType<Page['locator']>) => {
      const box = (await locator.boundingBox())!
      return [Math.round(box.x), Math.round(box.width)]
    }
    expect(await column(page.getByRole('alert'))).toEqual(await column(shell(page)))
  })

  test('passes axe at rest and with a draft', async ({ page }) => {
    await axe(page)
    await composer(page).fill('a draft')
    await axe(page)
  })

  test('walks by keyboard', async ({ page }) => {
    await composer(page).focus()
    await keyboardWalk(page, 6)
  })

  test('keeps every control a 48 px target', async ({ page }) => {
    await composer(page).fill('send me')
    await composer(page).focus()
    const send = await page.getByRole('button', { name: 'Send' }).boundingBox()
    expect(send?.height ?? 0).toBeGreaterThanOrEqual(48)
    expect(send?.width ?? 0).toBeGreaterThanOrEqual(48)
    // A 32 px control reaches 48 px by its hit area, so a point 23 px above and below its middle still lands on it.
    // The box and the hits are read in one step, because the card settles a frame after the focus.
    for (const label of ['Attach an image', /^Harness: /, /^Permissions: /]) {
      const name = await page.getByRole('button', { name: label }).getAttribute('aria-label')
      await expect
        .poll(() =>
          page.evaluate((want) => {
            const control = document.querySelector(`[aria-label="${want}"]`)!
            const box = control.getBoundingClientRect()
            return [-23, 23].map(
              (dy) =>
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2 + dy)?.closest('button') === control,
            )
          }, name),
        )
        .toEqual([true, true])
    }
  })

  test('rides at the foot of the screen on a phone while the page scrolls', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the dock is sticky on the phone only')
    await page.setViewportSize({ width: 390, height: 520 })
    await page.evaluate(() => window.scrollTo(0, 0))
    const dock = page.locator('.chat__dock')
    await expect(dock).toBeInViewport({ ratio: 1 })
    const viewport = page.viewportSize()!.height
    const at = async () => {
      const box = (await dock.boundingBox())!
      return Math.round(box.y + box.height)
    }
    expect(await at()).toBeGreaterThanOrEqual(viewport - 1)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    expect(await at()).toBeGreaterThanOrEqual(viewport - 1)
    await expect(dock).toBeInViewport({ ratio: 1 })
  })
})

test.describe('the composer, running a turn with a plan', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'composer')
    await page.goto(PATH)
    await expect(page.getByRole('heading', { level: 1, name: NAME }).first()).toBeVisible()
    await turn(page)
  })

  test('draws a red Stop, the status line and the plan badge, and looks like the board', async ({ page, size }) => {
    await expect(page.getByRole('button', { name: 'Stop Claude' })).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('Claude is waiting for your answer.')
    const badge = page.getByRole('button', { name: /^Plan: 1 of 4 complete/ })
    await expect(badge).toContainText('Fix the parser for nested fences')
    await screenshot(page, 'composer-running', 'composer', size, { overlay: size === 'phone' })
  })

  test('opens the plan, and passes axe with it open', async ({ page, size }) => {
    await page.getByRole('button', { name: /^Plan: / }).click()
    const steps = page.getByRole('list', { name: /^Plan\./ })
    await expect(steps.getByRole('listitem')).toHaveCount(4)
    await expect(steps).toContainText('Running: Fix the parser for nested fences')
    await axe(page)
    await screenshot(page, 'composer-plan', 'composer', size, { overlay: size === 'phone' })
  })

  test('keeps the request answerable on a phone after the plan opens', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the dock is sticky on the phone only')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: /^Plan: / }).click()
    await expect(page.getByRole('list', { name: /^Plan\./ })).toBeVisible()
    // In the viewport is not enough: the dock must not be what sits over the button.
    const accept = page.getByRole('button', { name: 'Accept', exact: true })
    for (const name of ['Accept', 'Accept always', 'Decline']) {
      const button = page.getByRole('button', { name, exact: true })
      await expect(button).toBeInViewport({ ratio: 1 })
      await expect
        .poll(() =>
          button.evaluate((one) => {
            const box = one.getBoundingClientRect()
            return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === one
          }),
        )
        .toBe(true)
    }
    await accept.click()
  })

  test('opens the plan on the spring, and the reduced-motion page opens it on opacity alone', async ({ page }) => {
    const transition = () =>
      page.locator('.composer-plan__reveal').evaluate((one) => getComputedStyle(one).transitionProperty)
    await page.getByRole('button', { name: /^Plan: / }).click()
    expect(await transition()).toBe('opacity')
    await page.getByRole('button', { name: /^Collapse plan: / }).click()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('button', { name: /^Plan: / }).click()
    expect(await transition()).toContain('grid-template-rows')
  })

  test('turns the context ring red above 90 percent, and passes axe with its popover open', async ({ page }) => {
    const ring = page.getByRole('button', { name: 'Context window 93% used' })
    await expect(ring).toBeVisible()
    await ring.click()
    const popup = page.getByRole('dialog', { name: 'Context window' })
    await expect(popup).toContainText('186k tokens')
    await expect(popup).toContainText('200k tokens')
    await axe(page)
  })

  test('stops the turn from the red button', async ({ page }) => {
    await page.getByRole('button', { name: 'Stop Claude' }).click()
    await expect(page.getByRole('status')).toHaveText('Claude stopped.')
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  })
})

test('an issue draft fills the card with no label over it', async ({ page, size }) => {
  await scenario(page, 'busy')
  await page.goto(route('fleet').path)
  await page.getByRole('button', { name: 'Start session on 2002Bishwajeet/yantra#118' }).click()
  await page
    .getByRole('dialog')
    .getByRole('list', { name: 'Workspaces that hold this repository' })
    .getByRole('button', { name: 'yantra-web' })
    .click()
  await expect(composer(page)).toHaveValue(/^Work on /)
  await expect(shell(page).locator('label')).toHaveCount(0)
  await screenshot(page, 'composer-issue-draft', 'busy', size, { overlay: size === 'phone' })
})

test.describe('the composer in the dark', () => {
  test.beforeEach(async ({ page }) => {
    await dark(page)
  })

  test('rests on the dark roles, and looks like the board', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'the dark board is a desktop board')
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(composer(page)).toBeVisible()
    await screenshot(page, 'composer-dark-resting', 'busy', size)
  })

  test('runs a turn with its plan open on the dark roles, and looks like the board', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'the dark board is a desktop board')
    await scenario(page, 'composer')
    await page.goto(PATH)
    await turn(page)
    await page.getByRole('button', { name: /^Plan: / }).click()
    await expect(page.getByRole('list', { name: /^Plan\./ })).toBeVisible()
    await axe(page)
    await screenshot(page, 'composer-dark-plan', 'composer', size)
  })
})
