import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { renderHookQueried } from '../test/inQuery'
import { ApiError } from './errors'
import { aWorkspace, looked, opened, stopped } from './fixtures'
import { keys } from './keys'
import {
  useCreateWorkspace,
  useDeleteWorkspace,
  useDown,
  useEditWorkspace,
  useKillSession,
  useRecheckReadiness,
  useRepairWorkspace,
  useResume,
  useSetRelay,
  useUp,
} from './mutations'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Records the method and path of every call, and answers what it is told. */
function daemon(status: number, body: unknown) {
  const asked = vi.fn((path: string, init?: RequestInit) => {
    void path
    void init
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(String(body)),
    })
  })
  vi.stubGlobal('fetch', asked)
  return asked
}

const sent = (asked: ReturnType<typeof daemon>, index = 0) => {
  const [path, init] = asked.mock.calls[index] as [string, RequestInit?]
  return { path, method: init?.method, body: init?.body }
}

describe('the workspace verbs', () => {
  it('starts a workspace with no startup of its own with the agent', async () => {
    const asked = daemon(200, opened)
    const { result } = renderHookQueried(() => useUp())

    let answer: unknown
    await act(async () => {
      answer = await result.current.mutateAsync(aWorkspace({ startup: null }))
    })

    expect(sent(asked)).toEqual({
      path: '/api/workspaces/yantra/up',
      method: 'POST',
      body: JSON.stringify({ agent: 'claude' }),
    })
    expect(answer).toEqual(opened)
  })

  it('sends no agent for a workspace that starts its own thing', async () => {
    const asked = daemon(200, opened)
    const { result } = renderHookQueried(() => useUp())

    await act(() => result.current.mutateAsync(aWorkspace({ startup: 'nvim .' })))

    expect(sent(asked).body).toBe('{}')
  })

  /** The status and the sessions class are what a verb changes, so both are
   *  asked again — and the row it invalidates is the one it acted on. */
  it('invalidates the status of the workspace it acted on, and the sessions', async () => {
    daemon(200, stopped)
    const { result } = renderHookQueried(() => ({
      down: useDown(),
      client: useQueryClient(),
    }))
    const { client } = result.current
    client.setQueryData(keys.status('yantra'), looked.ok(null))
    client.setQueryData(keys.status('site'), looked.ok(null))
    client.setQueryData(keys.sessions(), looked.ok([]))

    await act(() => result.current.down.mutateAsync('yantra'))

    const stale = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated
    expect(stale(keys.status('yantra'))).toBe(true)
    expect(stale(keys.sessions())).toBe(true)
    expect(stale(keys.status('site'))).toBe(false)
  })

  /** Each code the routes answer means a different thing, and the typed error
   *  is what lets a surface keep them apart. */
  it('surfaces a refusal with its status and the daemon’s own words', async () => {
    daemon(409, 'the agent in `yantra` is holding at the trust prompt')
    const { result } = renderHookQueried(() => useDown())

    await act(() => result.current.mutateAsync('yantra').catch(() => {}))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect(result.current.error).toMatchObject({
      status: 409,
      said: 'the agent in `yantra` is holding at the trust prompt',
    })
  })
})

describe('the workspace file', () => {
  it('creates with a POST and invalidates the list', async () => {
    const asked = daemon(201, aWorkspace({ name: 'site' }))
    const { result } = renderHookQueried(() => ({
      create: useCreateWorkspace(),
      client: useQueryClient(),
    }))
    result.current.client.setQueryData(keys.workspaces(), looked.ok([]))

    await act(() =>
      result.current.create.mutateAsync({
        name: 'site',
        machine: 'pi',
        repo: '/srv/site',
      }),
    )

    expect(sent(asked)).toMatchObject({
      path: '/api/workspaces',
      method: 'POST',
    })
    expect(
      result.current.client.getQueryState(keys.workspaces())?.isInvalidated,
    ).toBe(true)
  })

  /** No `?force=true` unless a surface means it: the daemon's refusal to strand
   *  a session is the thing worth reading. */
  it('deletes without force unless asked, and with it when asked', async () => {
    const asked = daemon(200, { machine: 'pi', removed: true })
    const { result } = renderHookQueried(() => useDeleteWorkspace())

    await act(() => result.current.mutateAsync({ name: 'site' }))
    await act(() => result.current.mutateAsync({ name: 'site', force: true }))

    expect(sent(asked, 0)).toMatchObject({
      path: '/api/workspaces/site',
      method: 'DELETE',
    })
    expect(sent(asked, 1).path).toBe('/api/workspaces/site?force=true')
  })
})

