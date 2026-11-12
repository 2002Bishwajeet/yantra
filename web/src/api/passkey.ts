import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import { fetchJson, fields, json } from '@/api/client'
import { ApiError } from '@/api/errors'
import { keys } from '@/api/keys'
import { signedIn } from '@/api/signedIn'

/** One signed-in device, as `passkey.rs` lists it. Times are Unix seconds. */
export type DeviceSession = {
  id: string
  passkey: string
  device: string
  made: number
  ends: number
  this_device: boolean
}

/** `GET /api/passkey`. `relying_party` is null until the hub knows its name. */
export type Devices = {
  relying_party: string | null
  passkeys: { name: string; made: number }[]
  sessions: DeviceSession[]
}

/** `POST /api/passkey/code` and `POST /api/join/code`. */
export type Code = { code: string; expires_in: number }
export type JoinCode = Code & { command: string }

/** What the daemon sends to start a ceremony: webauthn-rs wraps the options in `publicKey`. */
type Begun<T> = { ceremony: string; options: { publicKey: T } }

/** The browser's own refusal of a ceremony: the person cancelled, or no
 *  passkey here matched. It is `refused` with no status, so it is not asked again. */
function declined(cause: unknown): ApiError {
  const said = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  return new ApiError('refused', said, {
    sentence: 'The browser did not finish the passkey. Nothing was signed in.',
  })
}

/** The command that makes the hub read `daemon.env` again. */
export const RESTART = 'sudo systemctl restart yantrad'

/** The page is not under the name the hub's passkeys belong to, so the browser
 *  would refuse with a bare SecurityError. `line` is what the owner adds to
 *  `daemon.env`; `rpId` is the host the passkeys belong to. */
export class OriginMismatch extends ApiError {
  readonly line: string
  readonly page: string
  readonly rpId: string

  constructor(page: string, rpId: string) {
    super('refused', '', {
      sentence: `This page is at ${page}, but this hub's passkeys belong to ${rpId}.`,
    })
    this.page = page
    this.rpId = rpId
    this.line = `YANTRA_ORIGIN=${page}`
  }
}

/** A relying party id fits when the page's host is that name or sits under it. */
function mismatch(options: unknown): OriginMismatch | undefined {
  const o = options as { rpId?: string; rp?: { id?: string } }
  const rpId = o.rpId ?? o.rp?.id
  const { hostname, origin } = window.location
  if (!rpId || hostname === rpId || hostname.endsWith(`.${rpId}`)) return undefined
  return new OriginMismatch(origin, rpId)
}

async function ceremony<T, C>(
  start: string,
  finish: string,
  body: unknown,
  ask: (options: T) => Promise<C>,
): Promise<void> {
  const begun = await fetchJson<Begun<T>>(start, { method: 'POST', ...json(body) }, fields('ceremony', 'options'))
  const wrong = mismatch(begun.options.publicKey)
  if (wrong) throw wrong
  let credential: C
  try {
    credential = await ask(begun.options.publicKey)
  } catch (cause) {
    throw declined(cause)
  }
  await fetchJson(finish, { method: 'POST', ...json({ ceremony: begun.ceremony, credential }) })
}

/** Sign in with a passkey this device already holds (decision 4). */
export const signIn = (device: string) =>
  ceremony<PublicKeyCredentialRequestOptionsJSON, unknown>(
    '/api/passkey/login/start',
    '/api/passkey/login/finish',
    { device },
    (optionsJSON) => startAuthentication({ optionsJSON }),
  )

/** Enrol a new passkey with a code from the hub (decisions 2 and 3). */
export const enrol = (code: string, device: string) =>
  ceremony<PublicKeyCredentialCreationOptionsJSON, unknown>(
    '/api/passkey/register/start',
    '/api/passkey/register/finish',
    { code, device },
    (optionsJSON) => startRegistration({ optionsJSON }),
  )

/** A ceremony that ends signed in: the cookie is set, so every read is asked again. */
export function useSignIn() {
  const client = useQueryClient()
  return useMutation<void, ApiError, { code?: string; device: string }>({
    mutationFn: ({ code, device }) => (code ? enrol(code, device) : signIn(device)),
    onSuccess: () => {
      signedIn()
      return client.invalidateQueries()
    },
  })
}

export function useDevices() {
  return useQuery<Devices, ApiError>({
    queryKey: keys.devices(),
    queryFn: ({ signal }) => fetchJson<Devices>('/api/passkey', { signal }, fields('passkeys', 'sessions')),
  })
}

function useDevicesWrite<T, V>(write: (vars: V) => Promise<T>) {
  const client = useQueryClient()
  return useMutation<T, ApiError, V>({
    mutationFn: write,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.devices() }),
  })
}

export const useSignOut = () =>
  useDevicesWrite((id: string) =>
    fetchJson<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  )

export const useSignOutOthers = () =>
  useDevicesWrite((_: void) => fetchJson<{ revoked: number }>('/api/sessions/revoke-others', { method: 'POST' }))

export const useRemovePasskey = () =>
  useDevicesWrite((name: string) =>
    fetchJson<void>(`/api/passkey/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  )

/** A code is a write, and each press makes a new one. */
export const useEnrolCode = () =>
  useMutation<Code, ApiError, void>({
    mutationFn: () => fetchJson<Code>('/api/passkey/code', { method: 'POST' }, fields('code')),
  })

/** Decision 13: the join command carries a code that works once, so each
 *  machine the page offers it to gets its own. It is a read in Query's terms
 *  because the page draws it on sight, and it is made again before it lapses. */
const JOIN_FRESH_MS = 9 * 60_000

export const useJoinCommand = (machine: string) =>
  useQuery<JoinCode, ApiError>({
    queryKey: keys.joinCode(machine),
    queryFn: ({ signal }) =>
      fetchJson<JoinCode>('/api/join/code', { method: 'POST', signal }, fields('code', 'command')),
    staleTime: JOIN_FRESH_MS,
    refetchInterval: JOIN_FRESH_MS,
    retry: false,
  })
