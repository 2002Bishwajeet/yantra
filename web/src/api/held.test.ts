import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FetchQueryOptions, QueryClient, type QueryKey } from '@tanstack/react-query'
import { answer as answered } from '../test/daemon'
import { HOLD_MS, makeQueryClient, NOT_REACHED, POLL_MS, REFUSED, SWEEP_MS, Unanswered } from './client'
import { machines as fleet, looked } from './fixtures'
import {
  attentionQuery,
  machineReadinessQuery,
  machinesQuery,
  MISSING,
  readAgain,
  statusQuery,
  workspacesQuery,
} from './queries'

const START = Date.parse('2026-11-12T09:00:00Z')
const DEAD = answered(502, '')
const LOST = { looked: 'failed', age_seconds: 0, error: `${NOT_REACHED}: HTTP 502` }

/** What the wire answers next. A function is asked the path. */
let wire: Response | ((path: string) => Response)
let asked: string[]
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  asked = []
  client = new QueryClient()
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      asked.push(path)
      return Promise.resolve(typeof wire === 'function' ? wire(path) : wire)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const later = (ms: number) => vi.setSystemTime(Date.now() + ms)

/** One poll: `fetchQuery` answers from the cache inside `staleTime`, and a poll does not. */
const poll = <T, K extends QueryKey>(options: FetchQueryOptions<T, Error, T, K>) =>
  client.fetchQuery({ ...options, staleTime: 0 })

const thrown = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error('resolved')
    },
    (cause: unknown) => cause,
  )

describe('a polled read the daemon does not answer', () => {
  it('keeps the reading it holds, and says since when', async () => {
    wire = answered(200, fleet)
    await poll(machinesQuery())
    const read = client.getQueryState(machinesQuery().queryKey)?.dataUpdatedAt

    later(POLL_MS)
    wire = DEAD
    const error = await thrown(poll(machinesQuery()))
    expect(error).toBeInstanceOf(Unanswered)
    expect(error).toMatchObject({ kind: 'network', said: LOST.error, since: START + POLL_MS })
    expect(client.getQueryState(machinesQuery().queryKey)).toMatchObject({ data: fleet, dataUpdatedAt: read })
  })

  it('answers the failed look when it holds no reading to keep', async () => {
    wire = DEAD
    expect(await poll(machinesQuery())).toEqual(LOST)
  })

  /** The daemon answered both, so neither is a daemon that was not reached. */
  it('does not hold a look the daemon said failed, or a refusal', async () => {
    const said = looked.failed<unknown>('`tailscale status --json` failed')
    wire = answered(200, fleet)
    await poll(machinesQuery())
    wire = answered(200, said)
    expect(await poll(machinesQuery())).toEqual(said)

    wire = answered(200, fleet)
    await poll(machinesQuery())
    wire = answered(403, 'the account x may only join itself')
    expect(await poll(machinesQuery())).toMatchObject({ error: `${REFUSED}: the account x may only join itself` })
  })

  it('answers the failed look once the daemon has not answered for the set time', async () => {
    wire = answered(200, fleet)
    await poll(machinesQuery())

    wire = DEAD
    for (let waited = 0; waited < HOLD_MS; waited += POLL_MS) {
      later(POLL_MS)
      expect(await thrown(poll(machinesQuery()))).toMatchObject({ since: START + POLL_MS })
    }
    later(POLL_MS)
    expect(await poll(machinesQuery())).toEqual(LOST)
    later(POLL_MS)
    expect(await poll(machinesQuery())).toEqual(LOST)

    // An answer ends the run, and the next silence starts a new one.
    wire = answered(200, fleet)
    later(POLL_MS)
    expect(await poll(machinesQuery())).toEqual(fleet)
    wire = DEAD
    later(POLL_MS)
    expect(await thrown(poll(machinesQuery()))).toBeInstanceOf(Unanswered)
  })

  /** A hidden tab and a sleeping laptop ask nothing, so the time between two
   *  reads far apart is not time the daemon spent failing. */
  it('starts the run again after a gap with no read in it', async () => {
    wire = answered(200, fleet)
    await poll(machinesQuery())
    wire = DEAD
    later(POLL_MS)
    await thrown(poll(machinesQuery()))

    later(10 * 60_000)
    const woke = Date.now()
    expect(await thrown(poll(machinesQuery()))).toMatchObject({ since: woke })
    later(POLL_MS)
    expect(await thrown(poll(machinesQuery()))).toMatchObject({ since: woke })
  })

  /** One poll of the slow classes is already longer than the set time. */
  it('gives a class polled every 30 s one failure, and answers the second', async () => {
    const reading = looked.ok({ prs: [], issues: [] })
    wire = answered(200, reading)
    await poll(attentionQuery())

    wire = DEAD
    later(SWEEP_MS)
    expect(await thrown(poll(attentionQuery()))).toBeInstanceOf(Unanswered)
    later(SWEEP_MS)
    expect(await poll(attentionQuery())).toEqual(LOST)
  })

  /** The 5 s poll is the retry: a second clock would ask a dead daemon three times a poll. */
  it('asks once, on the client the app makes', async () => {
    client = makeQueryClient()
    wire = answered(200, fleet)
    await poll(machinesQuery())
    wire = DEAD
    asked = []
    await thrown(poll(machinesQuery()))
    expect(asked).toEqual(['/api/machines'])
  })
})

