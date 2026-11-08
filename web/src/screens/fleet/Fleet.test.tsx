import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as contract from '@/contract.gen'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderInApp } from '@/test/inApp'
import { WorkRowView } from './Fleet'
import { mount, scenario, unmount } from './harness'

// The route is lazy, so the first mount pays for its chunk; warming it here
// keeps that cost out of the first test's own timeout.
beforeAll(async () => {
  await import('./Fleet')
}, 60_000)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
    // Y-585: the plain cause here, and the raw words on the machine page.
    expect(needs.getByText(/Yantra can’t reach thinkpad over ssh/)).toBeTruthy()
    expect(needs.queryByText(/No route to host/)).toBeNull()
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
    // Y-639: a stopped agent and a session that is gone read the same.
    expect(idle.getAllByText('stopped')).toHaveLength(3)
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
    const review = github.getAllByRole('link', { name: 'Review' })[0]!
    expect(within(review.closest('li') as HTMLElement).getByText(/yantra#245/)).toBeTruthy()
    expect(review.getAttribute('href')).toBe('https://github.com/2002Bishwajeet/yantra/pull/245')
    expect(review.getAttribute('target')).toBe('_blank')
    expect(github.getByRole('heading', { name: 'Reviews' })).toBeTruthy()
    expect(github.getByRole('heading', { name: 'Issues' })).toBeTruthy()
    expect(github.getByRole('link', { name: 'Open 7 on GitHub' })).toBeTruthy()
  })
})

describe('/fleet Start session', () => {
  it('opens a thread on the workspace picked and lands in Chat with the draft in state, not the URL', async () => {
    vi.stubGlobal('WebSocket', class { close() {} addEventListener() {} removeEventListener() {} })
    const asked = mount('desktop', '/fleet')
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    fireEvent.click(await screen.findByRole('button', { name: 'Start session on 2002Bishwajeet/yantra#118' }))
    const dialog = await screen.findByRole('dialog')
    const pick = await within(dialog).findByRole('button', { name: 'yantra-web' }, { timeout: 2000 })
    expect(asked).toContain('POST /api/placement')
    fireEvent.click(pick)
    await waitFor(() => expect(location.pathname).toBe('/w/yantra-web'), { timeout: 2000 })
    expect(asked).toContain('POST /api/workspaces/yantra-web/threads/new')
    expect(location.search).toContain(`thread=${contract.threadOpened.thread}`)
    expect(location.search).not.toContain('Work')
    expect((history.state as { draft?: string }).draft).toBe(contract.threadOpened.draft)
    const composer = await screen.findByRole('combobox', { name: /Message/ }, { timeout: 20_000 })
    expect((composer as HTMLTextAreaElement).value).toBe(contract.threadOpened.draft)
    expect(asked).toContain('POST /api/workspaces/yantra-web/threads')
  })

  it('drops the draft from history.state once Chat has it, and does not bring it back', async () => {
    vi.stubGlobal('WebSocket', class { close() {} addEventListener() {} removeEventListener() {} })
    mount('desktop', '/fleet')
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    fireEvent.click(await screen.findByRole('button', { name: 'Start session on 2002Bishwajeet/yantra#118' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'yantra-web' }, { timeout: 2000 }))
    const composer = (await screen.findByRole('combobox', { name: /Message/ }, { timeout: 20_000 })) as HTMLTextAreaElement
    await waitFor(() => expect((history.state as { draft?: string } | null)?.draft).toBeUndefined())
    expect(composer.value).not.toBe('')
    expect(location.search).toContain(`thread=${contract.threadOpened.thread}`)
  })

  it('reattaches the chat to the thread whose row is clicked', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          urls.push(url)
        }
        close() {}
        send() {}
        addEventListener() {}
        removeEventListener() {}
      },
    )
    const [first, second] = contract.threads
    mount('desktop', `/w/yantra-web?view=chat&thread=${first!.id}`)
    await waitFor(() => expect(urls.some((one) => one.includes(`thread=${first!.id}`))).toBe(true), { timeout: 5000 })
    fireEvent.click(await screen.findByRole('button', { name: /^Threads, / }))
    const rows = await screen.findAllByRole('menuitem', { name: new RegExp(second!.branch.split('/').pop()!) })
    fireEvent.click(rows[0]!)
    await waitFor(() => expect(urls.some((one) => one.includes(`thread=${second!.id}`))).toBe(true), { timeout: 5000 })
  })
})

