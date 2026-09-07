/** The one error anything under `api/` rejects with. Five kinds, each from a
 *  different place: what a surface draws is `describe()`, and `said` — the
 *  daemon's own words, verbatim — goes beneath it in mono, as every form
 *  already does (D3 §8.1). */
export type Kind =
  // `fetch` itself rejected: the daemon was not reached, or the request was
  // never answered. The only kind worth asking again.
  | 'network'
  // The daemon answered and said no, as a bare string: 403 and 503 from the
  // write authoriser, a 409 about state, a 400 about the body.
  | 'refused'
  // 404: a name the daemon does not know.
  | 'missing'
  // A body this dashboard cannot read — not JSON, or not the envelope.
  | 'contract'
  // A terminal socket's text frame: why the pty could not be opened.
  | 'socket'

/** What the status alone says, before the daemon's sentence. Each code means a
 *  different thing, and collapsing them into "failed" sends the operator
 *  hunting a mistake they may not have made. The forms keep their verb-specific
 *  tables; this is what is true of any write. */
const refusals: Record<number, string> = {
  400: 'The daemon would not take what was sent.',
  403: "This browser is not on a node this tailnet's owner holds.",
  409: 'Nothing broke and nothing ran: the daemon declined, and its sentence says why.',
  422: 'The dashboard sent a field the daemon does not know.',
  500: "The verb ran and failed. The daemon's own words say where.",
  502: 'The daemon could not reach the relay.',
  503: 'Nothing could be asked, so nothing was decided and nothing ran.',
}

const sentences: Record<Kind, string> = {
  network: 'The daemon did not answer.',
  refused: 'The daemon refused.',
  missing: 'The daemon knows nothing by that name.',
  contract: 'The daemon answered something this dashboard cannot read.',
  socket: 'The terminal could not be opened.',
}

export class ApiError extends Error {
  readonly kind: Kind
  readonly status?: number
  /** The daemon's bare-string body, verbatim; the socket's text frame; or what
   *  `fetch` said. Never a stack. */
  readonly said: string
  /** Only what never answered is worth asking again: a refusal was reasoned
   *  about, a missing name stays missing, a body that cannot be read will not
   *  read better twice, and a refused socket only refuses again. */
  readonly retryable: boolean
  private readonly sentence?: string

  constructor(
    kind: Kind,
    said: string,
    { status, sentence }: { status?: number; sentence?: string } = {},
  ) {
    super(said)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.said = said
    this.retryable = kind === 'network'
    this.sentence = sentence
  }

  /** The sentence a surface draws: plain, and it names the daemon. */
  describe(): string {
    if (this.sentence) return this.sentence
    if (this.kind === 'refused' && this.status !== undefined) {
      return refusals[this.status] ?? sentences.refused
    }
    return sentences[this.kind]
  }
}

export const isApiError = (error: unknown): error is ApiError =>
  error instanceof ApiError

/** Whatever was thrown, as an `ApiError` — so a boundary reads one shape. A
 *  bare error is a bug in this layer, and it is named as one rather than
 *  dressed up as the daemon's. */
export function asApiError(error: unknown): ApiError {
  if (isApiError(error)) return error
  return new ApiError('contract', String(error), {
    sentence: 'The dashboard hit something it did not expect.',
  })
}
