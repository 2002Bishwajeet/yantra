import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { mount, unmount } from './harness'
import { readPrefs, writePrefs } from './prefs'
import type { FormFactor } from './formFactor'

afterEach(() => {
  cleanup()
  unmount()
})

const published = (data: { version: string; newer: boolean }) => ({
  ...contract.about,
  published: { looked: 'ok' as const, age_seconds: 5, data },
})
const about = (body: unknown, status = 200) => ({ '/api/about': { status, body } })
const snackbar = () => screen.queryByText(/^(Yantra v[\d.]+ is out|A new Yantra Nightly is out)$/)
const account = () => screen.findByRole('button', { name: /^Account/ })
const nothing = async () => {
  await screen.findByRole('main')
  await account()
  await new Promise((done) => setTimeout(done, 30))
  expect(snackbar()).toBeNull()
}

describe('the update snackbar (Y-752)', () => {
  it.each<FormFactor>(['phone', 'desktop'])('says Yantra v0.4.0 is out, at %s, and never says yantrad', async (size) => {
    mount(size, '/machines', { overrides: about(contract.about) })
    const text = await screen.findByText('Yantra v0.4.0 is out')
    expect(text.closest('[role="status"]')?.textContent).not.toMatch(/yantrad/)
  })

  it('names the nightly without a version', async () => {
    mount('desktop', '/machines', { overrides: about({ ...contract.about, channel: 'nightly' }) })
    expect(await screen.findByText('A new Yantra Nightly is out')).toBeTruthy()
  })

  it.each(['/settings/about', '/w/demo', '/m/box/s/main', '/m/box/home'])('is not drawn on %s', async (path) => {
    mount('desktop', path)
    await new Promise((done) => setTimeout(done, 60))
    expect(snackbar()).toBeNull()
    expect(readPrefs().updateDismissed).toBeNull()
  })

  it('shows once: gone after a remount, back for 0.5.0', async () => {
    mount('phone', '/machines')
    await screen.findByText('Yantra v0.4.0 is out')
    expect(readPrefs().updateDismissed).toBe('0.4.0')

    cleanup()
    mount('phone', '/machines')
    await nothing()

    cleanup()
    mount('phone', '/machines', { overrides: about(published({ version: '0.5.0', newer: true })) })
    expect(await screen.findByText('Yantra v0.5.0 is out')).toBeTruthy()
  })

  it('goes on Dismiss', async () => {
    mount('phone', '/machines')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(snackbar()).toBeNull()
  })

  it('goes on Update, which opens About', async () => {
    mount('desktop', '/machines')
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await screen.findByRole('link', { name: 'v0.4.0 is out' })
    expect(location.pathname).toBe('/settings/about')
    expect(snackbar()).toBeNull()
  })

  it.each([
    ['newer is false', published({ version: '0.3.0', newer: false })],
    ['no release was read yet', { ...contract.about, published: { looked: 'never' } }],
    ['the release read failed', { ...contract.about, published: { looked: 'failed', error: 'offline' } }],
    ['an update is running', { ...contract.about, update: { step: 'installing' } }],
  ])('draws neither snackbar nor badge when %s', async (_why, body) => {
    mount('desktop', '/machines', { overrides: about(body) })
    await nothing()
    expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
  })

  it('draws neither when the about read errors, and the page still draws', async () => {
    mount('desktop', '/machines', { overrides: about('boom', 500) })
    await nothing()
    expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Machines' })).toBeTruthy())
  })

  it('draws both when the update failed', async () => {
    mount('desktop', '/machines', { update: true, overrides: about({ ...contract.about, update: { step: 'failed', said: '' } }) })
    expect(await screen.findByText('Yantra v0.4.0 is out')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Update available/ })).toBeTruthy()
  })
})

describe('the update badge (Y-752)', () => {
  it('joins the Account button name, and the About item marks it', async () => {
    mount('desktop', '/machines', { update: true })
    const button = await screen.findByRole('button', { name: /Account.*Update available/ })
    fireEvent.click(button)
    expect(await screen.findByRole('menuitem', { name: /About.*Update available/ })).toBeTruthy()
  })

  it('goes once About is opened, and stays gone after a remount', async () => {
    mount('desktop', '/settings/about', { update: true })
    await screen.findByRole('link', { name: 'v0.4.0 is out' })
    await waitFor(() => expect(readPrefs().updateOpened).toBe('0.4.0'))
    cleanup()
    mount('desktop', '/machines', { update: true })
    await nothing()
    expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
  })

  it('stays when only the snackbar was dismissed', async () => {
    writePrefs({ updateDismissed: '0.4.0' })
    mount('desktop', '/machines', { update: true })
    expect(await screen.findByRole('button', { name: /Account.*Update available/ })).toBeTruthy()
  })
})
