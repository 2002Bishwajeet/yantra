import { useQuery } from '@tanstack/react-query'
import type { Looked, Pull } from '@/api'
import { fetchJson, fields } from '@/api/client'
import { asApiError } from '@/api/errors'
import { keys } from '@/api/keys'

/** The daemon's watch looks on `refresh::PULLS`; a page asks its memory as often, which costs no GitHub call. */
export const PULLS_POLL_MS = 30_000

/** `network`: the daemon did not answer. `failed`: it answered, but its watch could not look.
 *  `other`: a status or a body this page cannot read, such as an older daemon's 404. */
export type PullsFailureKind = 'network' | 'failed' | 'other'

const words: Record<PullsFailureKind, { title: string; next: string }> = {
  network: { title: 'The daemon did not answer', next: 'The checks could not be read. Check the network, then try again.' },
  failed: { title: 'The watch could not look', next: 'The daemon could not read its PR watch. Try again in a moment.' },
  other: { title: 'The checks could not be read', next: 'The daemon says why below. An older daemon has no checks to show.' },
}

/** What `ErrorSurface` draws: `describe()` is the next step, `said` the daemon's own words. */
export class PullsFailure {
  readonly kind: PullsFailureKind
  readonly said: string
  readonly retryable = true

  constructor(kind: PullsFailureKind, said: string) {
    this.kind = kind
    this.said = said
  }

  get title(): string {
    return words[this.kind].title
  }

  describe(): string {
    return words[this.kind].next
  }
}

async function readPulls(signal: AbortSignal): Promise<Pull[]> {
  let looked: Looked<Pull[]>
  try {
    looked = await fetchJson<Looked<Pull[]>>('/api/pulls', { signal }, fields('looked'))
  } catch (cause) {
    if (signal.aborted) throw cause
    const error = asApiError(cause)
    throw new PullsFailure(error.kind === 'network' ? 'network' : 'other', error.said)
  }
  if (looked.looked === 'failed') throw new PullsFailure('failed', looked.error)
  return looked.looked === 'ok' ? looked.data : []
}

/** The thread's PR as the watch holds it: `undefined` while the first read is out, `null` when the
 *  watch holds no PR at `url`. */
export function usePull(url: string) {
  return useQuery<Pull[], PullsFailure, Pull | null>({
    queryKey: keys.pulls(),
    queryFn: ({ signal }) => readPulls(signal),
    select: (pulls) => pulls.find((one) => one.url === url) ?? null,
    refetchInterval: PULLS_POLL_MS,
    staleTime: PULLS_POLL_MS,
    retry: false,
  })
}
