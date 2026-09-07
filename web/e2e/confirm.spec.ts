import type { Page } from '@playwright/test'
import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'

/** Y-351, inventory groups 6 and 7: the two questions that cannot be undone.
 *  A dialog on a desktop and a tablet, a bottom sheet on a phone
 *  (ConfirmKill, PhoneConfirmKill, ConfirmDelete). The screens that host them
 *  belong to other rows; what is asserted here is the question. */

const KILL = route('session-terminal').path
const DELETE = route('session').path

/* The screen *behind* the question draws a link inside a paragraph, and M3's
   primary on `on-surface-variant` is 1.46:1 without an underline. It is the
   host's debt, not the dialog's, and Y-352 carries it; the day it is fixed,
   this list fails until it is edited. */
const KNOWN = { known: ['link-in-text-block'] }

/** Base UI moves focus into the popup after it opens; a walk that starts
 *  before that lands on the page behind. */
const focused = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
    .toBe(true)

test.describe('Kill a session', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(KILL)
    await page.getByRole('button', { name: 'Kill', exact: true }).click()
  })

  test('repeats the row, and both containers say the same thing', async ({ page }) => {
    const asked = page.getByRole('dialog')
    await expect(asked).toBeVisible()
    await expect(asked.getByRole('heading', { name: 'Kill scratch?' })).toBeVisible()
    await expect(asked).toContainText('every process in it end now')
    await expect(asked).toContainText('cachyos-g14')
    await expect(asked.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(asked.getByRole('button', { name: 'Kill', exact: true })).toBeVisible()
  })

  test('passes axe, walks by keyboard and closes on Escape', async ({ page, size }) => {
    await focused(page)
    await axe(page, KNOWN)
    await keyboardWalk(page, 3)
    await screenshot(page, 'confirm-kill', 'busy', size)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})

test.describe('Delete a workspace', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(DELETE)
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
  })

  test('names the file it removes, and what it leaves', async ({ page }) => {
    const asked = page.getByRole('dialog')
    await expect(asked).toBeVisible()
    await expect(asked.getByRole('heading', { name: 'Delete landing?' })).toBeVisible()
    await expect(asked).toContainText('~/.config/yantra/workspaces')
    await expect(asked).toContainText('the repository and the tmux session stay')
    await expect(asked.getByRole('button', { name: 'Cancel' })).toBeVisible()
  })

  test('passes axe, walks by keyboard and closes on Escape', async ({ page, size }) => {
    await focused(page)
    await axe(page, KNOWN)
    await keyboardWalk(page, 3)
    await screenshot(page, 'confirm-delete', 'busy', size)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})

test('a refused kill is drawn under the question, and the question stays open', async ({ page, size }) => {
  test.skip(size !== 'desktop', 'one size is enough for the wire')
  await scenario(page, 'refused')
  await page.goto(KILL)
  await page.getByRole('button', { name: 'Kill', exact: true }).click()
  const asked = page.getByRole('dialog')
  await asked.getByRole('button', { name: 'Kill', exact: true }).click()
  await expect(asked.getByRole('alert')).toContainText('is not yours')
  await expect(asked).toBeVisible()
})
