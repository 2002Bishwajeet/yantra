/** Y-585: the session page's line for a machine that did not answer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { WorkspaceStatus } from '@/api'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { Header } from './Header'

const workspace = { loaded: 'yes', name: 'api', machine: 'pi', repo: '/home/biswa/api', startup: null } as const

const unreached = (error: string): WorkspaceStatus => ({ workspace: 'api', machine: 'pi', reached: 'no', error })

const open = (error: string) =>
  renderInApp(
    <Header
      now={0}
      sessions={{ looked: 'pending' }}
      status={unreached(error)}
      workspace={workspace}
    />,
  )

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer(404, 'no'))))
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the session header for a machine that did not answer', () => {
  it('gives an ssh failure its plain cause, the machine page and ssh’s words behind a disclosure', async () => {
    const error = 'ssh to pi failed before the command reported a status: yantra@pi: Permission denied (publickey).'
    await open(error)
    expect(await screen.findByText('pi did not take the appliance’s key.')).toBeTruthy()
    expect(screen.getByText(/Run the join command on pi/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'pi’s page' }).getAttribute('href')).toBe('/m/pi')
    expect(screen.queryByText(error)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /What ssh said/ }))
    expect(screen.getByText(error)).toBeTruthy()
  })

  it('never calls a tmux error an ssh failure', async () => {
    const error = 'tmux `has-session` failed with status 1: error connecting to /tmp/tmux-1000/default (Permission denied)'
    await open(error)
    expect(await screen.findByText('Yantra could not list the sessions on pi.')).toBeTruthy()
    expect(screen.getByText(/not an ssh failure/)).toBeTruthy()
    for (const words of [/appliance’s key/, /What ssh said/, /Permission denied/]) {
      expect(screen.queryByText(words)).toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: /The full error/ }))
    expect(screen.getByText(error)).toBeTruthy()
  })
})

const reached = (state: 'running' | 'stopped'): WorkspaceStatus =>
  ({ workspace: 'api', machine: 'pi', reached: 'yes', status: { state }, session: null }) as WorkspaceStatus

const show = (state: 'running' | 'stopped') =>
  renderInApp(<Header now={0} sessions={{ looked: 'pending' }} status={reached(state)} workspace={workspace} />)

/** The header's buttons that are drawn filled or tonal: Y-717 allows one. */
const loud = () => [...document.querySelectorAll<HTMLElement>('.m3-page-header [data-variant="tonal"], .m3-page-header [data-variant="filled"]')]

describe('the session header actions (Y-717)', () => {
  it.each([
    ['running', 'Stop', 'Resume'],
    ['stopped', 'Resume', 'Stop'],
  ] as const)('draws one tonal verb and one menu while the agent is %s', async (state, verb, other) => {
    await show(state)
    expect(await screen.findByRole('button', { name: verb })).toBeTruthy()
    // The other verb is not a button on the page; it waits in the menu.
    expect(screen.queryByRole('button', { name: other })).toBeNull()
    const triggers = document.querySelectorAll('.m3-page-header [aria-haspopup="menu"]')
    expect(triggers).toHaveLength(1)
    expect(loud().map((one) => one.textContent)).toEqual([verb])
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(await screen.findByRole('menuitem', { name: new RegExp(`^${other}`) })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })

  it('opens the Delete confirm from the menu, and returns focus to the menu trigger when it closes', async () => {
    await show('running')
    const more = await screen.findByRole('button', { name: 'More actions' })
    fireEvent.click(more)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete api?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(more))
  })

  it('keeps the reason on a verb that cannot run', async () => {
    await renderInApp(<Header now={0} sessions={{ looked: 'pending' }} status={null} workspace={workspace} />)
    const resume = await screen.findByRole('button', { name: 'Resume' })
    expect(resume).toHaveProperty('disabled', true)
    expect(document.getElementById(resume.getAttribute('aria-describedby') ?? '')?.textContent).toContain('has not read api')
  })

  it.each([
    ['running', 'Stop', 'was not stopped'],
    ['stopped', 'Resume', 'was not resumed'],
  ] as const)('draws the refusal of %s through ErrorSurface.Inline', async (state, verb, title) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer(500, 'boom'))))
    await show(state)
    fireEvent.click(await screen.findByRole('button', { name: verb }))
    expect(await screen.findByText(new RegExp(`api ${title}`))).toBeTruthy()
  })
})
