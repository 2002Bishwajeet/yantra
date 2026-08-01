import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { Looked, Machine, MachineSessions, Session, Workspace } from './api'
import { machineColumns, sessionColumns, workspaceColumns } from './columns'
import { DataTable } from './components/DataTable'
import { Section } from './components/Section'
import { useLooked } from './useLooked'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    name: 'cachyos-g14',
    dns_name: 'cachyos-g14.<tailnet>.ts.net.',
    os: 'linux',
    online: true,
    expired: false,
    last_seen: '2026-07-07T09:00:00Z',
    ...overrides,
  }
}

function stubFetch(answers: Record<string, Looked<unknown>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(answers[path]) }),
    ),
  )
}

describe('the looked envelope', () => {
  it('says nobody has looked rather than drawing an empty fleet', () => {
    render(
      <Section title="Machines" query={{ looked: 'never' }}>
        {() => <p>a table</p>}
      </Section>,
    )
    expect(screen.getByText('Not looked at yet.')).toBeTruthy()
    expect(screen.queryByText('a table')).toBeNull()
  })

  it('renders a failure as the error and never as a table', () => {
    render(
      <Section
        title="Workspaces"
        query={{ looked: 'failed', age_seconds: 3, error: 'tailscaled is down' }}
      >
        {() => <p>a table</p>}
      </Section>,
    )
    expect(screen.getByText('tailscaled is down')).toBeTruthy()
    expect(screen.queryByText('a table')).toBeNull()
  })

  it('keeps the newlines in a multi-line parse error', () => {
    const error =
      'invalid workspace file\nTOML parse error at line 3, column 9\n  |\n3 | machine =\n  |         ^\n'
    render(
      <Section title="Workspaces" query={{ looked: 'failed', age_seconds: 1, error }}>
        {() => <p>a table</p>}
      </Section>,
    )
    const rendered = screen.getByText(error, { trim: false, collapseWhitespace: false })
    expect(rendered.textContent).toBe(error)
  })
})

describe('the machines table', () => {
  it('leaves LAST SEEN blank while a machine is online', () => {
    const { container } = render(
      <DataTable
        columns={machineColumns}
        rows={[machine()]}
        rowKey={(row) => row.name}
        empty="no machines on this tailnet"
      />,
    )
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells).toEqual(['cachyos-g14', 'linux', 'online', ''])
  })

  it('composes the status sentence and does not fold an expired key into offline', () => {
    render(
      <DataTable
        columns={machineColumns}
        rows={[machine({ online: false, expired: true, last_seen: '4d ago' })]}
        rowKey={(row) => row.name}
        empty="no machines on this tailnet"
      />,
    )
    expect(screen.getByText('offline, key expired')).toBeTruthy()
    expect(screen.getByText('4d ago')).toBeTruthy()
  })
})

describe('the workspaces table', () => {
  it('renders a null startup as a blank cell, not the word none', () => {
    const workspace: Workspace = {
      name: 'yantra',
      machine: 'cachyos-g14',
      repo: '/home/<user>/Github/homelab/yantra',
      startup: null,
    }
    const { container } = render(
      <DataTable
        columns={workspaceColumns}
        rows={[workspace]}
        rowKey={(row) => row.name}
        empty="no workspaces yet"
      />,
    )
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells.at(-1)).toBe('')
  })

  it('names the path a file goes in when the look succeeded and found nothing', () => {
    render(
      <DataTable
        columns={workspaceColumns}
        rows={[]}
        rowKey={(row) => row.name}
        empty="no workspaces yet — make one at ~/.config/yantra/workspaces/<name>.toml"
      />,
    )
    expect(
      screen.getByText(
        'no workspaces yet — make one at ~/.config/yantra/workspaces/<name>.toml',
      ),
    ).toBeTruthy()
  })
})

describe('the sessions section', () => {
  const session: Session = {
    name: 'yantra',
    windows: 2,
    // A client count: 0 is detached, and rendering it as "no" would be a lie.
    attached: 0,
    created: 'Thu Jul 30 13:02:31 2026',
  }
  const answers: MachineSessions[] = [
    { machine: 'cachyos-g14', reached: 'yes', sessions: [session] },
    { machine: 'pi', reached: 'no', error: 'connection timed out' },
  ]

  it('renders an unanswered machine as unreachable and not as zero sessions', async () => {
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': { looked: 'never' },
      '/api/sessions': { looked: 'ok', age_seconds: 6, data: answers },
    })
    render(<App />)

    expect(await screen.findByText('pi unreachable: connection timed out')).toBeTruthy()
    expect(screen.getByText('1 session on 1 of 2 machines')).toBeTruthy()
    expect(screen.queryByText('pi')).toBeNull()
  })

  it('renders attached as the client count rather than a yes or no', () => {
    const { container } = render(
      <DataTable
        columns={sessionColumns}
        rows={[{ machine: 'cachyos-g14', session }]}
        rowKey={(row) => row.machine}
        empty="no tmux sessions"
      />,
    )
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells).toEqual([
      'cachyos-g14',
      'yantra',
      '2',
      '0',
      'Thu Jul 30 13:02:31 2026',
    ])
  })
})

describe('useLooked', () => {
  it('maps a rejected fetch into a failed look rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('daemon is not running'))),
    )
    const { result } = renderHook(() => useLooked('/api/machines'))

    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({
      looked: 'failed',
      error: expect.stringContaining('daemon is not running'),
    })
  })

  it('maps a non-200 into a failed look, since the fleet answers 200 either way', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 404 })),
    )
    const { result } = renderHook(() => useLooked('/api/machines'))

    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({ error: expect.stringContaining('404') })
  })

  it('answers never before the first response', () => {
    stubFetch({ '/api/machines': { looked: 'ok', age_seconds: 0, data: [] } })
    const { result } = renderHook(() => useLooked('/api/machines'))
    expect(result.current).toEqual({ looked: 'never' })
  })
})