describe('a session no workspace claims', () => {
  it('kills by machine and session, and asks the sessions class again', async () => {
    const asked = daemon(200, { machine: 'pi', session: 'scratch', killed: true })
    const { result } = renderHookQueried(() => ({
      kill: useKillSession(),
      client: useQueryClient(),
    }))
    result.current.client.setQueryData(keys.sessions(), looked.ok([]))

    await act(() =>
      result.current.kill.mutateAsync({ machine: 'pi', session: 'scratch' }),
    )

    expect(sent(asked)).toMatchObject({
      path: '/api/machines/pi/sessions/scratch',
      method: 'DELETE',
    })
    expect(
      result.current.client.getQueryState(keys.sessions())?.isInvalidated,
    ).toBe(true)
  })
})

describe('a readiness recheck', () => {
  /** The POST answers the GET's own envelope at age 0, so it goes straight into
   *  that key rather than waiting for the sweep to notice. */
  it('writes the fresh report under the machine’s readiness key', async () => {
    const report = looked.ok({ machine: 'pi', checks: [] })
    const asked = daemon(200, report)
    const { result } = renderHookQueried(() => ({
      recheck: useRecheckReadiness(),
      client: useQueryClient(),
    }))

    await act(() => result.current.recheck.mutateAsync('pi'))

    expect(sent(asked)).toEqual({
      path: '/api/machines/pi/readiness',
      method: 'POST',
      body: undefined,
    })
    expect(result.current.client.getQueryData(keys.readiness('pi'))).toEqual(
      report,
    )
  })
})

/** Every write, refused by the authoriser in its own words (`write.rs`,
 *  `Refused`): 403 is about the caller, 503 says nothing was decided. Each
 *  rejects with an `ApiError` carrying both, and nothing else. */
const NOT_YOURS = 'node pi is on this tailnet but is not yours'
const CANNOT_ASK =
  'could not establish who is calling: tailscale whois: connection refused'

const writes = [
  ['create', () => useCreateWorkspace(), { name: 'a', machine: 'pi', repo: '/a' }],
  ['edit', () => useEditWorkspace(), { name: 'a', change: { repo: '/b' } }],
  ['delete', () => useDeleteWorkspace(), { name: 'a' }],
  ['up', () => useUp(), aWorkspace()],
  ['down', () => useDown(), 'a'],
  ['resume', () => useResume(), 'a'],
  ['kill', () => useKillSession(), { machine: 'pi', session: 's' }],
  ['repair', () => useRepairWorkspace(), { name: 'a', text: '' }],
  ['relay', () => useSetRelay(), { url: 'https://ntfy.sh/x' }],
  ['recheck', () => useRecheckReadiness(), 'pi'],
] as const

describe('every write refused', () => {
  describe.each([
    [403, NOT_YOURS],
    [503, CANNOT_ASK],
  ])('with a %s', (status, said) => {
    it.each(writes)('%s rejects with the status and the words', async (_, hook, input) => {
      daemon(status, said)
      const { result } = renderHookQueried(hook as () => ReturnType<typeof useDown>)

      const error = await act(() =>
        result.current.mutateAsync(input as never).then(
          () => null,
          (cause: unknown) => cause,
        ),
      )

      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ kind: 'refused', status, said })
      await waitFor(() => expect(result.current.isError).toBe(true))
      expect(result.current.error).toBe(error)
    })
  })

  it.each(writes)('%s rejects as network when nothing answers', async (_, hook, input) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    const { result } = renderHookQueried(hook as () => ReturnType<typeof useDown>)

    const error = await act(() =>
      result.current.mutateAsync(input as never).then(
        () => null,
        (cause: unknown) => cause,
      ),
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'network', retryable: true })
  })
})
