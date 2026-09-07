import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { mountSettings, unmountSettings } from './harness'

/** GitHub's Connect: GitLab's and OpenAI's are drawn disabled. */
const connect = () => screen.getAllByRole('button', { name: 'Connect' }).find((one) => !(one as HTMLButtonElement).disabled)!

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
    expect((screen.getAllByRole('button', { name: 'Connect' })[0] as HTMLButtonElement).disabled).toBe(true)
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
})
