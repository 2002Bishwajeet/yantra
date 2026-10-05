import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, type Scenario, scenario, unmount } from '@/screens/fleet/harness'

// The route is lazy, so the first mount pays for its chunk; warming it here
// keeps that cost out of the first test's own timeout.
beforeAll(async () => {
  await import('./Usage')
}, 60_000)

afterEach(() => {
  cleanup()
  unmount()
})

const card = (name: string) => within(screen.getByRole('region', { name }))

/** What each `/tokens` POST carried as its window, `null` for no body. */
function sinces(): (string | null)[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([path]) => String(path).endsWith('/tokens'))
    .map(([, init]) =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { since: string }).since : null,
    )
}

function refusing(status: number, text: string): Scenario {
  const state = scenario('busy')
  state.refuse = { status, text }
  return state
}

const pick = async (name: string) =>
  fireEvent.click(await screen.findByRole('radio', { name }, { timeout: 2000 }))

describe('/usage on the busy fleet', () => {
  it('reads nothing until a person asks, and the window starts at All', async () => {
    const asked = mount('desktop', '/usage', scenario('busy'))
    await screen.findByRole('heading', { level: 1, name: 'Usage' }, { timeout: 2000 })
    expect(await screen.findByRole('button', { name: 'Read spend' })).toBeTruthy()
    expect(screen.getByText('Nothing read yet')).toBeTruthy()
    expect(asked.some((one) => one.includes('/tokens'))).toBe(false)
    const window = screen.getByRole('radiogroup', { name: 'Window' })
    expect(within(window).getAllByRole('radio').map((one) => one.textContent)).toEqual([
      'All',
      'Today',
      '7 days',
      '30 days',
    ])
    expect(within(window).getByRole('radio', { name: 'All', checked: true })).toBeTruthy()
    expect(screen.getByText('as read · every response in each transcript')).toBeTruthy()
  })

  it('fans out one read a workspace and draws both breakdowns', async () => {
    const asked = mount('desktop', '/usage', scenario('busy'))
    fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
    await screen.findByRole('region', { name: 'By workspace' })

    expect(asked.filter((one) => one.includes('/tokens'))).toHaveLength(10)
    expect(asked).toContain('POST /api/workspaces/landing/tokens')

    const workspaces = card('By workspace')
    expect(workspaces.getByText('10 workspaces read')).toBeTruthy()
    expect(workspaces.getAllByText('$5.46')).toHaveLength(10)

    const models = card('By model')
    expect(models.getByText('claude-opus-5-20260115')).toBeTruthy()
    // Y-373: the opus fixture's own counts, read by ten workspaces.
    expect(models.getByText('94,120 in · 843,100 out · 48,120,030 cache read')).toBeTruthy()
    // `unknown` costs null in every read, so the group has no figure at all.
    expect(models.getByText('unpriced')).toBeTruthy()
  })

  it('draws a proportion bar against the dearest row, not against a sum', async () => {
    mount('desktop', '/usage', scenario('busy'))
    fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
    await screen.findByRole('region', { name: 'By workspace' })
    const bars = card('By workspace').getAllByRole('progressbar')
    expect(bars).toHaveLength(10)
    // Every busy workspace reads $5.46, so each is the whole of the dearest.
    expect(bars[0]!.getAttribute('aria-valuenow')).toBe('100')
    expect(bars[0]!.getAttribute('aria-label')).toBe('$5.46 of the most spent, $5.46')
  })

  /* Finding 100: the fan-out was component state, so a walk to another screen
     threw away ten ssh round trips. */
  it('keeps the read after a walk to another screen and back', async () => {
    mount('desktop', '/usage', scenario('busy'))
    fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
    await screen.findByRole('region', { name: 'By workspace' })

    fireEvent.click(screen.getAllByRole('link', { name: 'Fleet' })[0]!)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' }, { timeout: 2000 })
    fireEvent.click(screen.getAllByRole('link', { name: 'Usage' })[0]!)

    expect(await screen.findByRole('button', { name: 'Read again' }, { timeout: 2000 })).toBeTruthy()
    expect(card('By workspace').getByText('10 workspaces read')).toBeTruthy()
  })

  it('draws the sessions table, and no fleet total anywhere', async () => {
    mount('desktop', '/usage', scenario('busy'))
    fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
    const sessions = within(await screen.findByRole('region', { name: 'Sessions' }))
    const table = sessions.getByRole('table')
    for (const column of ['Workspace', 'Machine', 'Output', 'Cache reads', 'Cost']) {
      expect(within(table).getByRole('columnheader', { name: column })).toBeTruthy()
    }
    expect(within(table).getAllByRole('row')).toHaveLength(11)
    expect(within(table).queryByRole('columnheader', { name: /total/i })).toBeNull()
    expect(screen.queryByText(/^Total/i)).toBeNull()
    expect(screen.getByText(/there is no fleet total/)).toBeTruthy()
  })
})

