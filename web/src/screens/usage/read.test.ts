import { describe, expect, it } from 'vitest'
import type { Spend, Workspace } from '@/api'
import { aWorkspace } from '@/api/fixtures'
import { byModel, byWorkspace, lines, type Row } from './read'

const spend = (over: Partial<Spend> = {}): Spend => ({
  path: '/home/biswa/.claude/projects/-home-biswa-Github-yantra/1f0c1a2e.jsonl',
  total: { responses: 4, input: 10, output: 20, cache_write: 5, cache_read: 900 },
  models: [{ model: 'opus', responses: 4, cost: 1.5 }],
  fast: 0,
  cost: 1.5,
  as_of: '2026-08-11',
  ...over,
})

const read = (workspace: Workspace, over: Partial<Spend> = {}): Row => ({
  read: 'ok',
  workspace,
  spend: spend(over),
})

const one = aWorkspace({ name: 'landing', machine: 'macbook' })
const two = aWorkspace({ name: 'yantra-web', machine: 'cachyos-g14' })

describe('by workspace', () => {
  it('sorts by cost and never sums the fleet (D6 §5.1)', () => {
    const rows = [read(one, { cost: 10.06 }), read(two, { cost: 5.63 })]
    const spent = byWorkspace(rows)
    expect(spent.map((row) => row.name)).toEqual(['landing', 'yantra-web'])
    expect(spent).not.toHaveProperty('total')
  })

  it('leaves an unpriced read without a figure, and behind the priced ones', () => {
    const spent = byWorkspace([read(one, { cost: null }), read(two, { cost: 0.25 })])
    expect(spent[0]!.name).toBe('yantra-web')
    expect(spent[1]!.cost).toBeNull()
  })

  it('drops a workspace that answered something other than a figure', () => {
    const rows: Row[] = [
      read(one),
      { read: 'nothing', workspace: two, said: 'no transcript yet' },
    ]
    expect(byWorkspace(rows).map((row) => row.name)).toEqual(['landing'])
  })
})

describe('by model', () => {
  it('adds one model across the workspaces that used it', () => {
    const rows = [
      read(one, { models: [{ model: 'opus', responses: 4, cost: 1 }] }),
      read(two, { models: [{ model: 'opus', responses: 2, cost: 2 }] }),
    ]
    expect(byModel(rows)).toEqual([
      { model: 'opus', responses: 6, cost: 3, workspaces: 2 },
    ])
  })

  it('is unpriced, never free, when one of its reads carries no price', () => {
    const rows = [
      read(one, { models: [{ model: 'unknown', responses: 2, cost: null }] }),
      read(two, { models: [{ model: 'unknown', responses: 1, cost: 4 }] }),
    ]
    expect(byModel(rows)[0]).toEqual({
      model: 'unknown',
      responses: 3,
      cost: null,
      workspaces: 2,
    })
  })
})

describe('the table rows', () => {
  it('name the session from the transcript the daemon opened', () => {
    expect(lines([read(one)])[0]).toMatchObject({
      session: '1f0c1a2e',
      workspace: 'landing',
      machine: 'macbook',
      models: 'opus',
      cacheRead: 900,
    })
  })

  it('hold no row for a read that failed', () => {
    const rows: Row[] = [{ read: 'refused', workspace: one, status: 503, said: 'no' }]
    expect(lines(rows)).toEqual([])
  })
})
