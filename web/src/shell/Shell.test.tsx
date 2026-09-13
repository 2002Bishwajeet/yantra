import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Readiness } from '@/api'
import { aMachine, looked } from '@/api/fixtures'
import * as contract from '@/contract.gen'
import { isRailed } from './destinations'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

const DESTINATIONS = ['Dashboard', 'Fleet', 'Machines', 'Usage']

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }))

/** The shell's FAB. A page may keep its own tonal copy of the same action, so
 *  a query by name alone would find two. */
const fab = () => document.querySelector<HTMLElement>('.shell__fab, .shell__rail-fab')
const named = (one: HTMLElement | null) => one?.textContent?.replace(/\s+/g, ' ').trim() ?? null

const empty = { body: looked.ok([]) }
const up = aMachine({ name: 'cachyos-g14', os: 'linux', online: true })
/** The seven checks a session needs (`lib/ready`), tmux among them. */
const SEVEN = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session']
const report = (absent: string[]): Readiness => ({
  machine: up.name,
  checks: SEVEN.map((check) => ({ check, state: absent.includes(check) ? 'absent' : 'present', detail: '' })),
})
/** No workspace, one Linux machine online, and the key made by its join. */
const firstRun = (absent: string[]) => ({
  '/api/workspaces': empty,
  '/api/machines': { body: looked.ok([up]) },
  '/api/readiness': { body: looked.ok([report(absent)]) },
  '/api/notifications': empty,
  '/api/ssh-identity': { body: contract.sshIdentity },
  '/api/machines/cachyos-g14/install': { status: 202, body: undefined },
})

describe('the desktop shell', () => {
  it('has the four destinations as pills, the open one current', async () => {
    mount('desktop', '/fleet')
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })
    for (const label of DESTINATIONS) expect(nav().getByRole('link', { name: label })).toBeTruthy()
    expect(nav().getByRole('link', { name: 'Fleet' }).getAttribute('aria-current')).toBe('page')
    expect(nav().getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBeNull()
    expect(document.querySelector('[data-shell]')?.getAttribute('data-shell')).toBe('desktop')
  })

  it('draws the sessions rail on / and /new and nowhere else', async () => {
    mount('desktop')
    const rail = await screen.findByRole('complementary', { name: 'Sessions' })
    expect(await within(rail).findByRole('link', { name: /api/ })).toBeTruthy()
    expect(within(rail).getByRole('region', { name: 'Live' })).toBeTruthy()
    expect(within(rail).getByRole('link', { name: 'All sessions →' }).getAttribute('href')).toBe('/fleet')

    fireEvent.click(nav().getByRole('link', { name: 'Machines' }))
    await screen.findByRole('heading', { level: 1, name: 'Machines' })
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'Yantra' }))
    expect(await screen.findByRole('complementary', { name: 'Sessions' })).toBeTruthy()
  })

  /** Finding 112: five session boards draw the rail beside the screen. That it
   *  is drawn there is the e2e's, which loads the session screen for it. */
  it('counts a session screen among the places the rail belongs', () => {
    for (const path of ['/', '/new', '/w/api']) expect(isRailed(path)).toBe(true)
    for (const path of ['/fleet', '/machines', '/settings', '/w/api/repair']) {
      expect(isRailed(path)).toBe(false)
    }
  })

  it('counts unseen events and GitHub items on the bell', async () => {
    mount('desktop')
    // Six events, none seen, plus one review and one issue.
    expect(await screen.findByRole('button', { name: /Notifications\s*8 unread/ })).toBeTruthy()
  })

  it('offers Settings and About from the avatar', async () => {
    mount('desktop')
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
    expect(within(menu).getByRole('menuitem', { name: 'About' }).getAttribute('href')).toBe('/settings/about')
  })

  it('says nothing is at a path nothing routes', async () => {
    mount('desktop', '/nope')
    expect(await screen.findByText(/Nothing is at/)).toBeTruthy()
  })
})

