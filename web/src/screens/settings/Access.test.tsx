import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { mountSettings, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

describe('Access', () => {
  it('names the key, and shows the public half with Copy in the sheet', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    // Base UI reads `navigator.userAgent` when it first loads, and a spread
    // of `navigator` leaves the prototype's getters behind.
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent, clipboard: { writeText } })
    mountSettings('desktop', '/settings/access')
    expect(await screen.findByText('/home/<user>/.ssh/id_yantra')).toBeTruthy()
    expect(screen.getByText(/ed25519 · SHA256:<fingerprint>/)).toBeTruthy()
    expect(screen.queryByText(/ssh-ed25519 AAAA/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show key' }))
    const sheet = within(await screen.findByRole('dialog', { name: 'Public key' }))
    expect(sheet.getByText(/^ssh-ed25519 AAAA/)).toBeTruthy()
    fireEvent.click(sheet.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^ssh-ed25519 /))
    expect(await sheet.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('says a key the daemon has not made is not created, and how to make it', async () => {
    mountSettings('desktop', '/settings/access', {
      'GET /api/ssh-identity': [404, { error: 'no identity: run `yantra ssh-identity`' }],
    })
    expect(await screen.findByText(/not created · run/)).toBeTruthy()
    expect(screen.getByText('yantra ssh-identity')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show key' })).toBeNull()
  })

  it('reads the tailnet and the listen addresses from the daemon', async () => {
    mountSettings('desktop', '/settings/access')
    expect(await screen.findByText('Anyone on the tailnet <tailnet>.ts.net')).toBeTruthy()
    expect(screen.getByText('Listen addresses')).toBeTruthy()
    expect(screen.getByText('100.64.0.1:7717 · [fd7a:115c:a1e0::1]:7717')).toBeTruthy()
  })
})
