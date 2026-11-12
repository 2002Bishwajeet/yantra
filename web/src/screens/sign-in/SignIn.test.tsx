import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { signedIn } from '@/api/signedIn'
import { mountSettings, sent, unmountSettings, type Answer, type Answers } from '@/screens/settings/harness'

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}))

const SAID = 'sign in from the dashboard, or run this on the hub'
const OPTIONS = { publicKey: { challenge: 'Y2hhbGxlbmdl', rpId: 'hub.example.ts.net' } }

afterEach(() => {
  cleanup()
  unmountSettings()
  signedIn()
  vi.mocked(startAuthentication).mockReset()
  vi.mocked(startRegistration).mockReset()
})

/** Every read refused until a finish answers, as the daemon does with no cookie. */
function hub(extra: Answers = {}) {
  let cookie = false
  const gated = (body: unknown) => (): Answer => (cookie ? [200, body] : [401, SAID])
  return mountSettings('phone', '/settings/devices', {
    'GET /api/workspaces': gated({ looked: 'ok', age_seconds: 0, data: [] }),
    // A finish leaves a passkey and this device's session, so Devices shows its Signed in group.
    'GET /api/passkey': gated({
      relying_party: 'hub.example.ts.net',
      passkeys: [{ name: 'iPhone', made: 1_762_819_200 }],
      sessions: [{ id: 'a1', passkey: 'iPhone', device: 'iPhone', made: 1_762_819_200, ends: 1_765_411_200, this_device: true }],
    }),
    'POST /api/passkey/login/start': [200, { ceremony: 'c1', options: OPTIONS }],
    'POST /api/passkey/register/start': [200, { ceremony: 'c2', options: OPTIONS }],
    'POST /api/passkey/login/finish': () => {
      cookie = true
      return [200, { session: {} }]
    },
    'POST /api/passkey/register/finish': () => {
      cookie = true
      return [200, { session: {} }]
    },
    ...extra,
  })
}

describe('the sign-in screen', () => {
  it('takes the page on a 401, and a tapped passkey lands back on the route', async () => {
    const asked = hub()
    const button = await screen.findByRole('button', { name: 'Sign in with a passkey' })
    // Nothing starts a ceremony before the tap: Safari refuses one without a gesture.
    expect(startAuthentication).not.toHaveBeenCalled()
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'k' } as never)

    fireEvent.click(button)

    await waitFor(() => expect(asked).toContain('POST /api/passkey/login/finish'))
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS.publicKey })
    expect(await screen.findByText('Signed in')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull()
  })

  it('enrols with a code and a name, sending both to the daemon', async () => {
    let started: RequestInit | undefined
    hub({
      'POST /api/passkey/register/start': (init) => {
        started = init
        return [200, { ceremony: 'c2', options: OPTIONS }]
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Set up this device with a code' }))
    const submit = screen.getByRole('button', { name: 'Set up this device' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'abcd2345' } })
    fireEvent.change(screen.getByLabelText("This device's name"), { target: { value: 'iPhone 17' } })
    vi.mocked(startRegistration).mockResolvedValue({ id: 'k' } as never)

    fireEvent.click(submit)

    expect(await screen.findByText('Signed in')).toBeTruthy()
    expect(sent(started)).toEqual({ code: 'ABCD2345', device: 'iPhone 17' })
  })

  it('says the daemon’s words on a wrong code, and Try again asks again', async () => {
    let tries = 0
    hub({
      'POST /api/passkey/register/start': () => {
        tries += 1
        return [401, 'that code is wrong, used, or expired']
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Set up this device with a code' }))
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'ABCD2345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set up this device' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('This device is not set up')
    expect(alert.textContent).toContain('that code is wrong, used, or expired')
    expect(startRegistration).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(tries).toBe(2))
  })

  it('says the browser stopped when the person cancels the passkey', async () => {
    const asked = hub()
    vi.mocked(startAuthentication).mockRejectedValue(
      Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The browser did not finish the passkey. Nothing was signed in.')
    expect(alert.textContent).toContain('NotAllowedError')
    expect(asked).not.toContain('POST /api/passkey/login/finish')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('says the daemon was not reached when the start never answers', async () => {
    hub({ 'POST /api/passkey/login/start': [503, 'the hub does not know its MagicDNS name yet'] })
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the hub does not know its MagicDNS name yet')
  })
})
