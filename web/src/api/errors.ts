/** The one error anything under `api/` rejects with. Eighteen kinds, each from a
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
  // 401: this device holds no live passkey session (ADR-0044). The shell
  // draws the sign-in screen instead of the page that asked.
  | 'unauthenticated'
  // A body this dashboard cannot read — not JSON, or not the envelope.
  | 'contract'
  // A terminal socket's text frame: why the pty could not be opened.
  | 'socket'
  // The four the browser itself raises on the microphone (ADR-0031 §4, §6):
  // a page on :7717, a permission refused, no device, and a track the browser
  // or iOS took away. `api/mic.ts` makes them.
  | 'insecure'
  | 'denied'
  | 'no-device'
  | 'stopped'
  // The rest of the microphone's: a device another app holds, a capture that
  // failed some other way, and a permission granted after the button was let go.
  | 'busy'
  | 'capture'
  | 'allowed'
  // Dictation's (ADR-0043 §4, §6): no service set, a service that does not
  // answer, a clip over 60 seconds, no words heard, and a service that failed.
  | 'dictation-off'
  | 'stt-unreachable'
  | 'too-long'
  | 'silent'
  | 'stt-failed'

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

/** The start of `Refused::OwnAddress`'s body (write.rs): the daemon saw its own
 *  address, which is what a proxy on the same machine sends from. */
export const OWN_ADDRESS = "a request from this machine's own address"
export const PROXY_HEADLINE = 'The proxy hides who is calling'
export const PROXY_SENTENCE =
  "The proxy in front of Yantra sends from this machine's own address, so the daemon cannot tell who is calling."

export const isOwnAddress = (status: number | null | undefined, said: string) =>
  status === 403 && said.startsWith(OWN_ADDRESS)

const sentences: Record<Kind, string> = {
  network: 'The daemon did not answer.',
  refused: 'The daemon refused.',
  missing: 'The daemon knows nothing by that name.',
  unauthenticated: 'This device is not signed in.',
  contract: 'The daemon answered something this dashboard cannot read.',
  socket: 'The terminal could not be opened.',
  insecure: 'The microphone works only on the HTTPS address, on port 8443.',
  denied: 'This browser was not allowed to use the microphone.',
  'no-device': 'This browser found no microphone to use.',
  stopped: 'The browser took the microphone away, so the stream stopped.',
  busy: 'Another app is using the microphone.',
  capture: 'The browser could not open the microphone.',
  allowed: 'The browser now allows the microphone. Hold the button again to talk.',
  'dictation-off': 'Dictation is off: the daemon has no speech service set.',
  'stt-unreachable': 'Dictation is off: yantra-box does not answer.',
  'too-long': 'That was over 60 seconds, so nothing was sent. Hold for less.',
  silent: 'No words were heard. Hold the button and speak.',
  'stt-failed': 'The speech service failed, so nothing was written.',
}

/** The kinds a press of the microphone ends with. */
export type MicKind = Extract<
  Kind,
  'insecure' | 'denied' | 'no-device' | 'stopped' | 'busy' | 'capture' | 'allowed' | 'refused' | 'socket'
>

/** On the microphone's socket, `refused` and `socket` are about the microphone, not a terminal. */
const onTheMic: Partial<Record<MicKind, string>> = {
  refused: 'The daemon refused the microphone.',
  socket: 'The microphone on the machine stopped.',
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

  /** A title that names the cause, for the one refusal whose cause is not the caller's. */
  get headline(): string | undefined {
    return isOwnAddress(this.status, this.said) ? PROXY_HEADLINE : undefined
  }

  /** The sentence a surface draws: plain, and it names the daemon. */
  describe(): string {
    if (this.sentence) return this.sentence
    if (isOwnAddress(this.status, this.said)) return PROXY_SENTENCE
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

export const micError = (kind: MicKind, said: string) => new ApiError(kind, said, { sentence: onTheMic[kind] })

/** What the daemon's dictation route names a failure, and the kind each becomes. */
const dictated = {
  off: 'dictation-off',
  unreachable: 'stt-unreachable',
  'too-long': 'too-long',
  silent: 'silent',
  failed: 'stt-failed',
} as const satisfies Record<string, Kind>

export type DictateKind = keyof typeof dictated

export const isDictateKind = (kind: unknown): kind is DictateKind =>
  typeof kind === 'string' && Object.hasOwn(dictated, kind)

export const dictateError = (kind: DictateKind, said: string) => new ApiError(dictated[kind], said)