describe('one machine’s readiness', () => {
  const query = machineReadinessQuery('pi')

  it('is held like the classes, and a 404 is still never', async () => {
    wire = answered(200, looked.ok({ machine: 'pi' }))
    await poll(query)
    wire = DEAD
    expect(await thrown(poll(query))).toBeInstanceOf(Unanswered)
    wire = answered(404, 'no')
    expect(await poll(query)).toEqual({ looked: 'never' })
  })
})

describe('one workspace’s status', () => {
  const query = statusQuery('site')
  const path = '/api/workspaces/site/status'
  const reading = looked.ok({ workspace: 'site' })

  it('is held through a status and through a fetch that rejected, and keeps its own words', async () => {
    wire = answered(200, reading)
    await poll(query)

    wire = DEAD
    later(POLL_MS)
    expect(await thrown(poll(query))).toMatchObject({ said: `${path} answered 502` })
    expect(client.getQueryData(query.queryKey)).toEqual(reading)

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    later(POLL_MS)
    expect(await thrown(poll(query))).toMatchObject({ said: 'TypeError: Failed to fetch', since: START + POLL_MS })
  })

  /** The 404 is the daemon's answer about one name. Losing it to one 502
   *  would fail the whole agent class. */
  it('keeps a name the agent look has not seen', async () => {
    wire = answered(404, 'no')
    expect(await poll(query)).toBe(MISSING)
    wire = DEAD
    expect(await thrown(poll(query))).toBeInstanceOf(Unanswered)
    expect(client.getQueryData(query.queryKey)).toBe(MISSING)
  })

  it('does not hold a look the daemon said failed', async () => {
    const said = looked.failed<unknown>('ssh: connect to host pi: timed out')
    wire = answered(200, reading)
    await poll(query)
    wire = answered(200, said)
    expect(await poll(query)).toEqual(said)
  })
})

describe('Try again', () => {
  it('does not reject while a status read is held', async () => {
    const listed = looked.ok([{ name: 'site' }])
    wire = (path) => answered(200, path === '/api/workspaces' ? listed : looked.ok({ workspace: 'site' }))
    await poll(workspacesQuery())
    await poll(statusQuery('site'))

    wire = DEAD
    later(POLL_MS)
    await expect(readAgain(client)).resolves.toBeUndefined()
    expect(client.getQueryState(statusQuery('site').queryKey)?.error).toBeInstanceOf(Unanswered)
    expect(client.getQueryData(workspacesQuery().queryKey)).toEqual(listed)
  })
})
