import { QueryClient } from '@tanstack/react-query'
import type { Looked } from '@/api'
import { ApiError, isApiError } from '@/api/errors'

const contract = (path: string, missing?: string) =>
  `${path} answered something this dashboard cannot read${missing ? `: no \`${missing}\`` : ''}`

/** What the daemon said with a status. `write.rs` answers a bare string and
 *  `api.rs` a `{error}` for its 404s; either way the sentence, never the
 *  braces. A body that cannot be read is its own reason. */
async function said(response: Response): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    return String(cause)
  }
  try {
    const body = JSON.parse(text) as { error?: unknown } | null
    if (typeof body?.error === 'string') return body.error
  } catch {
    // A bare string, which is what most refusals are.
  }
  return text
}

/** A guard on a 2xx body: the name of what is missing, or null. */
export type Shape = (body: unknown) => string | null

/** The body is an object carrying every named field. */
export const fields =
  (...names: string[]): Shape =>
  (body) => {
    if (typeof body !== 'object' || body === null) return names[0] ?? 'body'
    return names.find((name) => !(name in body)) ?? null
  }

/** One fetch for everything that is not a `Looked` envelope. Every way it does
 *  not answer the body is an `ApiError` of one kind: `fetch` rejecting is
 *  `network`, a 404 is `missing`, any other non-2xx is `refused` carrying the
 *  daemon's own sentence, a body that is not JSON is `contract`. A 204 is
 *  `undefined`, and an abort is rethrown so Query reads the unmount as the
 *  cancellation it is. A `shape` names what a 2xx body must carry, and a body
 *  without it is `contract` too, with the field in `said`. */
export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  shape?: Shape,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (cause) {
    if (init.signal?.aborted) throw cause
    throw new ApiError('network', String(cause))
  }
  const { status } = response
  if (status === 404) {
    throw new ApiError('missing', await said(response), { status })
  }
  if (!response.ok) {
    throw new ApiError('refused', await said(response), { status })
  }
  if (status === 204) return undefined as T
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new ApiError('contract', String(cause), { status })
  }
  const missing = shape?.(body)
  if (missing) {
    throw new ApiError('contract', contract(path, missing), { status })
  }
  return body as T
}

export const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const failed = (error: string) =>
  ({ looked: 'failed', age_seconds: 0, error }) as const

/** D3 §7.1, the sharpest finding in that document: a question not yet asked was
 *  not answered *never*. `pending` is a fourth state and not a fourth word: it
 *  is this browser's, the other three are the daemon's, and only a surface
 *  knows how to draw it. */
export type Reading<T> = Looked<T> | { looked: 'pending' }

const WORDS = new Set(['ok', 'failed', 'never'])

/** The body of a 200 as the envelope, or a failed look that says the body was
 *  not one. */
export async function envelope<T>(
  response: Response,
  path: string,
): Promise<Looked<T>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return failed(contract(path))
  }
  const word = (body as { looked?: unknown } | null)?.looked
  if (typeof word !== 'string' || !WORDS.has(word)) {
    return failed(contract(path))
  }
  return body as Looked<T>
}

/** Never throws: a dead daemon becomes the same `failed` envelope the daemon
 *  itself produces, so the page has one failure path rather than two — and
 *  Query's own `isError` is therefore a state the fleet pages cannot reach
 *  (R-23: a look that failed is data about the fleet, not an exception). */
export async function look<T>(
  path: string,
  signal: AbortSignal,
): Promise<Looked<T>> {
  try {
    const response = await fetch(path, { signal })
    // Every fleet state answers 200, so a non-200 is a fact about this browser
    // reaching the daemon and never about the fleet's health.
    if (!response.ok) return failed(`${path} answered ${response.status}`)
    return await envelope<T>(response, path)
  } catch (cause) {
    if (signal.aborted) throw cause
    return failed(String(cause))
  }
}

/** For a surface that wants a boundary rather than a sentence in place: a
 *  failed reading as the error it would have been. `null` for the other three
 *  states, which are not failures. */
export function fromReading(reading: Reading<unknown>): ApiError | null {
  if (reading.looked !== 'failed') return null
  return new ApiError('network', reading.error, { sentence: 'The look failed.' })
}

/** The same options, thrown to the nearest boundary instead of held in
 *  `error` — what a route component under `ErrorBoundary` asks for. */
export function queryOptionsThrowing<T extends object>(options: T) {
  return { ...options, throwOnError: true as const }
}

/** `refresh.rs`: every class is swept every 30 s except the one that leaves the
 *  tailnet. A reading younger than its sweep cannot be fresher, so a route that
 *  `ensureQueryData`s inside that window pays nothing. */
export const SWEEP_MS = 30_000
export const ATTENTION_SWEEP_MS = 300_000

/** The daemon refreshes every 30 s, so polling faster buys no fresher data —
 *  it keeps the age on screen ticking. */
export const POLL_MS = 5_000

/** How many more times a `retryable` kind is asked, and how long between. */
export const RETRIES = 2
export const backoff = (attempt: number) =>
  Math.min(1_000 * 2 ** attempt, 30_000)

/** One client per mount, as `App` makes it: a cache shared between tests would
 *  answer the second from the first's. Only what never answered is asked again;
 *  a mutation never is, since a verb that ran twice is two verbs. Errors stay
 *  in `error` unless `queryOptionsThrowing` says otherwise. */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: SWEEP_MS,
        refetchOnWindowFocus: true,
        structuralSharing: true,
        throwOnError: false,
        retry: (failures, error) =>
          isApiError(error) && error.retryable && failures < RETRIES,
        retryDelay: backoff,
      },
      mutations: { retry: false, throwOnError: false },
    },
  })
}
