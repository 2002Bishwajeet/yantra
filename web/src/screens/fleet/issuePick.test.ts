import { describe, expect, it } from 'vitest'
import type { Placed, Placement, Workspace } from '@/api'
import { pickWorkspaces } from './issuePick'

const ws = (name: string, machine: string, repo = '/home/biswa/Github/yantra'): Workspace => ({
  name,
  machine,
  repo,
  startup: null,
})
const placed = (machine: string, score: number): Placed => ({
  machine,
  score,
  terms: { ram: 0, cpu: 0, power: 0, repo: 0, affinity: 0 },
  reason: `${machine} reason`,
})
const names = (picks: ReturnType<typeof pickWorkspaces>) => picks.choices.map((one) => one.workspace.name)

describe('pickWorkspaces', () => {
  const placement: Placement = { ranked: [placed('a', 40), placed('b', 70)], rejected: [] }

  it('keeps no workspace for a repo none of them holds', () => {
    const picks = pickWorkspaces([ws('x', 'a', '/home/biswa/Github/other')], '2002Bishwajeet/yantra', placement)
    expect(picks.choices).toEqual([])
  })

  it('matches the last path segment, ignoring case, and ranks by score', () => {
    const picks = pickWorkspaces(
      [ws('on-a', 'a'), ws('on-b', 'b', 'C:\\Users\\Yantra'), ws('skip', 'b', '/srv/yantra-landing')],
      '2002Bishwajeet/yantra',
      placement,
    )
    expect(names(picks)).toEqual(['on-b', 'on-a'])
    expect(picks.choices[0]?.reason).toBe('b reason')
    expect(picks.ranked).toBe(true)
  })

  it('breaks a tie by name', () => {
    const tied: Placement = { ranked: [placed('a', 50), placed('b', 50)], rejected: [] }
    const picks = pickWorkspaces([ws('zed', 'a'), ws('amy', 'b')], 'o/yantra', tied)
    expect(names(picks)).toEqual(['amy', 'zed'])
  })

  it('keeps a workspace on an asleep machine, with its reason, last', () => {
    const slept: Placement = {
      ranked: [placed('a', 10)],
      rejected: [{ machine: 'b', why: 'asleep_or_off', age_seconds: 900 }],
    }
    const picks = pickWorkspaces([ws('on-b', 'b'), ws('on-a', 'a')], 'o/yantra', slept)
    expect(names(picks)).toEqual(['on-a', 'on-b'])
    expect(picks.choices[1]).toMatchObject({ asleep: true, reason: 'asleep or off' })
  })

  it('falls back to name order when the ranking is unknown', () => {
    const picks = pickWorkspaces([ws('zed', 'a'), ws('amy', 'b')], 'o/yantra', null)
    expect(names(picks)).toEqual(['amy', 'zed'])
    expect(picks.ranked).toBe(false)
    expect(picks.choices[0]?.reason).toBeNull()
  })
})
