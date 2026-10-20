import { axe, expect, scenario, test } from './lib/test'
import type { Page } from '@playwright/test'

/** The diff panel (Y-491, ADR-0034 decisions 6 and 7) on the fixture chat. The
 *  fixture answers a `diff` frame as chat.rs does, with a patch of four files:
 *  a rename, a binary file, and two edits in nested directories. The `difffails`
 *  scenario is git failing to read the branch. */
const NAME = 'yantra-web'
const THREAD = '1a2b3c4d'
const ATTACHED = `/w/${NAME}?thread=${THREAD}`
const WORKTREE = `/home/biswa/.yantra/worktrees/chat/${NAME}/${THREAD}`

const composer = (page: Page, size: string) =>
  page.getByLabel(size === 'phone' ? 'Message Claude' : `Message Claude in ${NAME}`, { exact: true })
const diffButton = (page: Page) => page.getByRole('button', { name: 'Diff', exact: true })
const branch = (page: Page) => page.getByRole('region', { name: 'Branch diff' })
const row = (page: Page, name: string) => branch(page).locator('.diff__tree').getByRole('treeitem', { name })
const file = (page: Page, path: string) => branch(page).locator(`[data-path="${path}"]`)

async function openBranch(page: Page, name: Parameters<typeof scenario>[1] = 'busy') {
  await scenario(page, name)
  await page.goto(ATTACHED)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  await diffButton(page).click()
}

test.describe('the branch diff', () => {
  test('lists the changed files, reveals one, and puts a line comment in the composer', async ({ page, size }) => {
    await openBranch(page)
    await expect(diffButton(page)).toHaveAttribute('aria-pressed', 'true')

    // Rename, binary and counts on the rows; nested folders in the paths.
    await expect(row(page, 'new.rs')).toContainText('renamed +3 −1')
    await expect(row(page, 'logo.png')).toContainText('binary')
    await expect(row(page, 'intro.md')).toContainText('+2 −0')
    await expect(row(page, 'app.ts')).toContainText('+1 −1')
    await expect(file(page, 'logo.png')).toContainText('A binary file has no lines to show.')
    await expect(file(page, 'src/new.rs')).toContainText('renamed from src/old.rs')

    await row(page, 'app.ts').click()
    await expect(file(page, 'web/src/app.ts')).toBeInViewport()

    // A line number is pressed; the box opens under it and takes focus.
    await file(page, 'src/new.rs').locator('[data-line-type="change-addition"][data-column-number="3"]').click()
    const box = page.getByRole('textbox', { name: 'Comment on src/new.rs L3' })
    await expect(box).toBeFocused()
    await axe(page)
    await box.fill('looks fine')
    await box.press('ControlOrMeta+Enter')

    await expect(box).toHaveCount(0)
    await expect(file(page, 'src/new.rs').getByRole('heading', { level: 3 })).toBeFocused()
    await expect(composer(page, size)).toHaveValue('> src/new.rs:L3\n> +    println!("hello {name}");\n\nlooks fine\n')
    // Nothing was sent: the chat shows no new turn.
    await expect(page.getByText('looks fine')).toHaveCount(0)
  })

  test('comments on a whole file from its button, and Escape cancels', async ({ page, size }) => {
    await openBranch(page)
    await file(page, 'logo.png').getByRole('button', { name: 'Comment on file: logo.png' }).click()
    const box = page.getByRole('textbox', { name: 'Comment on logo.png whole file' })
    await expect(box).toBeFocused()
    await box.press('Escape')
    await expect(box).toHaveCount(0)
    await expect(composer(page, size)).toHaveValue('')

    await file(page, 'logo.png').getByRole('button', { name: 'Comment on file: logo.png' }).click()
    await page.getByRole('textbox', { name: 'Comment on logo.png whole file' }).fill('too large')
    await page.getByRole('button', { name: 'Add to message' }).click()
    await expect(composer(page, size)).toHaveValue('> logo.png\n\ntoo large\n')
  })

  test('opens each file in VS Code, Cursor or Zed over ssh', async ({ page }) => {
    await openBranch(page)
    const ssh = 'cachyos-g14'
    await file(page, 'src/new.rs').getByRole('button', { name: 'Open in editor: src/new.rs' }).click()
    // The first hunk of the rename starts at line 1.
    await expect(page.getByRole('menuitem', { name: 'VS Code' })).toHaveAttribute(
      'href',
      `vscode://vscode-remote/ssh-remote+${ssh}${WORKTREE}/src/new.rs:1`,
    )
    await expect(page.getByRole('menuitem', { name: 'Cursor' })).toHaveAttribute(
      'href',
      `cursor://vscode-remote/ssh-remote+${ssh}${WORKTREE}/src/new.rs:1`,
    )
    await expect(page.getByRole('menuitem', { name: 'Zed' })).toHaveAttribute('href', `zed://ssh/${ssh}${WORKTREE}/src/new.rs`)
    await page.keyboard.press('Escape')

    await file(page, 'docs/guide/intro.md').getByRole('button', { name: 'Open in editor: docs/guide/intro.md' }).click()
    await expect(page.getByRole('menuitem', { name: 'Zed' })).toHaveAttribute(
      'href',
      `zed://ssh/${ssh}${WORKTREE}/docs/guide/intro.md`,
    )
  })

  test('closes with its button and gives focus back', async ({ page }) => {
    await openBranch(page)
    await expect(branch(page)).toBeVisible()
    await diffButton(page).click()
    await expect(branch(page)).toHaveCount(0)
    await expect(diffButton(page)).toBeFocused()
  })
})

test.describe('a turn’s diff', () => {
  test('opens in the same viewer, and keeps Revert', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto(`/w/${NAME}`)
    await composer(page, size).fill('run the core tests')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Claude finished.')

    const card = page.getByRole('article', { name: 'What turn 1 changed' })
    await card.getByRole('button', { name: /^Diff/ }).click()
    await expect(card.locator('.diff__tree').getByRole('treeitem', { name: 'a.txt' })).toContainText('+1 −1')
    await expect(card.locator('[data-path="a.txt"]')).toBeVisible()
    await expect(card.locator('pre')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Revert to before this turn' })).toBeVisible()
    await axe(page)
  })
})

test.describe('a diff that cannot be read', () => {
  test('says so in git’s words, offers Try again, and leaves the conversation alone', async ({ page }) => {
    await openBranch(page, 'difffails')
    const alert = page.getByRole('alert')
    await expect(alert).toHaveCount(1)
    await expect(alert).toContainText('The diff could not be read')
    await expect(alert).toContainText('fatal: bad revision HEAD')
    await axe(page)
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(alert).toContainText('The diff could not be read')
  })
})
