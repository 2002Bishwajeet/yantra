import { afterEach, describe, expect, it, vi } from 'vitest'
import { answer } from '../test/daemon'
import { ApiError, asApiError, dictateError, isApiError, isDictateKind, type Kind, micError } from './errors'
import { attention, machines, notLooked, opened, spend } from './fixtures'
import {
  aboutQuery,
  attentionQuery,
  dirsQuery,
  githubQuery,
  hiddenOrgsQuery,
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
      insecure: new ApiError('insecure', 'http://pi:7717').describe(),
      denied: new ApiError('denied', 'Permission denied').describe(),
      'no-device': new ApiError('no-device', 'Requested device not found').describe(),
      stopped: new ApiError('stopped', 'Built-in Microphone ended').describe(),
      busy: new ApiError('busy', 'Could not start audio source').describe(),
      capture: new ApiError('capture', 'AbortError').describe(),
      allowed: new ApiError('allowed', '').describe(),
      'dictation-off': dictateError('off', 'YANTRA_STT_URL is not set').describe(),
      'stt-unreachable': dictateError('unreachable', '').describe(),
      'too-long': dictateError('too-long', 'the clip is longer than 60 seconds').describe(),
      silent: dictateError('silent', 'the service heard no words').describe(),
      'stt-failed': dictateError('failed', 'the service answered 500').describe(),
    }
    for (const said of Object.values(sentences)) {
      expect(said).toMatch(/^[A-Z].*\.$/)
      expect(said).not.toMatch(/\n\s+at /)
      expect(said).not.toContain('TypeError')
    }
    expect(sentences.network).toBe('The daemon did not answer.')
    expect(sentences.missing).toBe('The daemon knows nothing by that name.')
    expect(sentences.socket).toBe('The terminal could not be opened.')
    expect(sentences.busy).toBe('Another app is using the microphone.')
    expect(sentences.allowed).toBe('The browser now allows the microphone. Hold the button again to talk.')
  })

  /** Every sentence lives here: on the microphone's socket, `refused` and
   *  `socket` name the microphone rather than a terminal. */
  it('says the microphone’s refused and socket in its own words', () => {
    expect(micError('refused', 'no').describe()).toBe('The daemon refused the microphone.')
    expect(micError('socket', 'gone').describe()).toBe('The microphone on the machine stopped.')
    expect(micError('denied', 'no').describe()).toBe(new ApiError('denied', 'no').describe())
    expect(micError('insecure', 'http://pi:7717').describe()).toBe(
      'The microphone works only on the HTTPS address, on port 8443.',
    )
  })

  /** ADR-0043: the daemon's five reasons become five kinds, each with its own words. */
  it('reads each reason dictation gives as its own kind', () => {
    expect(dictateError('unreachable', '').describe()).toBe('Dictation is off: yantra-box does not answer.')
    const kinds = (['off', 'unreachable', 'too-long', 'silent', 'failed'] as const).map((kind) => dictateError(kind, 'x').kind)
    expect(kinds).toEqual(['dictation-off', 'stt-unreachable', 'too-long', 'silent', 'stt-failed'])
    expect(dictateError('failed', 'the service answered 500').said).toBe('the service answered 500')
    expect(isDictateKind('silent')).toBe(true)
    expect(isDictateKind('toString')).toBe(false)
    expect(isDictateKind(3)).toBe(false)
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
  ['hidden orgs', hiddenOrgsQuery()],
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
    () => vi.fn(() => Promise.resolve(answer(403, 'node pi is on this tailnet but is not yours'))),
    'refused',
  ],
  [
    'the name is unknown',
    () => vi.fn(() => Promise.resolve(answer(404, 'no such workspace'))),
    'missing',
  ],
  [
    'the body is not JSON',
    () => vi.fn(() => Promise.resolve(answer(200, '<html>'))),
    'contract',
  ],
] as const

describe('no query rejects with a bare error', () => {
  describe.each(badly)('when %s', (_, daemon, kind) => {
    it.each(asked)('%s rejects with an ApiError', async (_, options) => {
      vi.stubGlobal('fetch', daemon())
      const error = await call(options).then(
        (answered) => answered,
        (cause: unknown) => cause,
      )
      // The identity's 404 is a key not made yet, which is an answer (Y-390).
      if (kind === 'missing' && options.queryKey[0] === 'ssh-identity') {
        expect(error).toBeNull()
        return
      }
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
      // One machine's report answers 404 before the sweep has asked it, and
      // that is nobody having looked yet (D7 S4).
      if (kind === 'missing' && options.queryKey[0] === 'readiness' && options.queryKey.length === 2) {
        expect(reading).toEqual({ looked: 'never' })
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

  /** Y-390: a key not made is asked again until the first join makes it, and
   *  never after; a refetch of an error would flip the page back to pending. */
  it('asks for the identity again only while the daemon has no key', () => {
    const every = sshIdentityQuery().refetchInterval as (query: { state: { data: unknown } }) => number | false
    expect(every({ state: { data: null } })).toBe(5_000)
    expect(every({ state: { data: { public_key: 'ssh-ed25519 AAAA' } } })).toBe(false)
    expect(every({ state: { data: undefined } })).toBe(false)
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

describe('the own-address refusal', () => {
  const said =
    "a request from this machine's own address may not act, because any account here could have sent it. From this machine, send it on the socket."

  it('names the proxy, not the browser', () => {
    const error = new ApiError('refused', said, { status: 403 })
    expect(error.headline).toBe('The proxy hides who is calling')
    expect(error.describe()).toMatch(/^The proxy in front of Yantra/)
  })

  it('leaves every other 403 with the old sentence and no headline', () => {
    const error = new ApiError('refused', 'node biswas-iphone is on this tailnet but is not yours', { status: 403 })
    expect(error.headline).toBeUndefined()
    expect(error.describe()).toBe("This browser is not on a node this tailnet's owner holds.")
  })

  it('needs the 403 as well as the words', () => {
    expect(new ApiError('refused', said, { status: 400 }).headline).toBeUndefined()
  })
})
