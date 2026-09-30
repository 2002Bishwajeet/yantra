import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { mountSettings, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

describe('About', () => {
  it('says which daemon this is, and where it is reached', async () => {
    mountSettings('desktop', '/settings/about')
    expect((await screen.findByText(/^yantrad/)).textContent).toBe('yantrad 0.1.0 · built 6 Sep · running')
    expect(screen.getByText('aarch64-unknown-linux-musl')).toBeTruthy()
    expect(screen.getByText('1d 0h')).toBeTruthy()
    expect(screen.getByText('100.64.0.1:7717 · [fd7a:115c:a1e0::1]:7717')).toBeTruthy()
    expect(screen.getByText(location.host)).toBeTruthy()
    expect(screen.getByText('/etc/yantra/daemon.env')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Source/ }).getAttribute('href')).toBe('https://github.com/2002Bishwajeet/yantra')
    expect(screen.getByText(/persists nothing about the fleet/)).toBeTruthy()
  })

  it('draws the boundary when the daemon answers something else', async () => {
    mountSettings('desktop', '/settings/about', { 'GET /api/about': [500, 'boom'] })
    expect(await screen.findByText('About could not be drawn')).toBeTruthy()
  })

  describe('the published release (Y-367)', () => {
    const publishing = (published: unknown) => ({ 'GET /api/about': [200, { ...contract.about, published }] as [number, unknown] })

    it('links a newer release', async () => {
      mountSettings('desktop', '/settings/about')
      const link = await screen.findByRole('link', { name: 'v0.4.0 is out' })
      expect(link.getAttribute('href')).toBe('https://github.com/2002Bishwajeet/yantra/releases/tag/v0.4.0')
    })

    it('says current when the running build is the newest', async () => {
      mountSettings('desktop', '/settings/about', publishing({ looked: 'ok', age_seconds: 5, data: { version: '0.1.0', newer: false } }))
      expect(await screen.findByText('0.1.0 · current')).toBeTruthy()
      expect(screen.queryByRole('link', { name: /is out/ })).toBeNull()
    })

    it('says nobody has asked before the first read', async () => {
      mountSettings('desktop', '/settings/about', publishing({ looked: 'never' }))
      expect(await screen.findByText('not asked yet')).toBeTruthy()
    })

    it('shows a failed read with the daemon’s words, and never says current', async () => {
      mountSettings(
        'desktop',
        '/settings/about',
        publishing({ looked: 'failed', age_seconds: 5, error: 'GitHub answered 403 to /releases/latest' }),
      )
      expect(await screen.findByText('The newest release could not be read')).toBeTruthy()
      expect(screen.getByText('GitHub answered 403 to /releases/latest')).toBeTruthy()
      expect(screen.queryByText(/current/)).toBeNull()
    })

    it('draws the boundary when the daemon predates the field', async () => {
      const { published: _, ...older } = contract.about
      mountSettings('desktop', '/settings/about', { 'GET /api/about': [200, older] })
      expect(await screen.findByText('About could not be drawn')).toBeTruthy()
    })
  })
})
