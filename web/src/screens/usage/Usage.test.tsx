import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { mount, scenario, unmount } from '@/screens/fleet/harness'

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

describe('/usage on the busy fleet', () => {
  it('reads nothing until a person asks, and has no time window yet', async () => {
    const asked = mount('desktop', '/usage', scenario('busy'))
    await screen.findByRole('heading', { level: 1, name: 'Usage' }, { timeout: 2000 })
    expect(await screen.findByRole('button', { name: 'Read spend' })).toBeTruthy()
    expect(screen.getByText('Nothing read yet')).toBeTruthy()
    expect(asked.some((one) => one.includes('/tokens'))).toBe(false)
    // Y-354 brings Today / 7 days / 30 days.
    expect(screen.queryByRole('button', { name: '7 days' })).toBeNull()
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
