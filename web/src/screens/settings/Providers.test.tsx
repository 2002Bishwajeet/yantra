import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { mountSettings, sent, unmountSettings } from './harness'

/** GitHub's is the only row with an enabled Connect: GitLab and OpenAI are
 *  "Later", not a button. */
const connect = () => screen.getByRole('button', { name: 'Connect' })

afterEach(() => {
  cleanup()
  unmountSettings()
  vi.useRealTimers()
})

describe('Providers', () => {
  it('names the login the daemon holds, and counts the Claude sign-ins', async () => {
    mountSettings('desktop', '/settings/providers')
    expect(await screen.findByText('signed in as 2002Bishwajeet · repositories, reviews, issues')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
    // contract.readiness has no login-session check on any machine.
    expect(await screen.findByText(/Claude subscription · signed in on 0 of \d+ machines/)).toBeTruthy()
    // GitLab and OpenAI are "Later", D7 N6: a value, not a disabled button.
    expect(screen.getAllByText('Later')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  })

  /** Row 114: `.m3-clip` cuts rather than wraps, so the 390 px row takes the
   *  boards' shorter strings (PhoneSettingsProviders). */
  it('takes the phone strings on a phone', async () => {
    mountSettings('phone', '/settings/providers')
    expect(await screen.findByText('Connected as 2002Bishwajeet')).toBeTruthy()
    expect(screen.queryByText(/repositories, reviews, issues/)).toBeNull()
    expect(await screen.findByText(/^Signed in on 0 of \d+ machines$/)).toBeTruthy()
    expect(screen.getByText('nothing uses it yet')).toBeTruthy()
    expect(screen.queryByText(/for a future agent/)).toBeNull()
  })

  it('draws the boundary when the daemon answers something else', async () => {
    mountSettings('desktop', '/settings/providers', { 'GET /api/github': [500, 'boom'] })
    expect(await screen.findByText('Providers could not be drawn')).toBeTruthy()
  })

  it('says only what the category has not said, and draws GitLab as unconnected', async () => {
    mountSettings('desktop', '/settings/providers')
    await screen.findByText('signed in as 2002Bishwajeet · repositories, reviews, issues')
    // §1 row 46: the footnote repeated the category blurb word for word.
    expect(screen.getAllByText(/Yantra signs in to GitHub itself/)).toHaveLength(1)
    expect(screen.getByText('not connected')).toBeTruthy()
  })

  it('walks the device flow: a code, where to type it, and then the login', async () => {
    let polled = 0
    const asked = mountSettings('desktop', '/settings/providers', {
      'GET /api/github': () => [200, ++polled < 2 ? contract.disconnected : contract.github],
      'POST /api/github/login': [200, contract.device],
    })
    expect(await screen.findByText('Not connected')).toBeTruthy()
    fireEvent.click(connect())
    const sheet = within(await screen.findByRole('dialog', { name: 'Connect GitHub' }))
    expect(asked).not.toContain('POST /api/github/login')

    fireEvent.click(sheet.getByRole('button', { name: 'Sign in with GitHub' }))
    expect(await sheet.findByText('WDJB-MJHT')).toBeTruthy()
    expect(sheet.getByRole('link', { name: 'github.com/login/device' }).getAttribute('href')).toBe(
      'https://github.com/login/device',
    )
    expect(sheet.getByText(/the code is good for 15m/)).toBeTruthy()
    expect(sheet.getByText('repo')).toBeTruthy()
    expect(sheet.getByText('read:org')).toBeTruthy()
    expect(sheet.getByText('notifications')).toBeTruthy()

    // The sheet polls at the interval GitHub named; the next answer is the grant.
    expect(await sheet.findByText('Signed in as 2002Bishwajeet.', undefined, { timeout: 8_000 })).toBeTruthy()
    fireEvent.click(sheet.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('signed in as 2002Bishwajeet · repositories, reviews, issues')).toBeTruthy()
    // Nothing that looks like a token crossed.
    expect(document.body.textContent).not.toMatch(/gho_|ghp_/)
  }, 10_000)

  it('draws a refused login in the sheet', async () => {
    mountSettings('desktop', '/settings/providers', {
      'GET /api/github': [200, contract.disconnected],
      'POST /api/github/login': [409, 'a device flow is already waiting for its code'],
    })
    await screen.findByText('Not connected')
    fireEvent.click(connect())
    const sheet = within(await screen.findByRole('dialog', { name: 'Connect GitHub' }))
    fireEvent.click(sheet.getByRole('button', { name: 'Sign in with GitHub' }))
    expect(await sheet.findByText('a device flow is already waiting for its code')).toBeTruthy()
  })

  it('signs out from Manage', async () => {
    let connection: unknown = contract.github
    const asked = mountSettings('desktop', '/settings/providers', {
      'GET /api/github': () => [200, connection],
      'DELETE /api/github': () => {
        connection = contract.disconnected
        return [204]
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }))
    const sheet = within(await screen.findByRole('dialog', { name: 'GitHub' }))
    fireEvent.click(sheet.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(asked).toContain('DELETE /api/github'))
    expect(await screen.findByText('Not connected')).toBeTruthy()
  })

  describe('GitLab and OpenAI', () => {
    it('draw "Later" as a value, never a disabled button (N6)', async () => {
      mountSettings('desktop', '/settings/providers')
      await screen.findByText('not connected')
      const later = screen.getAllByText('Later')
      expect(later).toHaveLength(2)
      for (const one of later) expect(one.tagName).not.toBe('BUTTON')
    })
  })

  describe('GitHub app', () => {
    it('says none is configured, never inventing a value', async () => {
      mountSettings('desktop', '/settings/providers')
      expect(await screen.findByText('None configured')).toBeTruthy()
    })

    it('names the build’s own app apart from a self-hoster’s', async () => {
      mountSettings('desktop', '/settings/providers', {
        'GET /api/github': [200, { ...contract.github, client_id: 'Iv1.builtin', client_id_custom: false }],
      })
      expect(await screen.findByText("Yantra's own · Iv1.builtin")).toBeTruthy()

      cleanup()
      mountSettings('desktop', '/settings/providers', {
        'GET /api/github': [200, { ...contract.github, client_id: 'Iv1.mine', client_id_custom: true }],
      })
      expect(await screen.findByText('Your own · Iv1.mine')).toBeTruthy()
    })

    it('takes the phone strings and drops the id on the row', async () => {
      mountSettings('phone', '/settings/providers', {
        'GET /api/github': [200, { ...contract.github, client_id: 'Iv1.mine', client_id_custom: true }],
      })
      expect(await screen.findByText('Your own')).toBeTruthy()
      expect(screen.queryByText(/Iv1\.mine/)).toBeNull()
    })

    it('writes an id, and the row says so until a read shows it', async () => {
      const asked = mountSettings('desktop', '/settings/providers', {
        'POST /api/github/client-id': (init) => {
          expect(sent(init)).toEqual({ id: 'Iv1.mine' })
          return [204]
        },
      })
      await screen.findByText('None configured')
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      const sheet = within(await screen.findByRole('dialog', { name: 'Use your own GitHub app' }))
      fireEvent.change(sheet.getByLabelText('Client ID'), { target: { value: 'Iv1.mine' } })
      fireEvent.click(sheet.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(asked).toContain('POST /api/github/client-id'))
      expect(await sheet.findByText(/takes it at its next restart/)).toBeTruthy()
      // D7 §4.6: not read back, so the row says what was just saved.
      expect(await screen.findByText('Your own · after yantrad restarts')).toBeTruthy()
      expect(screen.queryByText('None configured')).toBeNull()
    })

    it('draws a refused id in the sheet', async () => {
      mountSettings('desktop', '/settings/providers', {
        'POST /api/github/client-id': [
          400,
          'a client id may only hold letters, digits, `.`, `_` and `-`, up to 64 characters',
        ],
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      const sheet = within(await screen.findByRole('dialog', { name: 'Use your own GitHub app' }))
      fireEvent.change(sheet.getByLabelText('Client ID'), { target: { value: 'has a space' } })
      fireEvent.click(sheet.getByRole('button', { name: 'Save' }))

      expect(await sheet.findByText(/up to 64 characters/)).toBeTruthy()
      // A refusal writes nothing, so the row keeps reading the connection.
      expect(screen.getByText('None configured')).toBeTruthy()
    })

    it('disables Clear with no custom id, and clears one that is set, and the row says so', async () => {
      const asked = mountSettings('desktop', '/settings/providers', {
        'GET /api/github': [200, { ...contract.github, client_id: 'Iv1.mine', client_id_custom: true }],
        'DELETE /api/github/client-id': [204],
      })
      await screen.findByText('Your own · Iv1.mine')
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      const sheet = within(await screen.findByRole('dialog', { name: 'Use your own GitHub app' }))
      fireEvent.click(sheet.getByRole('button', { name: 'Clear' }))

      await waitFor(() => expect(asked).toContain('DELETE /api/github/client-id'))
      expect(await sheet.findByText(/falls back to its own app/)).toBeTruthy()
      expect(await screen.findByText("Yantra's own · after yantrad restarts")).toBeTruthy()
    })

    it('has nothing to clear when the id is not custom', async () => {
      mountSettings('desktop', '/settings/providers')
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      const sheet = within(await screen.findByRole('dialog', { name: 'Use your own GitHub app' }))
      expect((sheet.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true)
    })
  })
})
