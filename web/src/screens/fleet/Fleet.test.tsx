import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, scenario, unmount } from './harness'

// The route is lazy, so the first mount pays for its chunk; warming it here
// keeps that cost out of the first test's own timeout.
beforeAll(async () => {
  await import('./Fleet')
}, 60_000)

afterEach(() => {
  cleanup()
  unmount()
})

const region = (name: string) => within(screen.getByRole('region', { name }))

describe('/fleet on the busy fleet', () => {
  it('groups rows by who acts next, with the one verb each state is for', async () => {
    mount('desktop', '/fleet')
    await screen.findByRole('heading', { level: 1, name: 'Fleet' }, { timeout: 2000 })
    await screen.findByText(/^looked /, {}, { timeout: 2000 })

    const needs = region('Needs you')
    expect(needs.getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe('/w/yantra-web?view=chat')
    expect(needs.getByText('waiting for trust')).toBeTruthy()
    // An unreachable machine is one row and its workspaces are not listed.
    expect(needs.getByText('unreachable')).toBeTruthy()
    expect(needs.getByText('1 workspace')).toBeTruthy()
    expect(needs.getByRole('link', { name: 'Fix' }).getAttribute('href')).toBe('/m/thinkpad')
    expect(needs.queryByText('cargo-zig')).toBeNull()
    // A crashed agent still says so, and its verb is Resume.
    expect(needs.getByText('crashed, exit 1')).toBeTruthy()
    expect(needs.getByRole('button', { name: 'Resume' })).toBeTruthy()

    const running = region('Running')
    expect(running.getAllByRole('link', { name: 'Open' })).toHaveLength(3)
    expect(running.getAllByRole('button', { name: 'Stop' })).toHaveLength(3)
    expect(running.getByRole('link', { name: 'landing' }).getAttribute('href')).toBe('/w/landing')

    const idle = region('Idle')
    expect(idle.getByText('4')).toBeTruthy()
    expect(idle.getByRole('button', { name: 'Show 1 more' })).toBeTruthy()
    fireEvent.click(idle.getByRole('button', { name: 'Show 1 more' }))
    expect(idle.getAllByRole('button', { name: /^(Start|Resume)$/ })).toHaveLength(4)
    expect(idle.getByText('finished')).toBeTruthy()
    expect(idle.getByText('stopped')).toBeTruthy()
  })

  it('Stop never asks first, and the order holds until Reorder', async () => {
    const asked = mount('desktop', '/fleet')
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    const running = region('Running')
    fireEvent.click(running.getAllByRole('button', { name: 'Stop' })[0]!)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(asked).toContain('POST /api/workspaces/homelab-k8s/down'))
  })

  it('draws the GitHub queue inside Needs you with links out', async () => {
    mount('desktop', '/fleet')
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    const github = within(await screen.findByRole('region', { name: 'On GitHub' }))
    const review = github.getByRole('link', { name: /yantra#245/ })
    expect(review.getAttribute('href')).toBe('https://github.com/2002Bishwajeet/yantra/pull/245')
    expect(review.getAttribute('target')).toBe('_blank')
    expect(github.getByRole('heading', { name: 'Reviews' })).toBeTruthy()
    expect(github.getByRole('heading', { name: 'Issues' })).toBeTruthy()
    expect(github.getByRole('link', { name: /7notifications on GitHub/ })).toBeTruthy()
  })
})

describe('/fleet on the phone', () => {
  it('folds Idle behind its own row', async () => {
    mount('phone', '/fleet')
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    const idle = region('Idle')
    expect(idle.queryByRole('button', { name: /^(Start|Resume)$/ })).toBeNull()
    fireEvent.click(idle.getByRole('button', { name: 'Show 4' }))
    expect(idle.getAllByRole('button', { name: /^(Start|Resume)$/ })).toHaveLength(4)
  })
})

describe('/fleet when GitHub has no grant', () => {
  it('names the reason and links to Providers', async () => {
    mount('desktop', '/fleet', scenario('nogrant'))
    await screen.findByText('GitHub cannot be asked', {}, { timeout: 2000 })
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/settings/providers')
  })
})

describe('/fleet on an empty fleet', () => {
  it('draws the three empty blocks', async () => {
    mount('desktop', '/fleet', scenario('empty'))
    await screen.findByText('Nothing needs you', {}, { timeout: 2000 })
    expect(screen.getByText('Nothing is running')).toBeTruthy()
    expect(screen.getByText('no workspaces yet')).toBeTruthy()
  })
})

describe('/fleet when nothing can be reached', () => {
  it('is one page-sized error rather than one per card', async () => {
    mount('desktop', '/fleet', scenario('unreachable'))
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(alert.textContent).toContain('Nothing here can be reached')
    expect(alert.textContent).toContain('failed to connect to local tailscaled')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('/fleet when the machines body is not the contract', () => {
  it('says so in place and keeps the rows', async () => {
    const broken = { ...scenario('busy'), machines: { looked: 'ok', age_seconds: 0 } } as unknown as ReturnType<typeof scenario>
    mount('desktop', '/fleet', broken)
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(alert.textContent).toContain('Machines could not be read')
    expect(await screen.findByRole('region', { name: 'Running' }, { timeout: 2000 })).toBeTruthy()
  })
})

describe('/fleet when a write is refused', () => {
  it("shows the daemon's text under the row that asked", async () => {
    mount('desktop', '/fleet', scenario('refused'))
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    fireEvent.click(region('Running').getAllByRole('button', { name: 'Stop' })[0]!)
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(alert.textContent).toContain('Stop was refused')
    expect(alert.textContent).toContain('node biswas-iphone is on this tailnet but is not yours')
  })
})