describe('/usage on the phone', () => {
  it('keeps three columns and the same table', async () => {
    mount('phone', '/usage', scenario('busy'))
    fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3)
    expect(within(table).queryByRole('columnheader', { name: 'Cache reads' })).toBeNull()
  })
})

describe('/usage when a read is refused', () => {
  it('names the workspace and the daemon’s own words in place', async () => {
    mount('desktop', '/usage', scenario('refused'))
    fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
    const workspaces = within(await screen.findByRole('region', { name: 'By workspace' }))
    expect(workspaces.getByText('Nothing was counted')).toBeTruthy()
    expect(
      workspaces.getAllByText(/node biswas-iphone is on this tailnet but is not yours/).length,
    ).toBe(10)
  })
})

describe('/usage on an empty fleet', () => {
  it('says there is no spend yet', async () => {
    mount('desktop', '/usage', scenario('empty'))
    expect(await screen.findByText('No spend yet', {}, { timeout: 2000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Read spend' })).toBeNull()
  })
})

describe('/usage when nothing can be reached', () => {
  it('is one page-sized error with Try again', async () => {
    mount('desktop', '/usage', scenario('unreachable'))
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(alert.textContent).toContain('Nothing here can be reached')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('/usage time windows (Y-354)', () => {
  it('sends no body for All, and an instant for each other window', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 5, 15, 30) })
    try {
      mount('desktop', '/usage', scenario('busy'))
      const read = async () => {
        fireEvent.click(await screen.findByRole('button', { name: /^Read (spend|again)$/ }, { timeout: 2000 }))
        await screen.findByRole('region', { name: 'By workspace' })
      }
      await read()
      expect(sinces()).toEqual(Array(10).fill(null))

      const expected: [string, string][] = [
        ['Today', new Date(2026, 9, 5).toISOString()],
        ['7 days', new Date(2026, 8, 28, 15, 30).toISOString()],
        ['30 days', new Date(2026, 8, 5, 15, 30).toISOString()],
      ]
      for (const [name, since] of expected) {
        vi.mocked(fetch).mockClear()
        await pick(name)
        await read()
        expect(sinces(), name).toEqual(Array(10).fill(since))
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads nothing on a switch, and each window keeps its own rows', async () => {
    mount('desktop', '/usage', scenario('busy'))
    fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
    await screen.findByRole('region', { name: 'By workspace' })

    vi.mocked(fetch).mockClear()
    await pick('7 days')
    expect(await screen.findByText('Nothing read yet')).toBeTruthy()
    expect(screen.getByText('as read · responses in the last 7 days')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Read spend' })).toBeTruthy()
    expect(location.search).toBe('?window=7d')

    await pick('All')
    expect(await screen.findByRole('region', { name: 'By workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Read again' })).toBeTruthy()
    expect(sinces()).toEqual([])
  })

  it('opens on the window the URL names, and on All for one it does not know', async () => {
    mount('desktop', '/usage?window=30d', scenario('busy'))
    expect(await screen.findByRole('radio', { name: '30 days', checked: true }, { timeout: 2000 })).toBeTruthy()
    cleanup()
    unmount()
    mount('desktop', '/usage?window=forever', scenario('busy'))
    expect(await screen.findByRole('radio', { name: 'All', checked: true }, { timeout: 2000 })).toBeTruthy()
  })

  for (const name of ['All', 'Today', '7 days', '30 days']) {
    it(`names a refused read in place under ${name}`, async () => {
      const said = 'Failed to deserialize the JSON body into the target type: since'
      mount('desktop', '/usage', refusing(400, said))
      await pick(name)
      fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
      const workspaces = within(await screen.findByRole('region', { name: 'By workspace' }))
      expect(workspaces.getByText('Nothing was counted')).toBeTruthy()
      await waitFor(() => expect(workspaces.getAllByText(said)).toHaveLength(10))
    })

    it(`reads a 409 as nothing to count, not a failure, under ${name}`, async () => {
      mount('desktop', '/usage', refusing(409, 'no transcript for /srv/site yet'))
      await pick(name)
      fireEvent.click(await screen.findByRole('button', { name: 'Read spend' }, { timeout: 2000 }))
      const workspaces = within(await screen.findByRole('region', { name: 'By workspace' }))
      expect(workspaces.getAllByText('no transcript for /srv/site yet')).toHaveLength(10)
    })
  }
})
