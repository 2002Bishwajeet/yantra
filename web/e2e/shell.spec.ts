import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/** The shell (Y-345): the four destinations at three widths, the palette,
 *  the bell, on the busy fleet. The screens under it are stubs until their
 *  rows land; this spec asks nothing of them but their heading. */
const DESTINATIONS = [
  ['Dashboard', '/'],
  ['Fleet', '/fleet'],
  ['Machines', '/machines'],
  ['Usage', '/usage'],
] as const

// The phone's app bar is a second h1 over the screen's hidden one.
const heading = (page: Parameters<typeof axe>[0], name: string) =>
  page.getByRole('heading', { level: 1, name }).first()

test.describe('the shell on busy', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto('/')
    await expect(heading(page, 'Dashboard')).toBeVisible()
  })

  test('reaches every destination, and says which is open', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' })
    for (const [label, path] of DESTINATIONS) {
      await nav.getByRole('link', { name: label }).click()
      await expect(page).toHaveURL(path)
      await expect(heading(page, label)).toBeVisible()
      await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page')
    }
  })

  test('passes axe', async ({ page }) => {
    await axe(page)
  })

  test('walks by keyboard', async ({ page }) => {
    await keyboardWalk(page, 8)
  })

  test('looks like the board', async ({ page, size }) => {
    // The rail's ages arrive with the sessions read, after the heading.
    if (size === 'desktop') {
      await expect(page.getByRole('complementary', { name: 'Sessions' }).getByText('39m')).toBeVisible()
    }
    await screenshot(page, 'shell', 'busy', size)
  })

  test('opens the palette with ⌘K, finds landing, and never runs a verb', async ({ page, size }) => {
    test.skip(size === 'phone', 'the phone boards draw no search; the fleet lists everything')
    await page.keyboard.press('ControlOrMeta+k')
    const dialog = page.getByRole('dialog', { name: 'Search' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox').fill('lan')
    await expect(dialog.getByRole('option', { name: /^landing running/ })).toBeVisible()
    await expect(dialog.getByText('Never runs a verb.')).toBeVisible()
    await screenshot(page, 'shell-palette', 'busy', size)

    const verbs: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/') && request.method() !== 'GET' && !request.url().endsWith('/api/viewing')) {
        verbs.push(`${request.method()} ${request.url()}`)
      }
    })
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/w/landing?view=chat')
    await expect(heading(page, 'landing')).toBeVisible()
    expect(verbs).toEqual([])
  })

  test('opens notifications, and Mark all read empties Unread', async ({ page, size }) => {
    const bell = page.getByRole(size === 'phone' ? 'link' : 'button', { name: /^Notifications/ })
    await expect(bell).toHaveAccessibleName(/unread/)
    await bell.click()
    const list =
      size === 'desktop'
        ? page.getByRole('dialog', { name: 'Notifications' })
        : size === 'tablet'
          ? page.getByRole('complementary', { name: 'Notifications' })
          : page.getByRole('main')
    if (size === 'phone') await expect(page).toHaveURL('/notifications')
    await expect(list.getByText('yantra-web is waiting for trust')).toBeVisible()
    await expect(list.getByRole('link', { name: 'Answer' })).toHaveAttribute('href', '/w/yantra-web?view=chat')
    await expect(list.getByRole('heading', { name: 'Today' })).toBeVisible()
    await expect(list.getByRole('heading', { name: 'Earlier' })).toBeVisible()
    await screenshot(page, 'shell-notifications', 'busy', size)
    await axe(page)

    await list.getByRole('button', { name: 'Mark all read' }).click()
    await expect(list.getByText('Nothing unread.')).toBeVisible()
    await list.getByRole('button', { name: 'All', exact: true }).click()
    await expect(list.getByText('yantra-web is waiting for trust')).toBeVisible()
  })
})
