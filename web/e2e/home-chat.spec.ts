import { axe, expect, scenario, test } from './lib/test'
import type { Page } from '@playwright/test'

/** Y-700 (ADR-0046): Claude in a machine's home folder. The fixture's `/api/machines/{m}/chat`
 *  socket is the workspace chat's with no worktree, so no diff and no checkpoint. */
const MACHINE = 'cachyos-g14'
const PATH = `/m/${MACHINE}/home`
const THREAD = '6a1b2c3d4e5f6a7b'
const MIN = 44

const composer = (page: Page) => page.getByLabel(`Message Claude in ${MACHINE}`, { exact: true })
const GIT = /^(Diff|Revert|Commit|Push|Open PR|Git actions|Terminal)/

test.beforeEach(async ({ page, size }) => {
  test.skip(size === 'tablet', 'the phone and the desktop are the two ways this chat is used')
  await scenario(page, 'busy')
})

async function turn(page: Page) {
  await composer(page).fill('say hello from home')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page).toHaveURL(new RegExp(`thread=${THREAD}`))
}

async function finish(page: Page) {
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Claude finished.')
}

test('New session offers Chat in home folder once a machine is chosen, and it opens the home chat', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: MACHINE, exact: true }).click()
  const link = page.getByRole('link', { name: 'Chat in home folder' })
  await expect(link).toBeVisible()
  const box = (await link.boundingBox())!
  expect(Math.round(box.height)).toBeGreaterThanOrEqual(40)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`${PATH}$`))
  await expect(composer(page)).toBeVisible()
})

test('the chat has no Diff, Revert, Commit, Push or Open PR, and says it has no repository', async ({ page }) => {
  await page.goto(PATH)
  await expect(composer(page)).toBeVisible()
  await expect(page.getByText(`Claude works in the home folder on ${MACHINE}, with no repository.`)).toBeVisible()
  await expect(page.getByRole('button', { name: GIT })).toHaveCount(0)
  await turn(page)
  await finish(page)
  await expect(page.getByRole('button', { name: GIT })).toHaveCount(0)
  await expect(page.getByRole('article', { name: /What turn \d+ changed/ })).toHaveCount(0)
})

test('a sent turn names the thread in the URL, and reopening ?thread= resumes it', async ({ page }) => {
  await page.goto(PATH)
  await turn(page)
  await finish(page)
  await page.goto(`${PATH}?thread=${THREAD}`)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  await expect(composer(page)).toBeVisible()
})

test('the desktop rail lists the thread under its machine by title', async ({ page, size }) => {
  test.skip(size !== 'desktop', 'the rail is the desktop shell')
  await page.goto(PATH)
  await turn(page)
  await finish(page)
  const home = page.getByRole('complementary', { name: 'Sessions' }).getByRole('region', { name: 'Home' })
  const row = home.getByRole('link', { name: new RegExp(`say hello from home.*${MACHINE}`) })
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('href', `${PATH}?thread=${THREAD}`)
  await expect(row).toHaveAttribute('data-tone', 'selected')
})

test('Remove closes the thread and starts a fresh one', async ({ page }) => {
  await page.goto(PATH)
  await turn(page)
  await finish(page)
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByRole('dialog', { name: 'Remove this thread' }).getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page).not.toHaveURL(/thread=/)
  await expect(page.getByText(`Claude works in the home folder on ${MACHINE}, with no repository.`)).toBeVisible()
  await page.goto(`${PATH}?thread=${THREAD}`)
  await expect(page.getByRole('alert')).toContainText('has no chat thread')
})

test('a machine the tailnet does not have is a typed not-found surface', async ({ page }) => {
  await page.goto('/m/no-such-box/home')
  await expect(page.getByRole('heading', { name: 'No such machine' })).toBeVisible()
  await expect(page.getByText('The tailnet has no machine called no-such-box.', { exact: true })).toBeVisible()
})

test('has no axe violation, a 44 px hit area on the phone, and keeps the width', async ({ page, size }) => {
  await page.goto(PATH)
  await expect(composer(page)).toBeVisible()
  await axe(page)

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  if (size !== 'phone') return
  const offenders = await page.evaluate((min) => {
    const found: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('a[href], button, [role=button], [role=menuitem]')) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      let [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom]
      const after = getComputedStyle(el, '::after')
      if (after.content !== 'none' && after.position === 'absolute') {
        left += Math.min(0, parseFloat(after.left) || 0)
        top += Math.min(0, parseFloat(after.top) || 0)
        right -= Math.min(0, parseFloat(after.right) || 0)
        bottom -= Math.min(0, parseFloat(after.bottom) || 0)
      }
      if (Math.round(right - left) < min || Math.round(bottom - top) < min) {
        found.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}"`)
      }
    }
    return found
  }, MIN)
  expect(offenders).toEqual([])
})