describe('the tablet shell', () => {
  /** Finding 129: TabletDashboard.dc.html puts the bell and the avatar at the
   *  foot of the rail and draws no search, so nothing of the chrome is left
   *  outside a landmark (finding 121). */
  it('has a rail with the FAB on top, the bell and the avatar at its foot, and no search', async () => {
    mount('tablet', '/fleet')
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })
    const rail = nav()
    for (const label of DESTINATIONS) expect(rail.getByRole('link', { name: label })).toBeTruthy()
    expect(rail.getByRole('link', { name: 'Fleet' }).getAttribute('aria-current')).toBe('page')
    expect(rail.getByRole('link', { name: 'New session, quick action' }).getAttribute('href')).toBe('/new')
    expect(document.querySelector('.m3-pill-group')).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Search anything/ })).toBeNull()
    expect(await rail.findByRole('button', { name: /Notifications/ })).toBeTruthy()
    expect(await rail.findByRole('button', { name: 'Account' })).toBeTruthy()
  })

  it('opens notifications as a side sheet the bell names', async () => {
    mount('tablet')
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
    const bell = await screen.findByRole('button', { name: /Notifications/ })
    // Finding 121: the sheet is in the tree from the first paint, so what the
    // bell says it controls is there to be found, open or closed.
    const named = () => document.getElementById(bell.getAttribute('aria-controls') ?? '')
    await waitFor(() => expect(named()?.getAttribute('aria-label')).toBe('Notifications'))
    expect(bell.getAttribute('aria-expanded')).toBe('false')
    expect(named()?.hidden).toBe(true)
    fireEvent.click(bell)
    expect(bell.getAttribute('aria-expanded')).toBe('true')
    const sheet = await screen.findByRole('complementary', { name: 'Notifications' })
    expect(sheet.hidden).toBe(false)
    expect(await within(sheet).findByText('api is waiting for trust')).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close Notifications' }))
    expect(sheet.hidden).toBe(true)
  })
})

describe('the phone shell', () => {
  it('has a bottom bar, a FAB, and the app bar as the heading', async () => {
    mount('phone', '/machines')
    await screen.findAllByRole('heading', { level: 1, name: 'Machines' })
    const bar = nav()
    for (const label of DESTINATIONS) expect(bar.getByRole('link', { name: label })).toBeTruthy()
    expect(bar.getByRole('link', { name: 'Machines' }).getAttribute('aria-current')).toBe('page')
    expect(fab()?.getAttribute('href')).toBe('/machines/add')
    expect(screen.getByRole('banner').querySelector('h1')?.textContent).toBe('Machines')
    expect(screen.getByRole('link', { name: /Notifications/ }).getAttribute('href')).toBe('/notifications')
  })

  it('pushes settings: a back arrow, no bar, no FAB', async () => {
    mount('phone', '/settings')
    await waitFor(() => expect(screen.getByRole('banner').querySelector('h1')?.textContent).toBe('Settings'))
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'New session' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(location.pathname).toBe('/'))
  })

  it('opens notifications as a pushed screen', async () => {
    mount('phone', '/notifications')
    await waitFor(() => expect(screen.getByRole('banner').querySelector('h1')?.textContent).toBe('Notifications'))
    expect(await screen.findByText('api is waiting for trust')).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
  })
})

