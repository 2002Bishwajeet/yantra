import { createElement } from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Attention, Check, Item, Machine, Readiness } from '@/api'
import { aListed, aMachine, aWorkspace } from '@/api/fixtures'
import { MachineCard } from '@/screens/machines/MachineCard'
import { renderInApp } from '@/test/inApp'
import { chipOf, verdictOf } from '@/screens/machine/verdict'
import { counted, tally } from '@/screens/machines/facts'
import { line, machines as readied } from '@/screens/setup/steps'
import { waiting, work } from '@/work'
import { useHeldBands } from '@/screens/fleet/held'

const BASICS = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo']
const OPTIONAL = ['provider-cli', 'provider-auth', 'login-session', 'folder-access', 'hooks', 'no-sudo', 'heartbeat']

const report = (machine: string, absent: string[]): Readiness => ({
  machine,
  age_seconds: 0,
  checks: [...BASICS, ...OPTIONAL].map(
    (id): Check => ({ check: id, state: absent.includes(id) ? 'absent' : 'present', detail: '' }),
  ),
})

const item = (number: number): Item => ({
  repo: 'o/r',
  number,
  title: `item ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  updated_at: '2026-07-07T09:00:00Z',
})

/** One fleet, every count (Y-641): the walk found three screens printing three
 *  numbers for it. */
const mac = aMachine({ name: 'mac', os: 'macOS' })
const laptop = aMachine({ name: 'laptop' })
const box = aMachine({ name: 'box', online: false })
const fleet: { machine: Machine; report: Readiness | null }[] = [
  { machine: mac, report: report('mac', ['login-session', 'hooks', 'folder-access']) },
  { machine: laptop, report: report('laptop', ['provider-auth']) },
  { machine: box, report: null },
]

const chipFor = (machine: Machine, one: Readiness | null) =>
  chipOf(
    verdictOf({
      name: machine.name,
      machine,
      readiness: one
        ? { looked: 'ok', age_seconds: 0, data: one }
        : { looked: 'ok', age_seconds: 0, data: { machine: machine.name, checks: [], age_seconds: 0 } },
      events: [],
      watch: null,
    }),
    null,
  )

describe('one fleet, every count', () => {
  it('gives the card and the page one chip and one count for a machine', async () => {
    for (const { machine, report: one } of fleet) {
      if (!one) continue
      const view = await renderInApp(
        createElement(MachineCard, { machine, checks: one.checks, condensed: false, pending: false, sessions: null }),
      )
      const chip = chipFor(machine, one).word
      const count = counted(tally(one.checks))
      expect(view.getByText(chip)).toBeTruthy()
      expect(view.getByText(new RegExp(`^${count}`))).toBeTruthy()
      view.unmount()
    }
    expect(counted(tally(fleet[0]!.report!.checks))).toBe('10 of 13')
    // A Mac whose login has no tmux server is not ready, and the chip says so.
    expect(chipFor(mac, fleet[0]!.report).word).toBe('3 to fix')
    expect(chipFor(laptop, fleet[1]!.report).word).toBe('ready · 1 to fix')
    expect(chipFor(box, null).word).toBe('asleep')
  })

  it('counts a ready machine the same in setup and in the chips', () => {
    const lines = fleet.map(({ machine, report: one }) => ({ machine: machine.name, line: line(machine, one, null) }))
    const chips = fleet.filter(({ machine, report: one }) => chipFor(machine, one).word.startsWith('ready')).length
    expect(chips).toBe(1)
    expect(readied(lines).words).toContain(`${chips} of ${lines.length} machines ready`)
  })

  it('counts the hero over the live bands while the rows stay held', () => {
    const workspace = aWorkspace({ name: 'trust' })
    const running = work([aListed(workspace)], {
      looked: 'ok',
      age_seconds: 0,
      data: [{ workspace, status: { workspace: 'trust', machine: 'mac', reached: 'yes', status: { state: 'running' }, session: null } }],
    })
    const trusting = work([aListed(workspace)], {
      looked: 'ok',
      age_seconds: 0,
      data: [{ workspace, status: { workspace: 'trust', machine: 'mac', reached: 'yes', status: { state: 'awaiting_trust' }, session: null } }],
    })
    const attention: Attention = { reviews: [item(1)], issues: [item(3)], notifications: 9 }
    const view = renderHook((rows) => useHeldBands(rows), { initialProps: running })
    view.rerender(trusting)
    // The held row keeps its old band until Reorder; the count does not wait for it.
    expect(view.result.current.placed[0]!.band).toBe('running')
    expect(waiting(view.result.current.placed, attention)).toBe(2)
    expect(waiting(trusting, attention)).toBe(3)
  })
})
