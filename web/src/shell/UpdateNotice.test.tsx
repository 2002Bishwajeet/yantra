import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { mount, unmount } from './harness'
import { readPrefs } from './prefs'
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
const notice = () => screen.queryByRole('region', { name: 'Update available' })
const nothing = async () => {
  await screen.findByRole('main')
  await screen.findAllByText('Machines')
  await new Promise((done) => setTimeout(done, 30))
  expect(notice()).toBeNull()
}

describe('the update notice (Y-712)', () => {
  it.each<FormFactor>(['phone', 'desktop'])('says Update to v0.4.0 on a page other than About, at %s', async (size) => {
    mount(size, '/machines', { overrides: about(contract.about) })
    expect(await screen.findByText('Update to v0.4.0')).toBeTruthy()
    expect(screen.getByText(/A newer yantrad is out on the stable channel/)).toBeTruthy()
  })

  it('opens About from Update', async () => {
    mount('desktop', '/machines')
    fireEvent.click(await screen.findByRole('link', { name: 'Update' }))
    await screen.findByRole('link', { name: /is out/ })
    expect(location.pathname).toBe('/settings/about')
  })

  it('stays hidden on About, where the Update button is', async () => {
    mount('desktop', '/settings/about')
    await screen.findByRole('link', { name: 'v0.4.0 is out' })
    expect(notice()).toBeNull()
  })

  it('goes when dismissed, stays gone after a remount, and returns for a newer version', async () => {
    mount('phone', '/machines')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(notice()).toBeNull()
    expect(readPrefs().updateDismissed).toBe('0.4.0')

    cleanup()
    mount('phone', '/machines')
    await nothing()

    cleanup()
    mount('phone', '/machines', { overrides: about(published({ version: '0.5.0', newer: true })) })
    expect(await screen.findByText('Update to v0.5.0')).toBeTruthy()
  })

  it.each([
    ['newer is false', published({ version: '0.3.0', newer: false })],
    ['no release was read yet', { ...contract.about, published: { looked: 'never' } }],
    ['the release read failed', { ...contract.about, published: { looked: 'failed', error: 'offline' } }],
    ['an update is running', { ...contract.about, update: { step: 'installing' } }],
  ])('draws nothing when %s', async (_why, body) => {
    mount('desktop', '/machines', { overrides: about(body) })
    await nothing()
  })

  it('draws again when the update failed', async () => {
    mount('desktop', '/machines', { overrides: about({ ...contract.about, update: { step: 'failed', said: '' } }) })
    expect(await screen.findByText('Update to v0.4.0')).toBeTruthy()
  })

  it('draws nothing when the about read errors, and the page still draws', async () => {
    mount('desktop', '/machines', { overrides: about('boom', 500) })
    await nothing()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Machines' })).toBeTruthy())
  })
})
