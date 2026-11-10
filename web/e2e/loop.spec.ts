import { axe, expect, scenario, test } from './lib/test'
import { route } from './lib/routes'
import type { Locator, Page } from '@playwright/test'

/** The coding loop (Y-489): an inbox issue to a thread in Chat. The fixture
 *  answers the daemon's `threads`, `threads/new` and `placement` routes. */
const ISSUE = '2002Bishwajeet/yantra#118'
const THREAD = '1a2b3c4d'

test('an inbox issue starts a session with its draft and lists the threads in the header menu', async ({ page }) => {
  await scenario(page, 'busy')
  await page.goto(route('fleet').path)
  await page.getByRole('button', { name: `Start session on ${ISSUE}` }).click()

  const dialog = page.getByRole('dialog', { name: `Start a session on ${ISSUE}` })
  const list = dialog.getByRole('list', { name: 'Workspaces that hold this repository' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('cachyos-g14')
  await expect(list).toContainText('it is idle and it has RAM to spare')
  await axe(page)

  await list.getByRole('button', { name: 'yantra-web' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/yantra-web\\?.*thread=${THREAD}`))
  // The draft is in router state, so the issue text is not in the address.
  expect(page.url()).not.toContain('Work')

  const composer = page.getByLabel('Message Claude in yantra-web', { exact: true })
  await expect(composer).toHaveValue(/^Work on /)

  await page.getByRole('button', { name: /^Threads, / }).click()
  const threads = page.getByRole('menu')
  // Five threads and the New thread link.
  await expect(threads.getByRole('menuitem').and(page.locator('a'))).toHaveCount(6)
  await expect(threads.locator('a[aria-current]')).toHaveCount(1)
  for (const mark of ['no PR', 'PR #512 open', 'PR #511 closed', 'PR #510 merged', 'PR unknown']) {
    await expect(threads.getByText(mark)).toBeVisible()
  }
  await expect(threads.getByText('#488 A workspace lists its threads')).toBeVisible()
  await expect(threads.getByText('The thread states could not be read')).toHaveCount(0)
})

/** The git actions (Y-493) on the fixture chat. `gitfails` refuses each route as the daemon does. */
const ATTACHED = '/w/yantra-web?thread=1a2b3c4d'

/** The daemon sends no git status, so the menu is how a page that has seen no diff reaches a verb. */
async function gitMenu(page: Page, item: string) {
  await page.locator('.chat__header').getByRole('button', { name: 'Git actions' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

test('a thread is drafted, edited, committed, pushed and opened as a PR', async ({ page }) => {
  await scenario(page, 'busy')
  await page.goto(ATTACHED)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  const bar = page.locator('.chat__header')

  await gitMenu(page, 'Commit')
  const dialog = page.getByRole('dialog', { name: 'Commit this thread' })
  const message = dialog.getByLabel('Commit message')
  await expect(message).toHaveValue(/^Add the commit and push verbs/)
  await message.fill('Add the git actions\n\nThe bar commits, pushes and opens a PR.')
  await axe(page)
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(bar.getByText('Committed: Add the commit and push verbs')).toBeVisible()

  // The quick action now names the next step, and runs the same verb as its menu item.
  await bar.getByRole('button', { name: 'Push', exact: true }).click()
  await expect(bar.getByText('Pushed origin/yantra/492-0a1b2c3d4e5f6a7b')).toBeVisible()

  await bar.getByRole('button', { name: 'Open PR', exact: true }).click()
  await expect(bar.getByRole('link', { name: 'PR #497' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Open PR', exact: true })).toHaveCount(0)
  await axe(page)
})

test('each failed git action is drawn with the daemon text', async ({ page }) => {
  await scenario(page, 'gitfails')
  await page.goto(ATTACHED)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  const failure = (title: string, said: string) =>
    page.getByRole('alert').filter({ has: page.getByRole('heading', { name: title }), hasText: said })

  await gitMenu(page, 'Commit')
  const dialog = page.getByRole('dialog', { name: 'Commit this thread' })
  await expect(failure('The draft failed', 'claude exited with status 1')).toBeVisible()
  await dialog.getByLabel('Commit message').fill('Write it myself')
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(failure('The commit was refused', 'Author identity unknown')).toBeVisible()
  await axe(page)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  await gitMenu(page, 'Push')
  await expect(failure('The push was refused', 'non-fast-forward')).toBeVisible()
  await gitMenu(page, 'Open PR')
  await expect(failure('The pull request was refused', 'not pushed to its upstream')).toBeVisible()
  await axe(page)
})

/** Y-496: a confirm dialog fits the screen, and on a phone its buttons stack full width at 44 px. */
async function fitsTheScreen(page: Page, dialog: Locator) {
  await expect(dialog).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (page.viewportSize()!.width >= 600) return
  const actions = dialog.locator('.m3-dialog__actions')
  const row = (await actions.boundingBox())!
  const buttons = actions.locator(':scope > *')
  await expect(buttons).toHaveCount(2)
  const [first, second] = [(await buttons.nth(0).boundingBox())!, (await buttons.nth(1).boundingBox())!]
  for (const one of [first, second]) {
    expect(one.width).toBeGreaterThanOrEqual(row.width - 1)
    expect(one.height).toBeGreaterThanOrEqual(44)
  }
  expect(Math.abs(first.y - second.y)).toBeGreaterThanOrEqual(44)
}

/** The daemon's refusal, drawn inside the dialog that asked for the verb. */
const refusal = (dialog: Locator, title: string, said: string) =>
  dialog.getByRole('alert').filter({ has: dialog.getByRole('heading', { name: title }), hasText: said })

test('an open PR is merged after the owner confirms, and the Chat offers to remove its worktree', async ({ page }) => {
  await scenario(page, 'busy')
  await page.goto(ATTACHED)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  await gitMenu(page, 'Open PR')
  await expect(page.locator('.chat__header').getByRole('link', { name: 'PR #497' })).toBeVisible()

  await gitMenu(page, 'Merge PR #497')
  const confirm = page.getByRole('dialog', { name: 'Merge PR #497' })
  await expect(
    confirm.getByText(
      'Squash-merge PR #497 as it is on GitHub now into the default branch, and delete its remote branch.',
      { exact: true },
    ),
  ).toBeVisible()
  await fitsTheScreen(page, confirm)
  await axe(page)
  await confirm.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(confirm).toBeHidden()

  const offer = page.getByRole('dialog', { name: 'PR #497 merged' })
  await expect(offer.getByText("Remove this thread's worktree and branch?", { exact: true })).toBeVisible()
  await expect(offer.getByRole('button', { name: 'Keep' })).toBeVisible()
  await fitsTheScreen(page, offer)
  await axe(page)
  await offer.getByRole('button', { name: 'Remove worktree' }).click()
  await expect(offer).toBeHidden()
  await expect(page).toHaveURL(/\/w\/yantra-web\?view=chat$/)
})

test('a refused merge is drawn in its dialog with the daemon text', async ({ page }) => {
  await scenario(page, 'mergefails')
  await page.goto(ATTACHED)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  await gitMenu(page, 'Merge PR #497')
  const confirm = page.getByRole('dialog', { name: 'Merge PR #497' })
  await confirm.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(refusal(confirm, 'The merge was refused', 'Pull Request is not mergeable')).toBeVisible()
  await fitsTheScreen(page, confirm)
  await axe(page)
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()
})

test('a refused removal is drawn in its dialog, and the thread stays', async ({ page }) => {
  await scenario(page, 'removefails')
  await page.goto(ATTACHED)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  await gitMenu(page, 'Remove worktree')
  const offer = page.getByRole('dialog', { name: 'PR #497 merged' })
  await offer.getByRole('button', { name: 'Remove worktree' }).click()
  await expect(refusal(offer, 'A turn is running', 'a turn or a revert is running')).toBeVisible()
  await fitsTheScreen(page, offer)
  await axe(page)
  await offer.getByRole('button', { name: 'Keep' }).click()
  await expect(offer).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`thread=${THREAD}`))
})

/** Y-495: the thread's PR checks and review comments from the watch, and Fix with agent. */
test('Checks lists each check and comment, and Fix with agent fills the composer without sending', async ({ page }) => {
  await scenario(page, 'checks')
  await page.goto(ATTACHED)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()

  await page.locator('.chat__header').getByRole('button', { name: 'Checks' }).click()
  const surface = page.getByRole('dialog', { name: 'Checks on PR #497' })
  await expect(surface.getByText('1 of 2 failing')).toBeVisible()
  const checks = surface.getByRole('list', { name: 'Checks' }).getByRole('listitem')
  await expect(checks).toHaveCount(2)
  await expect(checks.first()).toContainText('rust / test')
  await expect(checks.first()).toContainText('1 test failed')
  await expect(checks.last()).toContainText('web / lint')
  const comments = surface.getByRole('list', { name: 'Review comments' }).getByRole('listitem')
  await expect(comments.first()).toContainText('Please cover the 304 path.')
  await expect(comments.last()).toContainText('crates/yantrad/src/watch.rs:142')
  await expect(comments.last()).toContainText('This drops the etag on a new head.')
  await axe(page)

  const fix = surface.getByRole('button', { name: 'Fix with agent' })
  expect((await fix.boundingBox())!.height).toBeGreaterThanOrEqual(page.viewportSize()!.width < 600 ? 44 : 40)
  await fix.click()
  await expect(surface).toBeHidden()
  const composer = page.getByLabel('Message Claude in yantra-web', { exact: true })
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue(
    [
      'Fix PR #497:',
      'Check rust / test failed (failure).\n1 test failed\n`watch::tests::a_304_keeps_the_checks` panicked at watch.rs:212',
      'Review by reviewer (changes requested):\nPlease cover the 304 path.',
      '> crates/yantrad/src/watch.rs:L142\nThis drops the etag on a new head.',
    ].join('\n\n') + '\n', // appendToDraft leaves the caret on a fresh line
  )
  // Fix fills; the owner sends. The thread is still idle.
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled()
  await axe(page)
})
