/** Y-585: the session page's line for a machine that did not answer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
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
