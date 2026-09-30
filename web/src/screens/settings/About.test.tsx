import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { type Answer, type Answers, mountSettings, unmountSettings } from './harness'

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

  describe('applying an update (Y-368)', () => {
    const current = { looked: 'ok', age_seconds: 5, data: { version: '0.1.0', newer: false } }

    async function ask(answers: Answers) {
      const asked = mountSettings('desktop', '/settings/about', answers)
      fireEvent.click(await screen.findByRole('button', { name: 'Update to v0.4.0' }))
      const dialog = within(await screen.findByRole('dialog'))
      fireEvent.click(dialog.getByRole('button', { name: 'Update' }))
      return { asked, dialog }
    }

    it('offers the newer release only', async () => {
      mountSettings('desktop', '/settings/about', { 'GET /api/about': [200, { ...contract.about, published: current }] })
      await screen.findByText('0.1.0 · current')
      expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull()
    })

    it('says what the restart ends before it asks', async () => {
      mountSettings('desktop', '/settings/about')
      fireEvent.click(await screen.findByRole('button', { name: 'Update to v0.4.0' }))
      const dialog = within(await screen.findByRole('dialog'))
      expect(dialog.getByText(/A chat turn in flight dies/)).toBeTruthy()
      expect(dialog.getByText(/Open terminals reconnect to the same sessions/)).toBeTruthy()
    })

    it('asks, waits for the daemon to come back, and offers a reload once the version moved', async () => {
      let updated = false
      const { asked } = await ask({
        'POST /api/update': () => {
          updated = true
          return [202]
        },
        'GET /api/about': () => [200, updated ? { ...contract.about, version: '0.4.0', published: current } : contract.about],
      })
      expect(await screen.findByText(/Updating from/)).toBeTruthy()
      expect(asked).toContain('POST /api/update')
      expect(await screen.findByRole('button', { name: 'Reload' }, { timeout: 5_000 })).toBeTruthy()
      expect(screen.getByRole('status').textContent).toContain('yantrad 0.4.0 is running')
    })

    // One poll and both of Query's retries fail, which is the whole restart.
    it('keeps the facts on screen while the daemon restarts', async () => {
      let reads = 0
      await ask({
        'POST /api/update': [202],
        'GET /api/about': (): Answer => (reads++ === 0 ? [200, contract.about] : [502, '']),
      })
      expect(await screen.findByText(/Updating from/)).toBeTruthy()
      await waitFor(() => expect(reads).toBeGreaterThanOrEqual(4), { timeout: 8_000 })
      await new Promise((done) => setTimeout(done, 100))
      expect(screen.queryByText('About could not be drawn')).toBeNull()
      expect(screen.getByText('aarch64-unknown-linux-musl')).toBeTruthy()
    }, 12_000)

    const refusals: [string, Answer | (() => Answer), string, RegExp][] = [
      ['a node that is not the owner’s', [403, 'node n1 is on this tailnet but is not yours'], 'This device may not update the daemon', /not on a node this tailnet's owner holds/],
      ['a tailscale that cannot answer', [503, 'could not establish who is calling: tailscaled'], 'The daemon could not tell who is asking', /Nothing could be asked/],
      [
        'a box with no updater',
        [409, 'this box has no /usr/local/bin/yantra-update, so it was not installed by install.sh'],
        'This box cannot update itself',
        /the daemon declined/,
      ],
      [
        'a daemon that does not answer',
        () => {
          throw new TypeError('Failed to fetch')
        },
        'The daemon did not answer, so no update was asked for',
        /The daemon did not answer\./,
      ],
    ]

    it.each(refusals)('draws %s as its own surface', async (_, answered, title, sentence) => {
      const { dialog } = await ask({ 'POST /api/update': answered })
      const surface = within(await dialog.findByRole('alert'))
      expect(surface.getByText(title)).toBeTruthy()
      expect(surface.getByText(sentence)).toBeTruthy()
      expect(screen.queryByText(/Updating from/)).toBeNull()
    })

    it('names install.sh when the box has no updater', async () => {
      const { dialog } = await ask({
        'POST /api/update': [409, 'this box has no /usr/local/bin/yantra-update, so it was not installed by install.sh'],
      })
      expect(await dialog.findByText(/install\.sh/)).toBeTruthy()
    })
  })
})
