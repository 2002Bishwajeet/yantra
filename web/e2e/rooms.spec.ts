import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/** `/rooms` and `/rooms/$room` (Y-536) on the `rooms` scenario: `design-review`
 *  is live and `release` is paused at 20/20. The `phone` project is the done
 *  proof: the owner steers a room from the phone. The post form is the Chat's
 *  composer (Y-560), and its baseline is made in CI's image. */

// The phone's app bar is a second h1 over the screen's hidden one.
const heading = (page: Parameters<typeof axe>[0], name: string) =>
  page.getByRole('heading', { level: 1, name }).first()

test.describe('rooms', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'rooms')
  })

  test('the owner opens a paused room from the account menu, posts, and resumes', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitem', { name: 'Rooms' }).click()
    await expect(heading(page, 'Rooms')).toBeVisible()

    const live = page.getByRole('link', { name: /design-review/ })
    await expect(live).toContainText('3/20 · 2 members · 3 messages')
    await expect(live).not.toContainText('paused')
    const paused = page.getByRole('link', { name: /release/ })
    await expect(paused).toContainText('20/20')
    await expect(paused).toContainText('paused')

    await paused.click()
    await expect(heading(page, 'release')).toBeVisible()
    const log = page.getByRole('list', { name: 'Messages' })
    await expect(log.getByRole('listitem')).toHaveCount(2)
    await expect(log).toContainText('Two links are broken in the notes.')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()

    await page.getByRole('textbox', { name: 'Message' }).fill('Fix the links, then ship.')
    await page.getByRole('button', { name: 'Post' }).click()
    await expect(log.getByRole('listitem')).toHaveCount(3)
    await expect(log.getByRole('listitem').last()).toContainText('owner on pixel')
    await expect(log.getByRole('listitem').last()).toContainText('Fix the links, then ship.')
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    // A person's post sets the count to 0, so the pause is gone with it.
    await expect(page.getByRole('button', { name: 'Resume' })).toBeHidden()
    await expect(page.getByText('0/20 · 2 members · 3 messages')).toBeVisible()
  })

  test('Resume lifts the pause and the banner goes', async ({ page }) => {
    await page.goto('/rooms/release')
    await expect(heading(page, 'release')).toBeVisible()
    await page.getByRole('button', { name: 'Resume' }).click()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeHidden()
    await expect(page.getByText('0/20 · 2 members · 2 messages')).toBeVisible()

    await page.goto('/rooms')
    await expect(page.getByRole('link', { name: /release/ })).not.toContainText('paused')
  })

  test('a room the daemon does not hold is named, with a way back', async ({ page }) => {
    await page.goto('/rooms/gone')
    const alert = page.getByRole('alert')
    await expect(alert.getByRole('heading', { name: 'No room is called gone' })).toBeVisible()
    await alert.getByRole('link', { name: 'All rooms' }).click()
    await expect(heading(page, 'Rooms')).toBeVisible()
  })

  test('the room passes axe', async ({ page }) => {
    await page.goto('/rooms/release')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await axe(page)
  })

  test('the list passes axe', async ({ page }) => {
    await page.goto('/rooms')
    await expect(page.getByRole('link', { name: /release/ })).toBeVisible()
    await axe(page)
  })

  test('the room walks by keyboard', async ({ page }) => {
    await page.goto('/rooms/release')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await keyboardWalk(page, 8)
  })

  test('every control in the room is a 48 px target', async ({ page }) => {
    await page.goto('/rooms/release')
    for (const name of ['Resume', 'Post']) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(48)
      expect(box?.width ?? 0, name).toBeGreaterThanOrEqual(48)
    }
  })

  test('the post form is the shared composer, and looks like the board', async ({ page, size }) => {
    await page.goto('/rooms/release')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAccessibleDescription(
      'Every agent in the room reads it. Posting sets the count back to 0.',
    )
    await expect(page.getByRole('button', { name: 'Post' })).toHaveAccessibleDescription('Type a message to post it.')
    await page.getByRole('textbox', { name: 'Message' }).fill('Fix the links, then ship.')
    await screenshot(page, 'room-composer', 'rooms', size)
  })

  test('the messages, the banner and the post form are one column', async ({ page }) => {
    await page.goto('/rooms/release')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    const column = async (locator: ReturnType<typeof page.locator>) => {
      const box = (await locator.boundingBox())!
      return [Math.round(box.x), Math.round(box.width)]
    }
    const card = await column(page.locator('[data-slot="composer-shell"]'))
    expect(await column(page.getByRole('list', { name: 'Messages' }))).toEqual(card)
    expect(await column(page.locator('.room__paused'))).toEqual(card)
  })

  test('the post form rides at the foot of the screen, as the Chat does', async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 })
    await page.goto('/rooms/release')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    const form = page.locator('.composer-dock')
    await expect(form).toHaveCSS('position', 'sticky')
    for (const to of [0, 'end'] as const) {
      await page.evaluate((y) => window.scrollTo(0, y === 'end' ? document.body.scrollHeight : y), to)
      await expect(form).toBeInViewport({ ratio: 1 })
      const box = (await form.boundingBox())!
      expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(420 - 1)
    }
  })

  test('Shift+Enter writes a new line in the post form, and Enter posts', async ({ page, size }) => {
    test.skip(size === 'phone', 'a phone keeps Enter for a new line')
    await page.goto('/rooms/release')
    const box = page.getByRole('textbox', { name: 'Message' })
    await box.fill('one')
    await box.press('Shift+Enter')
    await box.pressSequentially('two')
    await expect(box).toHaveValue('one\ntwo')
    await box.press('Enter')
    await expect(page.getByRole('list', { name: 'Messages' }).getByRole('listitem')).toHaveCount(3)
  })

  test('with no rooms, the list says so', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/rooms')
    await expect(page.getByText('No rooms', { exact: true })).toBeVisible()
  })
})
