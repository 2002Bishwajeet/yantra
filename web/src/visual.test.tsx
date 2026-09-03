/**
 * D3 §15: assertions gate, screenshots advise. What this pins is every number
 * and structure D3 §§5.3–5.7 and §6 name, on the surfaces Y-192 and Y-193 own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AgentState, Machine, Session, WorkspaceStatus } from './api'
import { agentState, machineColumns, sessionColumns } from './columns'
import { Age } from './components/Age'
import { DataTable } from './components/DataTable'
import { Status, type Tone } from './components/Status'
import { renderRouted } from './test/inRouter'
import { ago, at } from './lib/time'

// jsdom implements no `matchMedia`, and `DataTable` asks it for the breakpoint.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1440 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const HOUR = 3600
const DAY = 24 * HOUR

function reported(state: AgentState): WorkspaceStatus {
  return {
    workspace: 'yantra',
    machine: 'cachyos-g14',
    reached: 'yes',
    status: state,
    session: null,
  }
}

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    name: 'cachyos-g14',
    dns_name: 'cachyos-g14.tail.ts.net',
    os: 'linux',
    online: true,
    expired: false,
    last_seen: null,
    heartbeat: null,
    ...overrides,
  }
}

const session: Session = {
  name: 'yantra',
  windows: 2,
  attached: 0,
  created: 'Thu Jul 30 13:02:31 2026',
}

/** D3 §5.7. The boundary is 24 h, and it is chosen in one place. */
describe('one clock', () => {
  const now = Date.parse('2026-08-11T12:00:00Z')

  it('reads under 24 hours as an age', () => {
    expect(ago(4, now).text).toBe('4s')
    expect(ago(12 * 60, now).text).toBe('12m')
    expect(ago(6 * HOUR, now).text).toBe('6h')
    expect(ago(DAY - 1, now).text).toBe('23h')
  })

  it('reads 24 hours and over as a date', () => {
    expect(ago(DAY, now).text).toBe('10 Aug')
    expect(ago(35 * DAY, now).text).toBe('7 Jul')
  })

  it('carries the exact timestamp rather than the rounded one', () => {
    expect(ago(90, now).title).toBe('2026-08-11T11:58:30.000Z')
  })

  it('reads a stamp that names its zone', () => {
    const read = at('2026-07-07T09:00:00Z', now)
    expect(read?.text).toBe('7 Jul')
    expect(read?.title).toBe('2026-07-07T09:00:00Z')
  })

  /** D3 §5.7's exception. tmux formats `created` on the far machine's clock, so
   *  reading it on the browser's would be the guess R-23 refuses. */
  it('refuses a stamp that names no zone', () => {
    expect(at('Thu Jul 30 13:02:31 2026', now)).toBeNull()
    expect(at('4d ago', now)).toBeNull()
  })
})

/** D3 §5.5: Geist has no `tnum`, so a column of figures needs a second face. */
describe('numeric cells take the monospace stack', () => {
  it('monospaces the heartbeat age and the last-seen date', async () => {
    const { container } = await renderRouted(
      <DataTable
        columns={machineColumns}
        rows={[
          machine({
            online: false,
            last_seen: '2026-07-07T09:00:00Z',
            heartbeat: {
              age_seconds: 92,
              arch: 'x86_64',
              labels: [],
              free_ram_mb: 9000,
              free_disk_mb: 100,
              cpu_busy_pct: 15,
              power: 'ac',
            },
          }),
        ]}
        rowKey={(row) => row.name}
        empty="no machines on this tailnet"
      />,
    )

    const figures = [...container.querySelectorAll('.font-mono')]
    expect(figures.map((one) => one.textContent)).toEqual(['1m', '7 Jul'])
    expect(figures.every((one) => one.getAttribute('title'))).toBe(true)
  })

  it('monospaces the session counts and shows tmux verbatim', () => {
    const { container } = render(
      <DataTable
        columns={sessionColumns({ looked: 'never' })}
        rows={[{ machine: 'cachyos-g14', session }]}
        rowKey={(row) => row.machine}
        empty="no tmux sessions"
      />,
    )

    expect(
      [...container.querySelectorAll('.font-mono')].map((one) => one.textContent),
    ).toEqual(['2', '0', 'Thu Jul 30 13:02:31 2026'])
  })

  it('monospaces the freshness figure and nothing around it', () => {
    render(<Age seconds={44} />)
    expect(screen.getByText('44s').className).toContain('font-mono')
  })
})

/** D3 §6.1. The mark is form, so this is what a greyscale screenshot keeps. */
describe('four marks', () => {
  const marks: Record<Tone, string> = {
    bad: 'tone-bad',
    warn: 'tone-warn',
    ok: 'tone-ok',
    idle: 'tone-idle',
    unknown: 'tone-unknown',
  }

  it('draws every tone with a mark', () => {
    for (const [tone, mark] of Object.entries(marks)) {
      render(<Status label={tone} tone={tone as Tone} />)
      const badge = screen.getByText(tone)
      expect(badge.className).toContain('mark')
      expect(badge.className).toContain(mark)
      cleanup()
    }
  })

  /** Four forms, not five: *needs you* is one mark that two tones share, and
   *  they are told apart by colour, which §6.2 allows because both are states
   *  a person must act on. */
  it('spends four forms on five tones', () => {
    expect(new Set(Object.values(marks)).size).toBe(5)
    expect(new Set([marks.bad, marks.warn]).size).toBe(2)
  })

  /** D3 §6.2: colouring uncertainty makes it look like a decision. */
  it('gives a contradiction no tint and reads the endings as idle', () => {
    const said = (state: AgentState) => agentState(reported(state)).tone

    expect(said({ state: 'unclear', because: 'the pane is alive' })).toBe('unknown')
    expect(said({ state: 'finished' })).toBe('idle')
    expect(said({ state: 'stopped' })).toBe('idle')
    expect(said({ state: 'no_session' })).toBe('idle')
    expect(said({ state: 'running' })).toBe('ok')
  })
})

/** D3 §5.4 and §5.6, as the classes the tokens are reached through. */
describe('type and density at the call sites', () => {
  it('labels columns small, tracked and muted, and keeps them uppercase', () => {
    const { container } = render(
      <DataTable
        columns={sessionColumns({ looked: 'never' })}
        rows={[{ machine: 'cachyos-g14', session }]}
        rowKey={(row) => row.machine}
        empty="no tmux sessions"
      />,
    )

    const label = container.querySelector('th')
    expect(label?.textContent).toBe('MACHINE')
    expect(label?.className).toContain('text-meta')
    expect(label?.className).toContain('tracking-wider')
    expect(label?.className).toContain('text-muted-foreground')
  })

  it('sets a row to the height token rather than to a number', () => {
    const { container } = render(
      <DataTable
        columns={sessionColumns({ looked: 'never' })}
        rows={[{ machine: 'cachyos-g14', session }]}
        rowKey={(row) => row.machine}
        empty="no tmux sessions"
      />,
    )

    expect(container.querySelector('tbody tr')?.className).toContain('h-row')
    expect(container.querySelector('table')?.className).toContain('text-body')
  })
})
