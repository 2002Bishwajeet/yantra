import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Devices } from '@/api/passkey'
import { mountSettings, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

const DEVICES: Devices = {
  relying_party: 'hub.example.ts.net',
  passkeys: [{ name: 'iPhone', made: 1_762_819_200 }],
  sessions: [
    { id: 'a1', passkey: 'iPhone', device: 'iPhone', made: 1_762_819_200, ends: 1_765_411_200, this_device: true, read_only: false },
    { id: 'b2', passkey: 'iPhone', device: 'Mac', made: 1_762_819_200, ends: 1_765_411_200, this_device: false, read_only: false },
  ],
}

const WALK = { id: 'c3', passkey: 'iPhone', device: 'walk', made: 1_762_819_200, ends: 1_765_411_200, this_device: false, read_only: true }
const TOKEN = 'Zm9yLXRoZS10ZXN0LW9ubHktbm90LWEtcmVhbC10b2tlbg'

const row = (name: string) => screen.getByText(name, { selector: '*' }).closest('li') as HTMLElement

describe('Devices', () => {
  it('lists the passkeys and the signed-in devices, and marks this one', async () => {
    mountSettings('desktop', '/settings/devices', { 'GET /api/passkey': [200, DEVICES] })
    expect(await screen.findByText('Passkeys work at hub.example.ts.net.')).toBeTruthy()
    expect(screen.getByText(/^This device · with iPhone/)).toBeTruthy()
    expect(screen.getByText('Mac')).toBeTruthy()
    const date = screen.getByText(/^Enrolled/).querySelector('.m3-num')!
    expect(date.textContent).toMatch(/\d/)
    expect(date.classList.contains('m3-mono')).toBe(false)
  })

  it('leads with Add a device and says the list is empty when there is no passkey', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, { relying_party: 'hub.example.ts.net', passkeys: [], sessions: [] }],
    })
    expect(await screen.findByText('No passkey yet')).toBeTruthy()
    expect(screen.getByText('Make a code to enrol the first device.')).toBeTruthy()
    expect(screen.getByText('A code for the first device')).toBeTruthy()
    const groups = screen.getAllByRole('heading', { level: 3 }).map((one) => one.textContent)
    expect(groups).toEqual(['Add a device', 'Passkeys'])
    const passkeys = screen.getByRole('region', { name: 'Passkeys' })
    expect(within(passkeys).getByText('Passkeys work at hub.example.ts.net.')).toBeTruthy()
    expect(screen.queryByText('Removing a passkey signs out every device it signed in.')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Read-only session' })).toBeNull()
  })

  it('says no device is signed in when a passkey has signed none in', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, { ...DEVICES, sessions: [] }],
    })
    const signedIn = await screen.findByRole('region', { name: 'Signed in' })
    expect(within(signedIn).getByText('No device is signed in')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign out every other device' })).toBeNull()
    expect(screen.getByText('A code for one new device')).toBeTruthy()
  })

  it('signs one device out by its session id', async () => {
    const asked = mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, DEVICES],
      'DELETE /api/sessions/b2': [204],
    })
    await screen.findByText('Mac')
    fireEvent.click(within(row('Mac')).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(asked).toContain('DELETE /api/sessions/b2'))
    // The list is read again, so the row goes when the daemon says so.
    await waitFor(() => expect(asked.filter((one) => one === 'GET /api/passkey')).toHaveLength(2))
  })

  it('signs every other device out', async () => {
    const asked = mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, DEVICES],
      'POST /api/sessions/revoke-others': [200, { revoked: 1 }],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out every other device' }))
    await waitFor(() => expect(asked).toContain('POST /api/sessions/revoke-others'))
  })

  it('draws no sign-out-others when this is the only device', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, { ...DEVICES, sessions: [DEVICES.sessions[0]] }],
    })
    await screen.findByText(/^This device · with iPhone/)
    expect(screen.queryByRole('button', { name: 'Sign out every other device' })).toBeNull()
  })

  it('makes a code to enrol a device, and a new one on the next press', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, DEVICES],
      'POST /api/passkey/code': [200, { code: 'ABCD2345', expires_in: 600 }],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Make a code' }))
    expect(await screen.findByText('ABCD2345')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New code' })).toBeTruthy()
  })

  it('says why a remove was refused', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, DEVICES],
      'DELETE /api/passkey/iPhone': [403, 'an agent token cannot act as the owner'],
    })
    await screen.findByText(/^Enrolled/)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const row = await screen.findByRole('alert')
    expect(within(row).getByRole('heading', { name: 'iPhone was not removed' })).toBeTruthy()
    expect(row.textContent).not.toContain('agent token')
    expect(screen.getByText(/^Enrolled/)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }))
    expect(within(row).getByText('an agent token cannot act as the owner')).toBeTruthy()
  })

  it('says a code was not made in a short row, with the words behind Details', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, DEVICES],
      'POST /api/passkey/code': [403, "a request from this machine's own address may not act"],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Make a code' }))
    const row = await screen.findByRole('alert')
    expect(within(row).getByRole('heading', { name: 'The proxy hides who is calling' })).toBeTruthy()
    expect(screen.getByText('Or run yantra passkey code on the hub')).toBeTruthy()
  })

  it('marks a read-only session and signs it out like any other', async () => {
    const asked = mountSettings('phone', '/settings/devices', {
      'GET /api/passkey': [200, { ...DEVICES, sessions: [...DEVICES.sessions, WALK] }],
      'DELETE /api/sessions/c3': [204],
    })
    await screen.findByText('walk')
    expect(within(row('walk')).getByText(/^Reads only · ends/)).toBeTruthy()
    expect(row('walk').textContent).not.toMatch(/with iPhone/i)
    fireEvent.click(within(row('walk')).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(asked).toContain('DELETE /api/sessions/c3'))
  })

  it('makes a read-only session and shows its token with where to save it', async () => {
    const asked = mountSettings('phone', '/settings/devices', {
      'GET /api/passkey': [200, DEVICES],
      'POST /api/sessions/read/walk': [200, { token: TOKEN, session: WALK }],
    })
    const group = await screen.findByRole('region', { name: 'Read-only session' })
    expect(within(group).getByText(/changes nothing/)).toBeTruthy()
    expect(screen.queryByText(TOKEN)).toBeNull()
    fireEvent.click(within(group).getByRole('button', { name: 'Make a token' }))
    expect(await within(group).findByText(TOKEN)).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Copy the token' })).toBeTruthy()
    expect(within(group).getByText(/^This token shows once\./).textContent).toContain(
      '~/.config/yantra/walk-session with mode 600',
    )
    expect(within(group).getByRole('button', { name: 'Make another' })).toBeTruthy()
    // The list is read again, so the new session shows under Signed in.
    await waitFor(() => expect(asked.filter((one) => one === 'GET /api/passkey')).toHaveLength(2))
  })

  it('says a read-only session cannot make one, and shows no token', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [200, DEVICES],
      'POST /api/sessions/read/walk': [403, 'this session is read-only: it reads the dashboard and changes nothing'],
    })
    const group = await screen.findByRole('region', { name: 'Read-only session' })
    fireEvent.click(within(group).getByRole('button', { name: 'Make a token' }))
    const failed = await within(group).findByRole('alert')
    expect(within(failed).getByRole('heading', { name: 'No read-only session was made' })).toBeTruthy()
    expect(failed.textContent).toContain('This session only reads. Sign in with a passkey to do this.')
    expect(failed.textContent).not.toContain("tailnet's owner")
    expect(within(group).queryByRole('button', { name: 'Copy the token' })).toBeNull()
  })

  it('draws the read’s failure with the daemon’s words', async () => {
    mountSettings('desktop', '/settings/devices', {
      'GET /api/passkey': [500, 'could not write /home/yantra/.config/yantra/passkeys.toml'],
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The devices could not be read')
    expect(alert.textContent).toContain('passkeys.toml')
  })
})
