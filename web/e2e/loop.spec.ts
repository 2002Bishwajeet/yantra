import { axe, expect, scenario, test } from './lib/test'
import { route } from './lib/routes'
import type { Page } from '@playwright/test'

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
  await expect(threads.getByRole('menuitem').and(page.locator('a'))).toHaveCount(5)
  await expect(threads.locator('a[aria-current]')).toHaveCount(1)
  for (const mark of ['no PR', 'PR #512 open', 'PR #511 closed', 'PR #510 merged', 'PR unknown']) {
    await expect(threads.getByText(mark)).toBeVisible()
  }
  await expect(threads.getByText('2002Bishwajeet/yantra#488')).toBeVisible()
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
