import { at, axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'
import { scrollHeight } from './lib/scroller'

/** `/new` (Y-349): the four steps of NewSession, NewSessionSource,
 *  NewSessionLocal, NewSessionStart and NewSessionCloning. The fixture's
 *  machine holds `2002Bishwajeet/yantra` under `~/Github` and not
 *  `2002Bishwajeet/scratch`, so one row is already there and one is a clone. */
const PATH = route('new').path

// The phone's app bar is a second h1 over the screen's own; wider screens draw a dialog.
const heading = (page: Parameters<typeof axe>[0], name: string) =>
  page
    .getByRole('dialog', { name })
    .or(page.getByRole('heading', { level: 1, name }))
    .first()

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
    // Y-517: the daemon's top machine is preselected, with the reason.
    await expect(chips.getByRole('button', { name: 'cachyos-g14' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('status').filter({ hasText: 'Suggested' })).toHaveText(
      'Suggested: cachyos-g14',
    )
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  /** Y-517: a repository another machine holds is offered there, and the
   *  switch keeps the repository at the path that machine has it. */
  test('the source step offers the machine that holds the repo', async ({ page }) => {
    await page.getByLabel('Name').fill('brisk-heron')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Will clone')).toBeVisible()
    await page.getByRole('button', { name: /2002Bishwajeet\/scratch/ }).click()

    await expect(page.getByText('hetzner-1: the repo is there and it is on AC power')).toBeVisible()
    await page.getByRole('button', { name: 'Use hetzner-1' }).click()
    await expect(page.getByRole('button', { name: 'Use hetzner-1' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('on hetzner-1 · ~/Github/scratch', { exact: false }).first()).toBeVisible()
  })

  test('passes axe on each step', async ({ page }) => {
    // Y-517: the suggestion enables Continue after load; axe must not sample its colour transition.
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
    await axe(page)
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('On this machine')).toBeVisible()
    await axe(page)
    await page.getByRole('button', { name: /2002Bishwajeet\/yantra/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('What opens in the session')).toBeVisible()
    await axe(page)
  })

  test('walks by keyboard', async ({ page }) => {
    await keyboardWalk(page, 8)
  })

  test('one step per screen', async ({ page }) => {
    const steps = page.getByRole('list', { name: 'Steps' }).getByRole('listitem')
    await expect(steps).toHaveText(['1Name', '2Source', '3Start'])
    await expect(steps.first()).toHaveAttribute('aria-current', 'step')

    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('On this machine')).toBeVisible()
    await expect(steps.first()).toHaveAttribute('data-state', 'done')
    await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step')
  })

  test('looks like the board', async ({ page, size }) => {
    await page.getByLabel('Name').fill('quiet-otter')
    await screenshot(page, 'new-session-name', 'busy', size, { overlay: size !== 'phone' })
  })

  test('the source step joins the swept list to the machine, and search narrows it', async ({
    page,
    size,
  }) => {
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    const account = page.getByRole('button', { name: 'GitHub account: 2002Bishwajeet' })
    await expect(account).toBeVisible()
    expect((await account.boundingBox())!.height).toBeGreaterThanOrEqual(48)
    const rows = page.getByRole('list', { name: 'Repositories' })
    await expect(rows.getByText('On this machine')).toBeVisible()
    await expect(rows.getByText('Will clone')).toBeVisible()
    await expect(page.getByRole('radio', { name: /GitLab/ })).toHaveCount(0)
    await expect(page.getByRole('radio')).toHaveText(['GitHub', 'Local directory'])
    await screenshot(page, 'new-session-source', 'busy', size, { overlay: size !== 'phone' })

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
    await page.getByRole('radio', { name: /Local directory/ }).click()

    const folders = page.getByRole('list', { name: 'Folders' })
    // Y-643: opening the step chooses nothing; a walk does.
    await expect(folders.getByRole('button', { name: /^Github/ })).toBeVisible()
    await expect(page.locator('.ns__chosen')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await folders.getByRole('button', { name: /^Github/ }).click()
    await expect(folders.getByText('git · 2002Bishwajeet/yantra')).toBeVisible()
    // Y-414: a closed folder is drawn and is not a button. Y-643: a file is not drawn at all.
    await expect(folders.getByText('README.md')).toHaveCount(0)
    await expect(folders.getByRole('button', { name: /^archive/ })).toHaveCount(0)
    await expect(folders.getByText('.github')).toHaveCount(0)
    await screenshot(page, 'new-session-local', 'busy', size, { overlay: size !== 'phone' })

    await page.getByRole('button', { name: 'Show hidden' }).click()
    await expect(folders.getByText('.github')).toBeVisible()
    await page.getByRole('button', { name: 'Show hidden' }).click()

    const where = page.getByRole('navigation', { name: 'Where you are' })
    await where.getByRole('button', { name: '/', exact: true }).click()
    await expect(folders.getByRole('button', { name: /^srv/ })).toBeVisible()
    await folders.getByRole('button', { name: /^home/ }).click()
    await folders.getByRole('button', { name: /^biswa/ }).click()
    await folders.getByRole('button', { name: /^Github/ }).click()
    await expect(folders.getByText('git · 2002Bishwajeet/yantra')).toBeVisible()

    await page.getByLabel('New folder').fill('landing-copy')
    await page.getByRole('button', { name: 'Make', exact: true }).click()
    await expect(page.getByText('~/Github/landing-copy', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  /** Y-516: a path bar, a filter, arrow keys, repositories first, and a start
   *  at the last folder used, kept in `yantra.prefs` general.lastFolders. */
  test('the local picker browses like a file browser', async ({ page }) => {
    const toLocal = async (name: string) => {
      await page.getByLabel('Name').fill(name)
      await page.getByRole('button', { name: 'cachyos-g14' }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('radio', { name: /Local directory/ }).click()
    }
    const crumb = page.getByRole('navigation', { name: 'Where you are' }).locator('[aria-current="location"]')
    const folders = page.getByRole('list', { name: 'Folders' })
    const names = folders.locator('[data-row] .m3-row__headline')
    await toLocal('quiet-otter')
    await expect(crumb).toHaveText('~')

    await page.getByRole('button', { name: 'Edit path' }).click()
    await page.getByLabel('Path', { exact: true }).fill('/home/biswa/Github')
    await page.getByLabel('Path', { exact: true }).press('Enter')
    await expect(crumb).toHaveText('Github')
    await expect(page.getByRole('button', { name: 'Edit path' })).toBeFocused()
    await expect(names).toHaveText(['landing', 'yantra', 'notes'])
    await axe(page)
    await keyboardWalk(page, 12)

    const filter = page.getByLabel('Filter, or type a path')
    await filter.fill('LAN')
    await expect(names).toHaveText(['landing'])
    await filter.fill('zzz')
    await expect(page.getByText('nothing in ~/Github matches zzz')).toBeVisible()
    await filter.fill('')
    await expect(names).toHaveText(['landing', 'yantra', 'notes'])

    await filter.press('ArrowDown')
    await expect(folders.getByRole('button', { name: /^landing/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(folders.getByRole('button', { name: /^yantra/ })).toBeFocused()
    await page.keyboard.press('End')
    await expect(folders.getByRole('button', { name: /^notes/ })).toBeFocused()
    await page.keyboard.press('Home')
    await expect(folders.getByRole('button', { name: /^landing/ })).toBeFocused()

    await page.getByRole('button', { name: 'Show hidden' }).click()
    await filter.fill('git')
    await expect(names).toHaveText(['.github'])
    await filter.fill('')
    await page.getByRole('button', { name: 'Show hidden' }).click()

    await filter.press('ArrowDown')
    await page.keyboard.press('Backspace')
    await expect(crumb).toHaveText('~')
    await expect(folders.getByRole('button', { name: /^Github/ })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('button', { name: 'Show folders in Github' })).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('button', { name: 'Show folders in Github' })).toHaveAttribute('aria-expanded', 'false')

    await page.keyboard.press('Enter')
    await expect(crumb).toHaveText('Github')
    await expect(folders.getByRole('button', { name: /^landing/ })).toBeFocused()
    await folders.getByRole('button', { name: /^yantra/ }).click()
    await expect(crumb).toHaveText('yantra')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Create and open' }).click()
    await expect(page).toHaveURL('/w/quiet-otter?view=chat')

    await page.goto(PATH)
    await expect(heading(page, 'New session')).toBeVisible()
    await toLocal('brisk-heron')
    await expect(crumb).toHaveText('yantra')
    const recent = page.getByRole('region', { name: 'Recent on cachyos-g14' })
    await expect(recent.getByRole('button', { name: '~/Github/yantra' })).toBeVisible()
  })

  /** Y-643: `~` is understood, and nothing is chosen until the person walks. */
  test('a path typed with ~ into the filter walks there and chooses it', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'one size is enough for the wire')
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('radio', { name: /Local directory/ }).click()

    await expect(page.locator('.ns__chosen')).toHaveCount(0)
    const filter = page.getByLabel('Filter, or type a path')
    await filter.fill('~/Github/yantra')
    await expect(page.getByText('Enter goes to this path')).toBeVisible()
    await filter.press('Enter')
    await expect(page.locator('.ns__chosen')).toContainText('~/Github/yantra')
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
    await expect(page.getByText('README.md')).toHaveCount(0)
  })

  test('Use picks the folder the step opened at', async ({ page }) => {
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('radio', { name: /Local directory/ }).click()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await page.getByRole('button', { name: 'Use ~', exact: true }).click()
    await expect(page.locator('.ns__chosen')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  /** Y-484: kept in `yantra.prefs` general.cloneFolders, per machine. */
  test('the clone folder survives a reload', async ({ page }) => {
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    const line = page.locator('.ns__clone', { hasText: 'Clone folder:' })
    await expect(line).toContainText('~/Github')

    await line.getByRole('button', { name: 'Change' }).click()
    const where = page.getByRole('navigation', { name: 'Where you are' })
    await where.getByRole('button', { name: '~', exact: true }).click()
    await page
      .getByRole('list', { name: 'Clone folder choices' })
      .getByRole('button', { name: /^notes/ })
      .click()
    await page.getByRole('button', { name: 'Use ~/notes' }).click()
    await expect(line).toContainText('~/notes')

    await page.reload()
    await expect(heading(page, 'New session')).toBeVisible()
    // The reload keeps ?step=2, and the generated name with the suggested machine (Y-517) completes step 1.
    await expect(line).toContainText('~/notes')
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

    await expect(page.getByText('On this machine')).toBeVisible()
    await page.getByRole('button', { name: /2002Bishwajeet\/yantra/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText('What opens in the session')).toBeVisible()
    await expect(page.getByText('on cachyos-g14 · ~/Github/yantra', { exact: false }).first()).toBeVisible()
    await screenshot(page, 'new-session-start', 'busy', size, { overlay: size !== 'phone' })
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

    await expect(page.getByText('Will clone')).toBeVisible()
    await page.getByRole('button', { name: /2002Bishwajeet\/scratch/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText('Clones 2002Bishwajeet/scratch first.')).toBeVisible()
    await page.getByRole('button', { name: 'Create and open' }).click()

    const stages = page.getByRole('list', { name: 'Stages' })
    await expect(stages.getByText('Cloning 2002Bishwajeet/scratch', { exact: false })).toBeVisible()
    await expect(stages.getByText(/Receiving objects/)).toBeVisible()
    await screenshot(page, 'new-session-cloning', 'busy', size, { overlay: size !== 'phone' })
    await expect(page).toHaveURL('/w/brisk-heron?view=chat', { timeout: 15_000 })
  })
})

test.describe('a long repository name on a phone', () => {
  test('clips to one line, shows one state, and keeps the hint in view', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the clipping was seen at 390 px')
    await scenario(page, 'longrepo')
    await page.goto(PATH)
    await expect(heading(page, 'New session')).toBeVisible()
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    const rows = page.getByRole('list', { name: 'Repositories' })
    const long = rows.getByRole('button', { name: /infrastructure-deployment-configuration/ })
    await expect(long.getByText('Will clone')).toBeVisible()
    await expect(long.locator('.ns__state')).toHaveCount(1)
    await expect(page.getByRole('status')).toHaveText('Choose a repository to continue.')
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()

    const headline = long.locator('.m3-row__headline')
    const read = await headline.evaluate((node) => {
      const css = getComputedStyle(node)
      return {
        height: node.getBoundingClientRect().height,
        line: parseFloat(css.lineHeight),
        overflow: css.textOverflow,
        wrap: css.overflowWrap,
        clipped: node.scrollWidth > node.clientWidth,
      }
    })
    expect(read.height).toBeLessThanOrEqual(read.line + 1)
    expect(read.overflow).toBe('ellipsis')
    expect(read.wrap).not.toBe('anywhere')
    expect(read.clipped).toBe(true)
    const box = await long.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)

    await long.click()
    await expect(long).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('status')).toHaveText(
      /^Will clone into ~\/Github\/infrastructure-deployment-configuration-for-the-staging-cluster$/,
    )
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
    await screenshot(page, 'new-session-source', 'longrepo', 'phone')
    await axe(page)
  })
})

test.describe('the steps fit a phone (Y-719)', () => {
  test.use(at('phone'))

  test('steps 1, 2 and 3 hold no paragraph over one line, and Continue is in view', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(heading(page, 'New session')).toBeVisible()

    const check = async (action: 'Continue' | 'Create and open') => {
      const tall = await page.locator('.ns p').evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getBoundingClientRect().height > 0)
          .filter((node) => node.getBoundingClientRect().height > 1.5 * parseFloat(getComputedStyle(node).lineHeight))
          .map((node) => node.textContent),
      )
      expect(tall).toEqual([])
      const button = await page.getByRole('button', { name: action }).boundingBox()
      expect(button).not.toBeNull()
      // The phone shell scrolls .shell__main, so the page fits when it does not scroll or its foot stays in view.
      expect((await scrollHeight(page)) <= 844 || button!.y + button!.height <= 844).toBe(true)
    }

    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await check('Continue')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('On this machine')).toBeVisible()
    await check('Continue')
    await page.getByRole('button', { name: /2002Bishwajeet\/yantra/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('What opens in the session')).toBeVisible()
    await check('Create and open')
  })
})

test.describe('the local step on a phone (Y-643)', () => {
  test.use(at('phone'))

  test('scrolls a long folder inside a fixed height and hides the keyboard help', async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(heading(page, 'New session')).toBeVisible()
    await page.getByLabel('Name').fill('quiet-otter')
    await page.getByRole('button', { name: 'cachyos-g14' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('radio', { name: /Local directory/ }).click()

    const folders = page.getByRole('list', { name: 'Folders' })
    await expect(folders).not.toHaveAttribute('aria-describedby')
    await page.getByRole('button', { name: 'Edit path' }).click()
    await expect(page.getByText(/Escape goes back/)).toHaveCount(0)
    await page.getByLabel('Path', { exact: true }).fill('/srv')
    await page.getByLabel('Path', { exact: true }).press('Enter')
    await expect(folders.getByRole('button', { name: /^site-59/ })).toBeAttached()

    const box = await folders.boundingBox()
    const viewport = page.viewportSize()
    expect(box?.height).toBeLessThanOrEqual((viewport?.height ?? 0) * 0.55 + 1)
    const scroll = await folders.evaluate((list) => ({ inner: list.scrollHeight, outer: list.clientHeight }))
    expect(scroll.inner).toBeGreaterThan(scroll.outer)
    const height = await scrollHeight(page)
    expect(height).toBeLessThan(5000)
    await axe(page)
  })
})
