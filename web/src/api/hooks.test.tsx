import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, screen, waitFor } from '@testing-library/react'
import { renderHookQueried } from '../test/inQuery'
import { renderInApp } from '../test/inApp'
import { answer, daemon } from '../test/daemon'
import { aListed, aWorkspace, looked, spend } from './fixtures'
import {
  agentsWaiting,
  loaded,
  merge,
  type Said,
  sessionsWaiting,
  useAgents,
  useMachines,
  useResetOnRouteChange,
  useSpend,
  useTranscript,
  useViewing,
} from './hooks'
import type { MachineSessions, Transcript, WorkspaceStatus } from '@/api'

afterEach(() => vi.unstubAllGlobals())

/** Moved from `dashboard.test.tsx`'s `useLooked` suite (Y-341): the hook is
 *  now `useMachines`, and what it owes the page is unchanged. */
describe('a swept reading', () => {
  it('maps a rejected fetch into a failed look rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('daemon is not running'))),
    )
    const { result } = renderHookQueried(() => useMachines())

    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({
      looked: 'failed',
      error: expect.stringContaining('daemon is not running'),
    })
  })

  it('maps a non-200 into a failed look, since the fleet answers 200 either way', async () => {
    daemon(404, 'no')
    const { result } = renderHookQueried(() => useMachines())

    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({ error: expect.stringContaining('404') })
  })

  /** D3 §7.1. This asserted the bug: a question not yet asked is not a question
   *  answered *never*, and `never` is the daemon's word for having looked at
   *  nothing — not the browser's for not having asked. Y-190. */
  it('answers pending before the first response, and never says never', () => {
    daemon(200, looked.ok([]))
    const { result } = renderHookQueried(() => useMachines())
    expect(result.current).toEqual({ looked: 'pending' })
  })

  it('asks the path the daemon serves the class on', async () => {
    const asked = daemon(200, looked.ok([], 4))
    const { result } = renderHookQueried(() => useMachines())

    await waitFor(() => expect(result.current.looked).toBe('ok'))
    expect(asked.mock.calls[0]![0]).toBe('/api/machines')
    expect(result.current).toMatchObject({ age_seconds: 4, data: [] })
  })
})

const status = (workspace: string, reached: 'yes' | 'no' = 'yes'): WorkspaceStatus =>
  ({
    workspace,
    machine: 'pi',
    reached,
    ...(reached === 'yes' ? { status: { state: 'running' }, session: null } : { error: 'timed out' }),
  }) as WorkspaceStatus

/** A daemon that answers each status route its own way, by name. */
function statuses(byName: Record<string, Response | Promise<Response>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      const name = /\/api\/workspaces\/([^/]+)\/status/.exec(path)?.[1]
      return Promise.resolve(name ? byName[name] : answer(200, looked.ok([])))
    }),
  )
}

describe('useAgents, which collapses one status per workspace', () => {
  const pair = [aWorkspace({ name: 'a' }), aWorkspace({ name: 'b' })]
  const two = looked.ok(pair)

  it('is pending while any name is still in flight', async () => {
    let release!: (value: Response) => void
    statuses({
      a: answer(200, looked.ok(status('a'), 3)),
      b: new Promise((done) => {
        release = done
      }),
    })
    const { result } = renderHookQueried(() => useAgents(two))
    await new Promise((done) => setTimeout(done, 20))
    expect(result.current).toEqual({ looked: 'pending' })
    await act(async () => release(answer(200, looked.ok(status('b'), 1))))
    await waitFor(() => expect(result.current.looked).toBe('ok'))
    expect(result.current).toMatchObject({
      age_seconds: 3,
      data: [
        { workspace: pair[0], status: status('a') },
        { workspace: pair[1], status: status('b') },
      ],
    })
  })

  it('reads a 404 as a row with no status, not a class that failed', async () => {
    statuses({
      a: answer(200, looked.ok(status('a'))),
      b: answer(404, { error: 'no workspace named b' }),
    })
    const { result } = renderHookQueried(() => useAgents(two))
    await waitFor(() => expect(result.current.looked).toBe('ok'))
    expect(result.current).toMatchObject({
      data: [{ status: status('a') }, { status: null }],
    })
  })

  it('is the failure when one status failed', async () => {
    statuses({
      a: answer(200, looked.ok(status('a'))),
      b: answer(200, looked.failed('ssh: timed out')),
    })
    const { result } = renderHookQueried(() => useAgents(two))
    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({ error: 'ssh: timed out' })
  })

  it('is whatever the workspaces class is when that is not ok', () => {
    const { result } = renderHookQueried(() => useAgents({ looked: 'failed', age_seconds: 0, error: 'down' }))
    expect(result.current).toEqual({ looked: 'failed', age_seconds: 0, error: 'down' })
  })
})

describe('the pure helpers', () => {
  it('loaded keeps the entries that are workspaces', () => {
    const fine = aListed(aWorkspace({ name: 'fine' }))
    const broken = { loaded: 'no', name: 'broken', error: 'missing field' } as const
    expect(loaded(looked.ok([fine, broken]))).toEqual(looked.ok([fine]))
    expect(loaded({ looked: 'pending' })).toEqual({ looked: 'pending' })
  })

  it('sessionsWaiting names the machines that were not reached', () => {
    const sessions: MachineSessions[] = [
      { machine: 'pi', reached: 'yes', sessions: [] },
      { machine: 'nas', reached: 'no', error: 'timed out' },
    ]
    expect(sessionsWaiting(looked.ok(sessions))).toEqual(['nas'])
    expect(sessionsWaiting({ looked: 'never' })).toEqual([])
  })

  it('agentsWaiting names each unreached machine once', () => {
    const rows = [
      { workspace: aWorkspace({ name: 'a' }), status: status('a', 'no') },
      { workspace: aWorkspace({ name: 'b' }), status: status('b', 'no') },
      { workspace: aWorkspace({ name: 'c' }), status: null },
    ]
    expect(agentsWaiting(looked.ok(rows))).toEqual(['pi'])
    expect(agentsWaiting({ looked: 'pending' })).toEqual([])
  })
})

