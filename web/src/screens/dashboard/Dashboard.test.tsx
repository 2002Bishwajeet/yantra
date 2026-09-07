import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { writePrefs } from '@/shell/prefs'
import { mount, scenario, unmount } from '@/screens/fleet/harness'

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
  writePrefs({ density: 'clean' })
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
    expect(screen.getByText(/thinkpad unreachable/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /^Fix/ }).getAttribute('href')).toBe('/m/thinkpad')
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

  it('asks before Kill, because a killed session cannot be brought back', async () => {
    const asked = mount('desktop', '/')
    await drawn()
    fireEvent.click(region('Worth a look').getAllByRole('button', { name: 'Kill' })[0]!)
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

  it('stamps the hero rather than the strip, which has no room', async () => {
    mount('phone', '/')
    await drawn()
    expect(region('Needs you').getByText(/^as of /)).toBeTruthy()
  })
})

describe('the Dashboard on an empty fleet', () => {
  it('draws each block saying what would be there, and one New session', async () => {
    mount('desktop', '/', scenario('empty'))
    await drawn()
    expect(region('Needs you').getByText('Nothing needs you')).toBeTruthy()
    expect(region('Running').getByText('Nothing is running')).toBeTruthy()
    expect(reads('Worth a look')).toContain(
      'every tmux session on the machines that answered belongs to a workspace',
    )
    expect(screen.getByText('no workspaces yet')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: /New/ }).length).toBeGreaterThan(0)
  })
})

describe('the Dashboard with nothing reachable', () => {
  it('is one surface about the connection, not one per band', async () => {
    mount('desktop', '/', scenario('unreachable'))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Nothing here can be reached')).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull()
  })
})