/** D7 §3.6: the FAB carries the page's one next action, or is not drawn. */
describe('the FAB', () => {
  const ROUTES = [
    ['/', 'Dashboard', 'New session', '/new'],
    ['/fleet', 'Fleet', 'New session', '/new'],
    ['/machines', 'Machines', 'Add a device', '/machines/add'],
    ['/usage', 'Usage', null, null],
  ] as const

  for (const size of ['phone', 'tablet'] as const) {
    it.each(ROUTES)(`carries on the ${size} what %s offers next`, async (path, title, label, href) => {
      mount(size, path)
      await screen.findAllByRole('heading', { level: 1, name: title })
      if (label === null) {
        expect(fab()).toBeNull()
        return
      }
      await waitFor(() => expect(named(fab())).toBe(label))
      expect(fab()!.getAttribute('href')).toBe(href)
      // WCAG 2.5.3: the name starts with the words on screen, and differs
      // from the page's own copy of the action.
      expect(screen.getByRole('link', { name: `${label}, quick action` })).toBe(fab())
    })
  }

  /** The machine page's Readiness card holds its action; a FAB would repeat it. */
  it.each([
    ['/m/cachyos-g14', 'cachyos-g14'],
    ['/settings', 'Settings'],
    ['/new', 'New session'],
  ])('draws none on the tablet on %s', async (path, title) => {
    mount('tablet', path)
    await screen.findAllByRole('heading', { level: 1, name: title })
    expect(fab()).toBeNull()
    // The rail keeps the FAB's place, so the destinations never move.
    expect(document.querySelector('.shell__rail-slot')).toBeTruthy()
  })

  /** A swap under a keyboard reader keeps the element, so focus stays on it. */
  it('keeps focus on the FAB when the next route swaps its action', async () => {
    mount('phone', '/')
    await waitFor(() => expect(named(fab())).toBe('New session'))
    const before = fab()!
    before.focus()
    // fireEvent does not move focus, so the FAB keeps it through the navigation.
    fireEvent.click(nav().getByRole('link', { name: 'Machines' }))
    await waitFor(() => expect(named(fab())).toBe('Add a device'))
    expect(fab()).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it('draws none on the desktop, where the action stays in the page', async () => {
    mount('desktop', '/machines')
    await screen.findByRole('heading', { level: 1, name: 'Machines' })
    expect(fab()).toBeNull()
    expect(document.querySelector('.m3-fab')).toBeNull()
  })

  it('draws none while yantrad cannot be reached', async () => {
    mount('phone', '/', { down: true })
    expect((await screen.findAllByText(/yantrad/)).length).toBeGreaterThan(0)
    expect(fab()).toBeNull()
  })

  it('draws none on the dashboard when nothing it reads can be reached', async () => {
    const failed = { body: { looked: 'failed', age_seconds: 0, error: 'tailscale did not answer' } }
    mount('tablet', '/', { overrides: { '/api/machines': failed, '/api/workspaces': failed, '/api/sessions': failed } })
    expect(await screen.findByText('Nothing here can be reached')).toBeTruthy()
    expect(fab()).toBeNull()
  })

  describe('while the checklist is the page', () => {
    it('carries Install on the machine, and leaves the line its tonal copy', async () => {
      const asked = mount('phone', '/', { overrides: firstRun(['tmux']) })
      await waitFor(() => expect(named(fab())).toBe('Install on cachyos-g14'))
      expect(fab()!.tagName).toBe('BUTTON')
      const main = within(screen.getByRole('main'))
      expect(main.getByRole('button', { name: 'Install on cachyos-g14' }).dataset.variant).toBe('tonal')
      expect(screen.getByRole('main').querySelector('[data-variant="filled"]')).toBeNull()

      fab()!.focus()
      fireEvent.click(fab()!)
      await waitFor(() => expect(asked).toContain('POST /api/machines/cachyos-g14/install'))
      // The line's track says it is running; there is nothing left to press.
      expect(await screen.findByText('installing on cachyos-g14…')).toBeTruthy()
      await waitFor(() => expect(fab()).toBeNull())
      // Focus goes to the line that says what happened, not to the body.
      const said = document.activeElement as HTMLElement
      expect(said.hasAttribute('data-fab-return')).toBe(true)
      expect(within(said).getByText('installing on cachyos-g14…')).toBeTruthy()
    })

    it('carries Add a device before any machine has joined', async () => {
      mount('tablet', '/', { overrides: { '/api/workspaces': empty } })
      await waitFor(() => expect(named(fab())).toBe('Add a device'))
      expect(fab()!.getAttribute('href')).toBe('/machines/add')
      const add = within(screen.getByRole('main')).getByRole('link', { name: 'Add a device' })
      expect(add.dataset.variant).toBe('tonal')
    })

    it('carries New session once a machine is ready and nothing else is left', async () => {
      // Ready and keyed, yet no workspace: the gate has passed, so `/` is the
      // board, whose own action is New session.
      // An empty GitHub queue, so the hero is empty and draws its own copy.
      const quiet = { ...contract.attention, data: { ...contract.attention.data, reviews: [], issues: [], notifications: 0 } }
      mount('phone', '/', { overrides: { ...firstRun([]), '/api/attention': { body: quiet } } })
      await screen.findAllByRole('heading', { level: 1, name: 'Dashboard' })
      await waitFor(() => expect(named(fab())).toBe('New session'))
      const hero = within(screen.getByRole('region', { name: 'Needs you' }))
      expect(hero.getByRole('link', { name: 'New session' }).dataset.variant).toBe('tonal')
    })

    /** D7 S11: on the desktop, the action is inline and filled, and the rail
     *  that would only say nothing has been read is not drawn. */
    it('keeps the action in the page on the desktop, and hides the sessions rail', async () => {
      mount('desktop', '/', { overrides: firstRun(['tmux']) })
      await screen.findByRole('heading', { level: 1, name: 'Set up Yantra' })
      const main = within(screen.getByRole('main'))
      await waitFor(() =>
        expect(main.getByRole('button', { name: 'Install on cachyos-g14' }).dataset.variant).toBe('filled'),
      )
      expect(fab()).toBeNull()
      expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()

      // The rail belongs to New session all the same.
      fireEvent.click(main.getByRole('link', { name: 'New session' }))
      expect(await screen.findByRole('complementary', { name: 'Sessions' })).toBeTruthy()
    })
  })
})
