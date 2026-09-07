import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'

/** `/new` (Y-349): the four steps of NewSession, NewSessionSource,
 *  NewSessionLocal, NewSessionStart and NewSessionCloning. The fixture's
 *  machine holds `2002Bishwajeet/yantra` under `~/Github` and not
 *  `2002Bishwajeet/scratch`, so one row is already there and one is a clone. */
const PATH = route('new').path

// The phone's app bar is a second h1 over the screen's own.
const heading = (page: Parameters<typeof axe>[0], name: string) =>
  page.getByRole('heading', { level: 1, name }).first()

test.describe('the four steps', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(heading(page, 'New session')).toBeVisible()
  })

  test('draws the board: a generated name, its tile, and the machine chips', async ({ page }) => {
    await expect(page.getByLabel('Name')).toHaveValue(/^[a-z]+-[a-z]+$/)
    const chips = page.getByRole('group', { name: 'Machine' })
    await expect(chips.getByRole('button', { name: 'cachyos-g14' })).toBeEnabled()
    await expect(chips.getByRole('button', { name: 'thinkpad · unreachable' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  test('passes axe on each step', async ({ page }) => {
    await axe(page)
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('already on cachyos-g14 at ~/Github/yantra')).toBeVisible()
    await axe(page)
    await page.getByRole('button', { name: /2002Bishwajeet\/yantra/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('What opens in the session')).toBeVisible()
    await axe(page)
  })

  test('walks by keyboard', async ({ page, size }) => {
    // The phone's walk starts inside the form at the Name field, and an M3
    // text field draws its focus ring on the box rather than on the input the
    // walk inspects (`m3/text-field/TextField.css`, `:focus-within`). The ring
    // is visible and axe passes; the helper reads the focused element only.
    test.skip(size === 'phone', 'the field rings its box, not its input')
    await keyboardWalk(page, 8)
  })

  test('looks like the board', async ({ page, size }) => {
    await page.getByLabel('Name').fill('quiet-otter')
    await screenshot(page, 'new-session-name', 'busy', size)
  })

  test('the source step joins the swept list to the machine, and search narrows it', async ({
    page,
    size,
  }) => {
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText('github.com · 2002Bishwajeet · signed in to Yantra', { exact: false })).toBeVisible()
    const rows = page.getByRole('list', { name: 'Repositories' })
    await expect(rows.getByText('already on cachyos-g14 at ~/Github/yantra')).toBeVisible()
    await expect(rows.getByText('not here yet · clone into ~/Github/scratch')).toBeVisible()
    await expect(page.getByRole('button', { name: /GitLab/ })).toBeDisabled()
    await screenshot(page, 'new-session-source', 'busy', size)

    await page.getByLabel('Search your repositories').fill('scratch')
    await expect(rows.getByRole('button', { name: /2002Bishwajeet\/yantra/ })).toHaveCount(0)
    await page.getByLabel('Search your repositories').fill('zzz')
    await expect(page.getByText('nothing matches zzz')).toBeVisible()
  })

  test('the local browser walks the machine and makes a folder', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'one size is enough for the wire')
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: /Local directory/ }).click()

    const folders = page.getByRole('list', { name: 'Folders' })
    await folders.getByRole('button', { name: /Github/ }).click()
    await expect(folders.getByText('git · 2002Bishwajeet/yantra')).toBeVisible()
    await screenshot(page, 'new-session-local', 'busy', size)

    await page.getByLabel('New folder').fill('landing-copy')
    await page.getByRole('button', { name: 'Make', exact: true }).click()
    await expect(page.getByText('~/Github/landing-copy')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })
})

test.describe('all four steps, to a workspace that is running', () => {
  test('a repository already on the machine is created and opened', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(heading(page, 'New session')).toBeVisible()

    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText('already on cachyos-g14 at ~/Github/yantra')).toBeVisible()
    await page.getByRole('button', { name: /2002Bishwajeet\/yantra/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText('What opens in the session')).toBeVisible()
    await expect(page.getByText('open a tmux session on cachyos-g14 in ~/Github/yantra', { exact: false })).toBeVisible()
    await screenshot(page, 'new-session-start', 'busy', size)
    await page.getByRole('button', { name: 'Create and open' }).click()

    const stages = page.getByRole('list', { name: 'Stages' })
    await expect(page.getByText('Starting quiet-otter')).toBeVisible()
    // Nothing to clone: the directory is already there.
    await expect(stages.getByText('not needed')).toBeVisible()
    await expect(page).toHaveURL('/w/quiet-otter?view=chat')
  })

  test('a repository that is not there is cloned, with its progress', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(heading(page, 'New session')).toBeVisible()

    await page.getByLabel('Name').fill('brisk-heron')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText('not here yet · clone into ~/Github/scratch')).toBeVisible()
    await page.getByRole('button', { name: /2002Bishwajeet\/scratch/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(
      page.getByText('clone 2002Bishwajeet/scratch into ~/Github/scratch on cachyos-g14'),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Create and open' }).click()

    const stages = page.getByRole('list', { name: 'Stages' })
    await expect(stages.getByText('Cloning 2002Bishwajeet/scratch', { exact: false })).toBeVisible()
    await expect(stages.getByText(/Receiving objects/)).toBeVisible()
    await screenshot(page, 'new-session-cloning', 'busy', size)
    await expect(page).toHaveURL('/w/brisk-heron?view=chat', { timeout: 15_000 })
  })
})
