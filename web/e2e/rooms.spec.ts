import { axe, expect, keyboardWalk, scenario, test } from './lib/test'

/** `/rooms` and `/rooms/$room` (Y-536) on the `rooms` scenario: `design-review`
 *  is live and `release` is paused at 20/20. The `phone` project is the done
 *  proof: the owner steers a room from the phone. No screenshot, because a new
 *  baseline is made in CI's image and the gate refuses a missing one. */

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

    await page.getByLabel('Message').fill('Fix the links, then ship.')
    await page.getByRole('button', { name: 'Post' }).click()
    await expect(log.getByRole('listitem')).toHaveCount(3)
    await expect(log.getByRole('listitem').last()).toContainText('owner on pixel')
    await expect(log.getByRole('listitem').last()).toContainText('Fix the links, then ship.')
    await expect(page.getByLabel('Message')).toHaveValue('')
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

  test('with no rooms, the list says so', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/rooms')
    await expect(page.getByText('No rooms', { exact: true })).toBeVisible()
  })
})
