import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
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
})
