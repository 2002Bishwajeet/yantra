import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Machine, Readiness } from '@/api'
import { aListed, aMachine, looked } from '@/api/fixtures'
import * as contract from '@/contract.gen'
import { readPrefs, writePrefs } from '@/shell/prefs'
import { mount, scenario, unmount, type Scenario } from '@/screens/fleet/harness'

/* The e2e fixture's own instant, so an age here reads as it does in a
   screenshot (`e2e/lib/scenario.ts`). Only Date is faked: React Testing
   Library's waits run on the real timers. */
const NOW = Date.parse('2026-09-06T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  writePrefs({ density: 'clean', general: {} })
  cleanup()
  unmount()
})

const region = (name: string) => within(screen.getByRole('region', { name }))
const drawn = () => screen.findByText(/^as of /)
/** A line the boards write as one sentence and the page builds from several
 *  spans, which `getByText` reads a piece at a time. */
const reads = (name: string) => screen.getByRole('region', { name }).textContent ?? ''

describe('the Dashboard on a busy fleet', () => {
  it('draws the status strip over the oldest read, and names who is not answering', async () => {
    mount('desktop', '/')
    await drawn()
    expect(screen.getByText(/5 of 6/).textContent).toBe('5 of 6 machines online')
    // D7 §3.3: a machine the tailnet sees off is asleep, and Open replaces Fix.
    expect(screen.getByText(/thinkpad asleep/)).toBeTruthy()
    const open = screen.getAllByRole('link').find((one) => one.getAttribute('href') === '/m/thinkpad')
    expect(open?.textContent).toMatch(/^Open/)
  })

  it('counts the hero over the workspaces that wait and the GitHub queue', async () => {
    mount('desktop', '/')
    await drawn()
    const hero = region('Needs you')
    // Two workspaces waiting, two reviews and two issues; the unreachable
    // machine is the strip's fact and not a thing waiting on the owner.
    expect(hero.getByText('6')).toBeTruthy()
    expect(hero.getByText('things are waiting on you')).toBeTruthy()
    expect(hero.getByText('yantra-web is waiting for trust')).toBeTruthy()
    expect(reads('Needs you')).toContain('asked 4m ago · Claude wants cargo test')
    expect(hero.getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe('/w/yantra-web?view=chat')
    expect(hero.getByText('price-table crashed')).toBeTruthy()
    expect(hero.getByText(/Review requested: yantra#245/)).toBeTruthy()
    expect(hero.getByText(/Issue assigned: yantra#118/)).toBeTruthy()
    expect(hero.queryByText(/cargo-zig/)).toBeNull()
  })

  it('moves the hero count when a band changes, while the row stays held', async () => {
    const state = scenario('busy')
    mount('desktop', '/', state)
    await drawn()
    expect(region('Needs you').getByText('6')).toBeTruthy()
    // A new object, because the query cache shares structure with the old one.
    const was = state.status.landing!.data as { status: object }
    state.status.landing = {
      looked: 'ok',
      age_seconds: 0,
      data: { ...was, status: { state: 'awaiting_trust' } },
    } as never
    // The next status poll reads the new band: the hero counts it at once and the row waits for Reorder.
    await screen.findByRole('button', { name: /1 changed/ }, { timeout: 9000 })
    expect(region('Needs you').getByText('7')).toBeTruthy()
    expect(region('Needs you').queryByText('landing is waiting for trust')).toBeNull()
  }, 15_000)

  /** Ledger row 142: the row wrote `ago` behind a helper that names the day
   *  past 24 h, so an old ask read `asked 30 Aug ago`. */
  it('names the proxy when the notifications read is refused for the own address', async () => {
    const state = scenario('busy')
    state.refuseReads = {
      '/api/notifications': {
        status: 403,
        text: "a request from this machine's own address may not act, because any account here could have sent it.",
      },
    }
    writePrefs({ density: 'compact' })
    mount('desktop', '/', state)
    expect(await screen.findByRole('heading', { name: 'The proxy hides who is calling' }, { timeout: 2000 })).toBeTruthy()
    expect(screen.queryByText(/not on a node/)).toBeNull()
  })

  it('drops `ago` from an ask that has become a date', async () => {
    const state = scenario('busy')
    const events = state.notifications!.data as { at: number; kind: string; workspace: string | null }[]
    events.find((one) => one.kind === 'awaiting_trust' && one.workspace === 'yantra-web')!.at =
      NOW / 1000 - 7 * 86_400
    mount('desktop', '/', state)
    await drawn()
    expect(reads('Needs you')).toMatch(/asked \d{1,2} \w{3} · Claude wants cargo test/)
  })

  it('gives every running row its elapsed time, a track against the longest, and Open', async () => {
    mount('desktop', '/')
    await drawn()
    const running = region('Running')
    expect(reads('Running')).toContain('3 sessions · longest 4h 11m')
    expect(running.getAllByRole('link', { name: 'Open' })).toHaveLength(3)
    const bars = running.getAllByRole('progressbar')
    expect(bars).toHaveLength(3)
    expect(running.getByText('39m')).toBeTruthy()
    // homelab-k8s has run longest, so its bar is the full one.
    expect(bars[0]!.getAttribute('aria-valuenow')).toBe('100')
    expect(bars[0]!.getAttribute('aria-label')).toBe('elapsed, 4h 11m of the longest 4h 11m')
  })

  it('offers Attach and Kill on an unclaimed session, and never Adopt', async () => {
    mount('desktop', '/')
    await drawn()
    const worth = region('Worth a look')
    expect(reads('Worth a look')).toContain('2 sessions no workspace claims')
    expect(worth.getByText('scratch')).toBeTruthy()
    expect(worth.getByText('mux')).toBeTruthy()
    expect(worth.queryByRole('button', { name: 'Adopt' })).toBeNull()
    expect(worth.getAllByRole('link', { name: 'Attach' })[0]!.getAttribute('href')).toBe(
      '/m/cachyos-g14/s/scratch',
    )
  })

  it('keeps a digit-named session listed with Attach but draws no Kill for it', async () => {
    const state = scenario('busy')
    const held = (state.sessions!.data as { machine: string; sessions: object[] }[])[0]!
    held.sessions.push({ name: '0', windows: 1, attached: 0, created: 'Fri Sep  4 18:40:55 2026', created_at: 1788547255 })
    mount('desktop', '/', state)
    await drawn()
    const item = (name: string) => screen.getByText(name, { selector: '.m3-row__headline' }).closest('li')!
    expect(within(item('0')).getByRole('link', { name: 'Attach' })).toBeTruthy()
    expect(within(item('0')).queryByRole('button', { name: 'Kill' })).toBeNull()
    // Attach is the last control in every row, so the buttons share one column.
    const last = (name: string) => item(name).querySelector('.m3-row')!.lastElementChild!
    expect(last('0').textContent).toBe('Attach')
    await waitFor(() => expect(last('scratch').textContent).toBe('Attach'))
    await waitFor(() => expect(within(item('scratch')).getByRole('button', { name: 'Kill' })).toBeTruthy())
  })

  it('does not count a machine as online while it is not answering', async () => {
    const state = scenario('busy')
    const was = state.status.landing!.data as object
    state.status.landing = { looked: 'ok', age_seconds: 0, data: { ...was, reached: 'no', status: null, error: 'ssh timed out' } } as never
    mount('desktop', '/', state)
    await drawn()
    expect(screen.getByText(/of 6/).textContent).toBe('4 of 6 machines online')
    expect(screen.getByText(/macbook not answering/)).toBeTruthy()
  })

  it('asks before Kill, because a killed session cannot be brought back', async () => {
    const asked = mount('desktop', '/')
    await drawn()
    // The confirm arrives in its own chunk, and its button is not askable
    // until it does — a fresh node each time, so it is looked up again.
    const kill = () => region('Worth a look').getAllByRole('button', { name: 'Kill' })[0]!
    await waitFor(() => expect(kill().hasAttribute('disabled')).toBe(false))
    fireEvent.click(kill())
    const dialog = within(await screen.findByRole('dialog'))
    // The question repeats the row word for word (BRIEF.md).
    expect(dialog.getByText('scratch')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Kill' }))
    await waitFor(() =>
      expect(asked).toContain('DELETE /api/machines/cachyos-g14/sessions/scratch'),
    )
  })

  it('folds Idle behind a disclosure that names the first three', async () => {
    mount('desktop', '/')
    await drawn()
    expect(screen.getByText(/4 workspaces, nothing running/)).toBeTruthy()
    expect(screen.getByText(/ntfy-relay, docs-sweep, appliance and 1 more/)).toBeTruthy()
    const show = screen.getByRole('button', { name: /Show/ })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(show)
    expect(show.getAttribute('aria-expanded')).toBe('true')
    const panel = within(document.getElementById(show.getAttribute('aria-controls')!)!)
    expect(panel.getAllByRole('link')).toHaveLength(4)
    expect(panel.getByRole('link', { name: /docs-sweep/ })).toBeTruthy()
  })
})

describe('the Dashboard in Compact', () => {
  it('opens Idle as a grid and puts the last five events beside it', async () => {
    writePrefs({ density: 'compact' })
    mount('desktop', '/')
    await drawn()
    const idle = region('Idle')
    expect(idle.getByRole('link', { name: /docs-sweep/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull()
    // Two of the five events in the buffer name no workspace, so three remain.
    expect(reads('Recent')).toContain('last 3 session events')
    expect(reads('Recent')).toContain('asked for trust · cachyos-g14')
    expect(region('Recent').queryByText(/relay test/)).toBeNull()
    expect(idle.queryByRole('link', { name: 'New session' })).toBeNull()
  })
})

describe('the Dashboard on a phone', () => {
  it('makes the whole running row the link and drops the Open button', async () => {
    mount('phone', '/')
    await drawn()
    const running = region('Running')
    expect(running.queryByRole('link', { name: 'Open' })).toBeNull()
    expect(running.getByRole('link', { name: /landing/ }).getAttribute('href')).toBe(
      '/w/landing?view=chat',
    )
  })

  it('stamps the page header, which keeps one row of stamp and actions', async () => {
    mount('phone', '/')
    await drawn()
    const stamp = screen.getByText(/^as of /)
    expect(stamp.closest('.m3-page-header__stamp')).toBeTruthy()
  })
})

describe('the Dashboard keeps one style per kind of action', () => {
  it('draws Worth a look as a region with a heading, a list and a row per unclaimed session', async () => {
    mount('desktop', '/')
    await drawn()
    const worth = region('Worth a look')
    expect(worth.getByRole('heading', { level: 2, name: 'Worth a look' })).toBeTruthy()
    const list = worth.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByText('scratch').closest('.m3-row')).toBeTruthy()
  })

  it('answers tonally, goes to a thing as text, and destroys in the error tone', async () => {
    mount('desktop', '/')
    await drawn()
    await waitFor(() => expect(region('Worth a look').getAllByRole('button', { name: 'Kill' })[0]!.hasAttribute('disabled')).toBe(false))
    const hero = region('Needs you')
    expect(hero.getByRole('link', { name: 'Answer' }).getAttribute('data-variant')).toBe('tonal')
    for (const one of hero.getAllByRole('link', { name: 'Review' })) expect(one.getAttribute('data-variant')).toBe('tonal')
    const goes = [
      ...screen.getAllByRole('link', { name: 'Open' }),
      ...screen.getAllByRole('link', { name: 'Attach' }),
    ].filter((one) => one.classList.contains('m3-button'))
    expect(goes.length).toBeGreaterThan(4)
    for (const one of goes) expect(one.getAttribute('data-variant')).toBe('text')
    for (const one of screen.getAllByRole('button', { name: 'Kill' })) expect(one.getAttribute('data-tone')).toBe('error')
  })

  it('keeps every age, elapsed time and since value on one line', async () => {
    mount('desktop', '/')
    await drawn()
    const when = (text: RegExp | string, within_: HTMLElement = document.body) =>
      within(within_).getAllByText(text).filter((one) => one.classList.contains('dash__when'))
    expect(when('39m', screen.getByRole('region', { name: 'Running' })).length).toBeGreaterThan(0)
    expect(when('4h 11m', screen.getByRole('region', { name: 'Running' })).length).toBeGreaterThan(0)
    expect(when(/^4m ago$/, screen.getByRole('region', { name: 'Needs you' })).length).toBe(1)
    const worth = screen.getByRole('region', { name: 'Worth a look' })
    expect(worth.querySelectorAll('.dash__when')).toHaveLength(2)
    for (const one of screen.getByRole('region', { name: 'Needs you' }).querySelectorAll('.m3-mono')) {
      expect(one.classList.contains('dash__when')).toBe(true)
    }
  })
})

/** The daemon's key, which the unit scenarios leave out: the harness answers
 *  a read by its path's last part. */
const keyed = (state: Scenario): Scenario => Object.assign(state, { 'ssh-identity': contract.sshIdentity as never })

/** The seven checks a session needs present (`lib/ready`), and gh with no
 *  sign-in, which does not hold ready back. */
const ready = (machine: string): Readiness => ({
  machine,
  age_seconds: 0,
  checks: [
    ...['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session'].map((check) => ({
      check,
      state: 'present' as const,
      detail: '',
    })),
    { check: 'provider-auth', state: 'absent', detail: 'gh reports no stored credential there' },
  ],
})

describe('the Dashboard on an empty fleet', () => {
  it('draws each block saying what would be there, and one New session', async () => {
    mount('desktop', '/', keyed(scenario('empty')))
    await drawn()
    expect(region('Needs you').getByText('Nothing needs you')).toBeTruthy()
    expect(region('Running').getByText('Nothing is running')).toBeTruthy()
    expect(reads('Worth a look')).toContain(
      'every tmux session on the machines that answered belongs to a workspace',
    )
    expect(screen.getByText('No workspaces yet')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: /New/ }).length).toBeGreaterThan(0)
  })

  it('offers New in the compact Idle card on the phone', async () => {
    writePrefs({ density: 'compact' })
    mount('phone', '/', keyed(scenario('empty')))
    await drawn()
    const idle = region('Idle')
    expect(idle.getByText('No workspaces yet')).toBeTruthy()
    expect(idle.getByRole('link', { name: 'New →' }).getAttribute('href')).toBe('/new')
  })
})

describe('the Dashboard on the first run', () => {
  /** No workspace, and the sweep asks no machine because none is named, so
   *  readiness is blank and the machine list is the only signal. */
  const firstRun = (machines: Machine[], reports: Readiness[] = []): Scenario =>
    Object.assign(scenario('empty'), {
      machines: looked.ok(machines),
      readiness: looked.ok(reports),
    })

  it('is the setup checklist while no machine is online', async () => {
    mount('desktop', '/', firstRun([aMachine({ online: false })]))
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up Yantra' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('is the checklist when the tailnet lists no machine at all', async () => {
    mount('desktop', '/', firstRun([]))
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up Yantra' })).toBeTruthy()
  })

  /** The owner's ruling (b), 2026-09-13: a machine answering is not enough. */
  it('stays the checklist while a machine is online and none is ready', async () => {
    mount('desktop', '/', keyed(firstRun([aMachine({ online: true })])))
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up Yantra' })).toBeTruthy()
  })

  it('stays the checklist until the appliance has its key', async () => {
    mount('desktop', '/', firstRun([aMachine({ online: true })], [ready('cachyos-g14')]))
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up Yantra' })).toBeTruthy()
  })

  it('gives way to the empty board once the key is made and one machine is ready', async () => {
    mount('desktop', '/', keyed(firstRun([aMachine({ online: true })], [ready('cachyos-g14')])))
    await drawn()
    expect(screen.queryByRole('heading', { name: 'Set up Yantra' })).toBeNull()
    expect(region('Needs you').getByText('Nothing needs you')).toBeTruthy()
  })

  /** D7 §4.9: the steps for later, until they are done or the card is hidden. */
  it('then shows Finish setup with the steps for later, until it is hidden', async () => {
    mount('desktop', '/', keyed(firstRun([aMachine({ online: true })], [ready('cachyos-g14')])))
    const card = within(await screen.findByRole('region', { name: 'Finish setup' }))
    expect(card.getByRole('progressbar')).toBeTruthy()
    expect(card.getByText('GitHub')).toBeTruthy()
    expect(card.getByRole('link', { name: 'Add another device' }).getAttribute('href')).toBe('/machines/add')
    fireEvent.click(card.getByRole('button', { name: 'Hide Finish setup' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Finish setup' })).toBeNull())
    expect(readPrefs().general.finishSetup).toBe('hidden')
  })

  it('says on Finish setup that GitHub refused the grant, and offers Sign in again', async () => {
    const state = keyed(firstRun([aMachine({ online: true })], [ready('cachyos-g14')]))
    Object.assign(state, { github: contract.github, 'readiness/github': contract.githubRefused })
    mount('desktop', '/', state)
    const card = within(await screen.findByRole('region', { name: 'Finish setup' }))
    expect(await card.findByText(/GitHub refused the grant · sign in again/)).toBeTruthy()
    expect(card.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe('/settings/providers')
  })

  /** R23 change 13: step 4 needs a workspace, and a workspace ends the
   *  checklist, so the summary is on the card the owner lands on. */
  it('says what setup configured on the card once all four steps are done', async () => {
    const state = keyed(firstRun([aMachine({ online: true })], [ready('cachyos-g14')]))
    mount('desktop', '/', Object.assign(state, { workspaces: looked.ok([aListed()]) }))
    const card = within(await screen.findByRole('region', { name: 'Finish setup' }))
    const configured = within(card.getByRole('list', { name: 'What setup configured' }))
    expect(configured.getByText(/Add a machine/)).toBeTruthy()
    expect(configured.getByText(/1 of 1 machines ready/)).toBeTruthy()
    expect(configured.getByText(/1 workspace made/)).toBeTruthy()
  })

  it('keeps no summary on the card while the first session is not made', async () => {
    mount('desktop', '/', keyed(firstRun([aMachine({ online: true })], [ready('cachyos-g14')])))
    await screen.findByRole('region', { name: 'Finish setup' })
    expect(screen.queryByRole('list', { name: 'What setup configured' })).toBeNull()
  })

  /** Y-388: a phone runs no session, so one online is not a machine answering. */
  it('stays the checklist while only a phone or a tablet is online', async () => {
    mount('desktop', '/', firstRun([aMachine({ os: 'iOS', online: true }), aMachine({ name: 'nas', online: false })]))
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up Yantra' })).toBeTruthy()
  })
})

describe('the Dashboard with nothing reachable', () => {
  it('is one surface about the connection, not one per band', async () => {
    mount('desktop', '/', scenario('unreachable'))
    // The rail beside the page is its own region and says its own read failed.
    await screen.findAllByRole('alert')
    const pages = screen.getAllByRole('alert').filter((one) => (one as HTMLElement).dataset.layout === 'page')
    expect(pages).toHaveLength(1)
    const alert = pages[0]!
    expect(within(alert).getByText('The daemon could not read the fleet')).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()
    // The shell's board owns "off the tailnet"; this daemon answered.
    expect(within(alert).queryByRole('link', { name: 'Open Tailscale' })).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Details' }))
    expect(within(alert).queryByText(/off the tailnet/)).toBeNull()
    expect(screen.queryByRole('link', { name: /new session/i })).toBeNull()
    expect(screen.queryByRole('link', { name: 'New' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull()
  })
})
