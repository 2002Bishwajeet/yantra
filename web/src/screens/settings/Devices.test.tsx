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
    { id: 'a1', passkey: 'iPhone', device: 'iPhone', made: 1_762_819_200, ends: 1_765_411_200, this_device: true },
    { id: 'b2', passkey: 'iPhone', device: 'Mac', made: 1_762_819_200, ends: 1_765_411_200, this_device: false },
  ],
}

const row = (name: string) => screen.getByText(name, { selector: '*' }).closest('li') as HTMLElement

describe('Devices', () => {
  it('lists the passkeys and the signed-in devices, and marks this one', async () => {
    mountSettings('desktop', '/settings/devices', { 'GET /api/passkey': [200, DEVICES] })
    expect(await screen.findByText('Passkeys work at hub.example.ts.net.')).toBeTruthy()
    expect(screen.getByText(/^this device · with iPhone/)).toBeTruthy()
    expect(screen.getByText('Mac')).toBeTruthy()
    expect(screen.getByText(/^enrolled /)).toBeTruthy()
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
    await screen.findByText(/^this device · with iPhone/)
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
    await screen.findByText(/^enrolled /)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText(/an agent token cannot act as the owner/)).toBeTruthy()
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
