import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, asApiError, isApiError, type Kind } from './errors'
import { attention, machines, notLooked, opened, spend } from './fixtures'
import {
  aboutQuery,
  attentionQuery,
  dirsQuery,
  githubQuery,
  machineReadinessQuery,
  machinesQuery,
  notificationsQuery,
  probeQuery,
  readinessQuery,
  reposQuery,
  repairQuery,
  sessionsQuery,
  spendQuery,
  sshIdentityQuery,
  statusQuery,
  transcriptQuery,
  workspacesQuery,
} from './queries'

afterEach(() => vi.unstubAllGlobals())

describe('what an error says', () => {
  it('is plain, names the daemon, and never a stack', () => {
    const sentences: Record<Kind, string> = {
      network: new ApiError('network', 'TypeError: Failed to fetch').describe(),
      refused: new ApiError('refused', 'no').describe(),
      missing: new ApiError('missing', 'no such', { status: 404 }).describe(),
      contract: new ApiError('contract', 'Unexpected token <').describe(),
      socket: new ApiError('socket', "can't find session").describe(),
    }
    for (const said of Object.values(sentences)) {
      expect(said).toMatch(/^[A-Z].*\.$/)
      expect(said).not.toMatch(/\n\s+at /)
      expect(said).not.toContain('TypeError')
    }
    expect(sentences.network).toBe('The daemon did not answer.')
    expect(sentences.missing).toBe('The daemon knows nothing by that name.')
    expect(sentences.socket).toBe('The terminal could not be opened.')
  })

  /** Each code the write authoriser answers means a different thing. */
  it('tells a 403 about the caller from a 503 about the tailnet', () => {
    const forbidden = new ApiError('refused', 'node pi is not yours', {
      status: 403,
    })
    const undecided = new ApiError('refused', 'could not establish', {
      status: 503,
    })
    expect(forbidden.describe()).toContain("tailnet's owner")
    expect(undecided.describe()).toContain('nothing was decided')
    expect(forbidden.describe()).not.toBe(undecided.describe())
  })

  it('reads a 409 as nothing broke', () => {
    expect(
      new ApiError('refused', 'a session is open', { status: 409 }).describe(),
    ).toContain('Nothing broke')
  })

  it('keeps the daemon’s words apart from the sentence', () => {
    const error = new ApiError('refused', 'the file did not parse', {
      status: 400,
    })
    expect(error.said).toBe('the file did not parse')
    expect(error.message).toBe('the file did not parse')
    expect(error.describe()).not.toContain('the file did not parse')
  })

  it('is retryable only when nothing answered', () => {
    const kinds: Kind[] = ['network', 'refused', 'missing', 'contract', 'socket']
    expect(kinds.filter((kind) => new ApiError(kind, '').retryable)).toEqual([
      'network',
    ])
  })

  it('names a bare error as this dashboard’s own, not the daemon’s', () => {
    const bare = asApiError(new RangeError('out of range'))
    expect(isApiError(bare)).toBe(true)
    expect(bare.kind).toBe('contract')
    expect(bare.said).toContain('out of range')
    expect(bare.describe()).toContain('dashboard')
    const own = new ApiError('missing', 'x')
    expect(asApiError(own)).toBe(own)
  })
})

/** Every query the layer exports, and what each may do when the daemon
 *  answers badly. The swept ones never reject (R-23: a failed look is data);
 *  the rest reject with an `ApiError` and nothing else. */
const signal = new AbortController().signal
const call = (options: { queryFn?: unknown; queryKey: readonly unknown[] }) =>
  (
    options.queryFn as (context: {
      signal: AbortSignal
      queryKey: readonly unknown[]
    }) => Promise<unknown>
  )({ signal, queryKey: options.queryKey })

const swept = [
  ['machines', machinesQuery()],
  ['workspaces', workspacesQuery()],
  ['sessions', sessionsQuery()],
  ['readiness', readinessQuery()],
  ['one readiness', machineReadinessQuery('pi')],
  ['attention', attentionQuery()],
  ['status', statusQuery('yantra')],
  ['repos', reposQuery()],
] as const

const asked = [
  ['spend', spendQuery('yantra')],
  ['transcript', transcriptQuery('yantra', { lines: 50, before: 0 })],
  ['repair', repairQuery('typo')],
  ['dirs', dirsQuery('pi', null)],
  ['probe', probeQuery('pi', '/srv')],
  ['github', githubQuery()],
  ['notifications', notificationsQuery()],
  ['about', aboutQuery()],
  ['ssh identity', sshIdentityQuery()],
] as const

const badly = [
  [
    'nothing answers',
    () => vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    'network',
  ],
  [
    'the authoriser refuses',
    () =>
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.resolve('node pi is on this tailnet but is not yours'),
        }),
      ),
    'refused',
  ],
  [
    'the name is unknown',
    () =>
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve('no such workspace'),
        }),
      ),
    'missing',
  ],
  [
    'the body is not JSON',
    () =>
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
          text: () => Promise.resolve('<html>'),
        }),
      ),
    'contract',
  ],
] as const

describe('no query rejects with a bare error', () => {
  describe.each(badly)('when %s', (_, daemon, kind) => {
    it.each(asked)('%s rejects with an ApiError', async (_, options) => {
      vi.stubGlobal('fetch', daemon())
      const error = await call(options).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).kind).toBe(kind)
    })

    it.each(swept)('%s resolves to a failed look instead', async (_, options) => {
      vi.stubGlobal('fetch', daemon())
      const reading = await call(options)
      // The one route that answers 404 answers it about a name, which the
      // agent class reads as a row not yet seen rather than a class that failed.
      if (kind === 'missing' && options.queryKey[2] === 'status') {
        expect(reading).toBe('missing')
        return
      }
      expect(reading).toMatchObject({ looked: 'failed' })
    })
  })

  it('reads a real answer as the envelope, and a real refusal as data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              path === '/api/attention'
                ? attention
                : path === '/api/sessions'
                  ? notLooked
                  : machines,
            ),
        }),
      ),
    )
    expect(await call(machinesQuery())).toEqual(machines)
    expect(await call(attentionQuery())).toEqual(attention)
    expect(await call(sessionsQuery())).toEqual(notLooked)
  })

  it('reads a real body from a read a person asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(path.endsWith('/tokens') ? spend : opened),
        }),
      ),
    )
    expect(await call(spendQuery('yantra'))).toEqual(spend)
  })
})