describe('/fleet on the phone', () => {
  it('folds Idle behind its own row', async () => {
    mount('phone', '/fleet')
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    const idle = region('Idle')
    // Finding 101: the header carried a State whose own word repeated the
    // heading, so the band read "idle IDLE 4" on screen and aloud.
    expect(idle.queryByText('idle')).toBeNull()
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
  it('draws no All set line and keeps the one block that has an action', async () => {
    mount('desktop', '/fleet', scenario('empty'))
    await screen.findByText('No workspaces yet', {}, { timeout: 2000 })
    expect(screen.getByRole('link', { name: 'New session' }).getAttribute('href')).toBe('/new')
    expect(screen.queryByText('All set')).toBeNull()
    // A band with no rows and no action is not a card.
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull()
    expect(screen.queryByText('Nothing needs you')).toBeNull()
    expect(screen.queryByText('Nothing is running')).toBeNull()
    expect(screen.getByRole('region', { name: 'Idle' })).toBeTruthy()
  })
})

describe('/fleet when every workspace is idle', () => {
  it('draws the All set line', async () => {
    const calm = scenario('busy')
    const idle = ['ntfy-relay', 'appliance', 'landing-copy']
    const listed = calm.workspaces as { data: { name: string }[] }
    listed.data = listed.data.filter((one) => idle.includes(one.name))
    calm.attention = { looked: 'ok', data: { reviews: [], issues: [], notifications: 0 } }
    mount('desktop', '/fleet', calm)
    await screen.findByText('All set', {}, { timeout: 2000 })
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull()
  })
})

describe('/fleet when GitHub has nothing to say', () => {
  it('leaves the GitHub block out and keeps the bands that hold rows', async () => {
    const quiet = scenario('busy')
    quiet.attention = { looked: 'ok', data: { reviews: [], issues: [], notifications: 0 } }
    mount('desktop', '/fleet', quiet)
    await screen.findByText(/^looked /, {}, { timeout: 2000 })
    await screen.findByRole('region', { name: 'Running' }, { timeout: 2000 })
    expect(screen.queryByText('All set')).toBeNull()
    expect(screen.queryByText('Nothing is running')).toBeNull()
    expect(screen.queryByRole('region', { name: 'On GitHub' })).toBeNull()
  })
})

describe('/fleet header', () => {
  it('says what the page is for, on the phone too', async () => {
    mount('phone', '/fleet')
    expect(await screen.findByText(/Every workspace on every machine/, {}, { timeout: 2000 })).toBeTruthy()
  })
})

/** Y-585 review: `status.rs` sends a tmux error as `reached: 'no'` too. */
describe('a machine row whose answer was a tmux error', () => {
  it('does not call the machine unreachable or give an ssh cause', async () => {
    const error = 'tmux `has-session` failed with status 1: error connecting to /tmp/tmux-1000/default (Permission denied)'
    await renderInApp(
      <WorkRowView
        row={{ id: 'm:pi', band: 'needs', kind: 'machine', machine: 'pi', workspaces: 1, error }}
        sessions={new Map()}
      />,
    )
    expect(await screen.findByText('not listed')).toBeTruthy()
    expect(screen.getByText('Yantra could not list the sessions on pi.')).toBeTruthy()
    for (const words of [/unreachable/, /can’t reach/, /appliance’s key/, /Permission denied/]) {
      expect(screen.queryByText(words)).toBeNull()
    }
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