describe('useSpend', () => {
  it('reads a 409 as nothing to count, not a refusal', async () => {
    daemon(409, 'no transcript yet')
    const { result } = renderHookQueried(() => useSpend())
    await act(() => result.current.ask(aWorkspace({ name: 'a' })))
    expect(result.current.asked).toMatchObject({ asked: 'nothing', said: 'no transcript yet' })
  })

  it('lets only the newest ask land when two overlap', async () => {
    let first!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((done) => {
              first = done
            }),
        )
        .mockImplementationOnce(() => Promise.resolve(answer(200, spend))),
    )
    const { result } = renderHookQueried(() => useSpend())
    const a = aWorkspace({ name: 'a' })
    const b = aWorkspace({ name: 'b' })
    let asking!: Promise<void>
    act(() => {
      asking = result.current.ask(a)
    })
    await act(() => result.current.ask(b))
    expect(result.current.asked).toMatchObject({ asked: 'read', workspace: b })
    await act(async () => {
      first(answer(200, { ...spend, total_usd: 99 }))
      await asking
    })
    expect(result.current.asked).toMatchObject({ asked: 'read', workspace: b })
  })
})

describe('the transcript', () => {
  const transcript = (total: number, turns: Transcript['turns']): Transcript => ({
    path: '/home/biswa/.claude/projects/a/x.jsonl',
    total,
    turns,
  })
  const turn = (n: number): Transcript['turns'][number] => ({ who: 'claude', at: null, text: `turn ${n}`, tools: [] })
  const held: Said = {
    said: 'held',
    total: 100,
    asked: 50,
    turns: [turn(51), turn(100)],
    at: 'then',
    paging: true,
    moved: false,
  }

  it.each([
    ['a first read holds the window', { said: 'no' } as Said, transcript(100, [turn(1)]), 50, 0, { said: 'held', total: 100, asked: 50, turns: [turn(1)], paging: false, moved: false }],
    ['an older window prepends and keeps the first total', held, transcript(100, [turn(1)]), 50, 50, { said: 'held', total: 100, asked: 100, turns: [turn(1), turn(51), turn(100)], at: 'then', paging: false }],
    ['a total that grew is the ground moving, not a newer number', held, transcript(120, [turn(1)]), 50, 50, { ...held, paging: false, moved: true }],
    ['asked never exceeds the total', { said: 'no' } as Said, transcript(30, [turn(1)]), 50, 0, { asked: 30 }],
  ] as const)('%s', (_, was, read, lines, before, expected) => {
    expect(merge(was, { read, at: 'now' }, lines, before)).toMatchObject(expected)
  })

  it('replaces what is held with a read that could not be made', () => {
    expect(merge(held, { said: 'nothing', because: 'no turn yet' }, 50, 50)).toEqual({
      said: 'nothing',
      because: 'no turn yet',
    })
  })

  /** A page in flight and a refresh asked for after it: the refresh is what
   *  the reader meant, so the older window's answer is dropped rather than
   *  prepended onto a transcript it was not read against. Two reads of one
   *  window cannot race — Query hands the second the first's promise. */
  it('lets only the newest read land when two overlap', async () => {
    let older!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init?: RequestInit) => {
        const { before } = JSON.parse(String(init?.body)) as { before: number }
        if (before === 50) {
          return new Promise<Response>((done) => {
            older = done
          })
        }
        return Promise.resolve(answer(200, transcript(100, [turn(51)])))
      }),
    )
    const { result } = renderHookQueried(() => useTranscript('a'))
    await act(() => result.current.read(50, 0))
    expect(result.current.said).toMatchObject({ said: 'held', total: 100, turns: [turn(51)] })

    let paging!: Promise<void>
    act(() => {
      paging = result.current.read(50, 50)
    })
    expect(result.current.said).toMatchObject({ paging: true })
    await act(() => result.current.read(50, 0))
    expect(result.current.said).toMatchObject({ paging: false, turns: [turn(51)] })

    await act(async () => {
      older(answer(200, transcript(100, [turn(1)])))
      await paging
    })
    expect(result.current.said).toMatchObject({ paging: false, turns: [turn(51)] })
  })
})

describe('useViewing', () => {
  const visible = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })

  it('beacons only while the tab is visible', () => {
    const asked = daemon(204)
    visible('hidden')
    const { unmount } = renderHook(() => useViewing())
    expect(asked).not.toHaveBeenCalled()
    visible('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(asked).toHaveBeenCalledWith('/api/viewing', { method: 'POST' })
    unmount()
    visible('visible')
  })
})

describe('useResetOnRouteChange', () => {
  it('keys the boundary on the resolved path, and resets Query with it', async () => {
    function Reads() {
      const { resetKeys, onReset } = useResetOnRouteChange()
      return <p>{`${resetKeys.join(',')} ${typeof onReset}`}</p>
    }
    await renderInApp(<Reads />)
    expect(await screen.findByText('/ function')).toBeTruthy()
  })
})
