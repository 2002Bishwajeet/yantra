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
    expect(screen.getByText('100.64.0.1:7717')).toBeTruthy()
    expect(screen.getByText('[fd7a:115c:a1e0::1]:7717')).toBeTruthy()
    expect(screen.getByText(location.host)).toBeTruthy()
    expect(screen.queryByText('/etc/yantra/daemon.env')).toBeNull()
    expect(screen.getByRole('link', { name: /Source/ }).getAttribute('href')).toBe('https://github.com/2002Bishwajeet/yantra')
    expect(screen.getByText(/keeps no fleet state/)).toBeTruthy()
  })

  it('says who can open the dashboard, and names the tailnet', async () => {
    mountSettings('desktop', '/settings/about', { 'GET /api/about': [200, { ...contract.about, tailnet: 'home.ts.net' }] })
    expect(await screen.findByText('Only devices on your tailnet')).toBeTruthy()
    expect(await screen.findByText('home.ts.net')).toBeTruthy()
    expect(screen.getByText('No separate login')).toBeTruthy()
  })

  it('never breaks a value inside a word, and draws each address on its own line', async () => {
    mountSettings('desktop', '/settings/about')
    await screen.findByText(/^yantrad/)
    for (const dd of document.querySelectorAll('.settings__fact > dd')) {
      expect(dd.className).not.toMatch(/break-all|m3-wrap/)
      expect((dd as HTMLElement).style.wordBreak).not.toBe('break-all')
    }
    const listens = screen.getByText('Listens on').closest('.settings__fact')!
    expect(within(listens as HTMLElement).getByText('100.64.0.1:7717').getAttribute('title')).toBe('100.64.0.1:7717')
    expect(within(listens as HTMLElement).getByText('[fd7a:115c:a1e0::1]:7717')).toBeTruthy()
  })

  it('draws the boundary when the daemon answers something else', async () => {
    mountSettings('desktop', '/settings/about', { 'GET /api/about': [500, 'boom'] })
    expect(await screen.findByText('About could not be drawn')).toBeTruthy()
  })

  describe('the release channel (Y-662)', () => {
    it('shows the channel and switches it through the daemon', async () => {
      let channel = 'stable'
      let sent: unknown = null
      mountSettings('desktop', '/settings/about', {
        'PUT /api/update/channel': (init) => {
          sent = JSON.parse(String(init?.body))
          channel = 'nightly'
          return [204]
        },
        'GET /api/about': () => [200, { ...contract.about, channel }],
      })
      const group = await screen.findByRole('radiogroup', { name: 'Release channel' })
      const stable = within(group).getByRole('radio', { name: 'Stable' })
      await waitFor(() => expect(stable.getAttribute('aria-checked')).toBe('true'))
      fireEvent.click(within(group).getByRole('radio', { name: 'Nightly' }))
      await waitFor(() => expect(sent).toEqual({ channel: 'nightly' }))
      await waitFor(() =>
        expect(within(group).getByRole('radio', { name: 'Nightly' }).getAttribute('aria-checked')).toBe('true'),
      )
    })

    it('draws a refused switch and keeps the channel it had', async () => {
      mountSettings('desktop', '/settings/about', {
        'PUT /api/update/channel': [409, 'could not write /etc/yantra/channel: Permission denied'],
      })
      const group = await screen.findByRole('radiogroup', { name: 'Release channel' })
      fireEvent.click(within(group).getByRole('radio', { name: 'Nightly' }))
      expect(await screen.findByText('The channel did not change')).toBeTruthy()
      expect(within(group).getByRole('radio', { name: 'Stable' }).getAttribute('aria-checked')).toBe('true')
    })

    it('links the nightly release by its tag', async () => {
      mountSettings('desktop', '/settings/about', {
        'GET /api/about': [
          200,
          {
            ...contract.about,
            channel: 'nightly',
            published: { looked: 'ok', age_seconds: 5, data: { version: '0.4.1-nightly.20261110143205.abc1234', newer: true } },
          },
        ],
      })
      const link = await screen.findByRole('link', { name: 'v0.4.1-nightly.20261110143205.abc1234 is out' })
      expect(link.getAttribute('href')).toBe('https://github.com/2002Bishwajeet/yantra/releases/tag/nightly')
    })

    it('says so when the channel file names no channel', async () => {
      mountSettings('desktop', '/settings/about', { 'GET /api/about': [200, { ...contract.about, channel: null }] })
      expect(await screen.findByText(/names no channel/)).toBeTruthy()
    })
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
  describe('the progress of an update (Y-612)', () => {
    const updating = (update: unknown) => ({ 'GET /api/about': [200, { ...contract.about, update }] as Answer })

    it('draws the bytes received against the total', async () => {
      mountSettings('desktop', '/settings/about', updating(contract.updateDownloading))
      const status = await screen.findByText('Downloading v0.4.0 · 3.1 of 9.8 MB')
      expect(status.closest('[role="status"]')).toBeTruthy()
      const bar = screen.getByRole('progressbar', { name: 'Downloaded' })
      expect(bar.getAttribute('aria-valuenow')).toBe('32')
      expect(bar.getAttribute('aria-valuetext')).toBe('3.1 of 9.8 MB')
      expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull()
    })

    it('draws the bytes alone when the host sent no length', async () => {
      mountSettings('desktop', '/settings/about', updating({ ...contract.updateDownloading, total: null }))
      expect(await screen.findByText('Downloading v0.4.0 · 3.1 MB')).toBeTruthy()
      expect(screen.queryByRole('progressbar')).toBeNull()
    })

    it('names the step after the download', async () => {
      mountSettings('desktop', '/settings/about', updating({ step: 'installing' }))
      expect((await screen.findByRole('status')).textContent).toBe('Installing the release…')
    })

    it('draws a failure with what the unit said and the journal command', async () => {
      mountSettings('desktop', '/settings/about', updating(contract.updateFailed))
      const surface = within(await screen.findByRole('alert'))
      expect(surface.getByText('The update failed')).toBeTruthy()
      expect(surface.getByText('Nothing was installed and nothing restarted.')).toBeTruthy()
      const said = screen.getByText(/does not match SHA256SUMS/)
      expect(said.tagName).toBe('PRE')
      expect(said.textContent).toBe(contract.updateFailed.said)
      expect(screen.getByText('journalctl -u yantra-update')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Update to v0.4.0' })).toBeTruthy()
    })

    it('draws a failure that said nothing without an empty block', async () => {
      mountSettings('desktop', '/settings/about', updating({ step: 'failed', said: '' }))
      expect(await screen.findByText('The update failed')).toBeTruthy()
      expect(document.querySelector('pre')).toBeNull()
    })

    it('follows an update it did not ask for, and offers a reload once the version moved', async () => {
      let reads = 0
      mountSettings('desktop', '/settings/about', {
        'GET /api/about': () => [
          200,
          reads++ === 0 ? { ...contract.about, update: { step: 'verifying' } } : { ...contract.about, version: '0.4.0' },
        ],
      })
      expect(await screen.findByText('Checking the archive against SHA256SUMS…')).toBeTruthy()
      expect(await screen.findByRole('button', { name: 'Reload' }, { timeout: 5_000 })).toBeTruthy()
      expect(screen.getByRole('status').textContent).toContain('yantrad 0.4.0 is running')
    })

    it('asks again after a failure and draws the new run', async () => {
      let asked = false
      mountSettings('desktop', '/settings/about', {
        'POST /api/update': () => {
          asked = true
          return [202]
        },
        'GET /api/about': () => [200, { ...contract.about, update: asked ? { step: 'resolving' } : contract.updateFailed }],
      })
      expect(await screen.findByText('The update failed')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Update to v0.4.0' }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Update' }))
      expect(await screen.findByText('Finding the current release…', {}, { timeout: 5_000 })).toBeTruthy()
      expect(screen.queryByText('The update failed')).toBeNull()
    })
  })
})
