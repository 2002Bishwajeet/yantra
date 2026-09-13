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
    // Y-390: a new machine takes the key through the join command.
    expect(sheet.getByText('curl -fsSL http://100.64.0.1:7717/join | sh')).toBeTruthy()
    expect(sheet.getByRole('link', { name: 'Add a device' }).getAttribute('href')).toBe('/add')
    expect(sheet.queryByText(/authorized_keys/)).toBeNull()
    fireEvent.click(sheet.getByRole('button', { name: 'Copy the public key' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^ssh-ed25519 /))
    expect(await sheet.findByRole('button', { name: 'Copied the public key' })).toBeTruthy()
  })

  /** Y-388: plain HTTP to a tailnet address has no clipboard, and Copy used
   *  to do nothing there. */
  it('selects the key and says how to copy it where there is no clipboard', async () => {
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent })
    mountSettings('desktop', '/settings/access')
    fireEvent.click(await screen.findByRole('button', { name: 'Show key' }))
    const sheet = within(await screen.findByRole('dialog', { name: 'Public key' }))
    fireEvent.click(sheet.getByRole('button', { name: 'Copy the public key' }))
    expect(await sheet.findByText(/no clipboard, so the text is selected/)).toBeTruthy()
    expect(window.getSelection()?.toString()).toMatch(/^ssh-ed25519 /)
    window.getSelection()?.removeAllRanges()
  })

  /** ADR-0029: the first join makes the key, so there is nothing to run. */
  it('says a key the daemon has not made is made by the first join, and opens Add a device', async () => {
    mountSettings('desktop', '/settings/access', {
      'GET /api/ssh-identity': [404, { error: 'no identity: run `yantra ssh-identity`' }],
    })
    expect(await screen.findByText('not created yet · the first machine that joins makes it')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Add a device' }).getAttribute('href')).toBe('/add')
    expect(screen.queryByText(/yantra ssh-identity/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show key' })).toBeNull()
  })

  it('reads the tailnet and the listen addresses from the daemon', async () => {
    mountSettings('desktop', '/settings/access')
    expect(await screen.findByText('Anyone on the tailnet <tailnet>.ts.net')).toBeTruthy()
    expect(screen.getByText('Listen addresses')).toBeTruthy()
    expect(screen.getByText('100.64.0.1:7717 · [fd7a:115c:a1e0::1]:7717')).toBeTruthy()
  })
})
