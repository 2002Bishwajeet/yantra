import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HOLD_MS, NOT_REACHED, POLL_MS, REFUSED } from '@/api/client'
import { looked } from '@/api/fixtures'
import * as contract from '@/contract.gen'
import type { FormFactor } from './formFactor'
import { mount, unmount } from './harness'
import { NotReached, causeOf } from './NotReached'
import { notReached } from './reached'

afterEach(() => {
  cleanup()
  unmount()
})

const dead = (why: string) => looked.failed<unknown>(`${NOT_REACHED}: ${why}`)

describe('what counts as the daemon not being reached', () => {
  it('collapses reads that all failed before the daemon answered', () => {
    expect(notReached([dead('HTTP 502'), dead('HTTP 502'), dead('HTTP 502')])).toBe(
      `${NOT_REACHED}: HTTP 502`,
    )
  })

  /** The sharp one: `tailscaled` is down on the daemon's own box, so the
   *  daemon answered and its look failed. That is fleet news, and the screen
   *  that owns the class keeps it. */
  it('is null when the daemon answered and said its own look failed', () => {
    const said = looked.failed<unknown>('`tailscale status --json` failed')
    expect(notReached([said, said, said])).toBeNull()
  })

  it('keeps reads the daemon refused, because the daemon answered for this device', () => {
    const refused = looked.failed<unknown>(`${REFUSED}: the account x may only join itself`)
    expect(notReached([refused, refused, refused])).toBe(`${REFUSED}: the account x may only join itself`)
  })

  it('is null unless every read agrees', () => {
    expect(notReached([dead('HTTP 502'), dead('TypeError: Failed to fetch')])).toBeNull()
    expect(notReached([dead('HTTP 502'), { looked: 'pending' }])).toBeNull()
    expect(notReached([dead('HTTP 502'), looked.ok<unknown>([])])).toBeNull()
    expect(notReached([])).toBeNull()
  })
})

describe('the screen a dead daemon draws', () => {
  it('replaces the route with one board, and draws no fleet data', async () => {
    mount('desktop', '/', { down: true })
    const alert = await screen.findByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    const board = within(alert)
    expect(board.getByText('Yantra')).toBeTruthy()
    expect(board.getByRole('heading', { name: 'yantrad is not answering' })).toBeTruthy()
    expect(board.getByText(/its daemon did not/)).toBeTruthy()
    // One button, and the rest is behind Details.
    expect(board.getAllByRole('button').map((one) => one.textContent)).toEqual(['Try again', 'Details'])
    expect(board.queryByRole('link', { name: 'Open Tailscale' })).toBeNull()
    for (const hidden of [`${NOT_REACHED}: HTTP 502`, /retrying every 5 s/, /off the tailnet/]) {
      expect(board.queryByText(hidden)).toBeNull()
    }
    fireEvent.click(board.getByRole('button', { name: 'Details' }))
    expect(board.getByText(`${NOT_REACHED}: HTTP 502`)).toBeTruthy()
    expect(board.getByText(/retrying every 5 s/)).toBeTruthy()

    // Nothing of the fleet: no Dashboard, and no rail listing sessions.
    expect(screen.queryByRole('heading', { level: 1, name: 'Dashboard' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()
  })

  it('leaves the navigation in place so a person can still move', async () => {
    mount('desktop', '/', { down: true })
    await screen.findByRole('alert')
    const nav = within(screen.getByRole('navigation', { name: 'Main' }))
    for (const label of ['Dashboard', 'Fleet', 'Machines', 'Usage']) {
      expect(nav.getByRole('link', { name: label })).toBeTruthy()
    }
  })

  /** Settings reads nothing swept of its own, and the owner still asked for
   *  one screen: the daemon is down for Settings as much as for the fleet. */
  it('stands in front of a settings route too', async () => {
    mount('desktop', '/settings/providers', { down: true })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'yantrad is not answering' })).toBeTruthy()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByText(/Providers could not be drawn/)).toBeNull()
  })

  /** The status reads wait for the workspace list, so their first ask comes
   *  after the tap and fails too. Try again asks them again, not the next poll. */
  it('asks the status reads again when Try again brings the daemon back', async () => {
    const asked = mount('desktop', '/', { flaky: true })
    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    const statuses = contract.workspaces.data.map((one) => `GET /api/workspaces/${one.name}/status`)
    await waitFor(() => {
      for (const status of statuses) expect(asked.filter((one) => one === status)).toHaveLength(2)
    })
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
  })

  it('draws nothing of itself while the daemon answers', async () => {
    mount('desktop', '/')
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
    expect(screen.queryByText('yantrad is not answering')).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Sessions' })).toBeTruthy()
  })
})

/** Y-744: a page that has its content keeps it while the daemon does not
 *  answer, and wears one mark. The board waits for `HOLD_MS` of silence. */
describe('a daemon that stops answering under a page that drew its fleet', () => {
  const DEAD = { status: 502, body: '' }
  const NAME = contract.machines.data[0].name
  const CLASSES = ['GET /api/machines', 'GET /api/workspaces', 'GET /api/sessions']
  let wire: { status: number; body?: unknown } | undefined

  // `held` reads `Date.now()`, and the polls are timers: both are faked, and
  // real time still moves them so a `findBy` can wait for a lazy chunk.
  beforeEach(() => {
    wire = undefined
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    focusManager.setFocused(undefined)
  })

  const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
  const marked = () => !screen.getByText('Reconnecting').hidden
  const open = async (size: FormFactor = 'desktop') => {
    const asked = mount(size, '/machines', { wire: () => wire })
    await screen.findByRole('heading', { name: NAME })
    return asked
  }

  it.each(['phone', 'tablet', 'desktop'] as const)('keeps the %s page through one failed poll, and marks it', async (size) => {
    await open(size)
    expect(marked()).toBe(false)

    wire = DEAD
    await pass(POLL_MS)
    expect(screen.getByRole('heading', { name: NAME })).toBeTruthy()
    expect(marked()).toBe(true)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(screen.queryByText('yantrad is not answering')).toBeNull()

    wire = undefined
    await pass(POLL_MS)
    expect(marked()).toBe(false)
    expect(screen.getByRole('heading', { name: NAME })).toBeTruthy()
  })

  /** A reading stays fresh for 30 s, and a tab hidden for less than that used
   *  to wait for the next poll. */
  it('asks at once when the tab is seen again, however fresh its readings are', async () => {
    const asked = await open()
    act(() => focusManager.setFocused(false))
    const before = asked.length
    act(() => focusManager.setFocused(true))
    await pass(50)
    expect(asked.slice(before)).toEqual(expect.arrayContaining(CLASSES))
  })

  /** The owner's screenshot: the tab sat hidden, and the first reads after it
   *  came back met 502s. Nothing was asked while it was hidden, so the silence
   *  starts when the tab is seen again, and the tab asks at once. */
  it('keeps the page through a burst of failures after the tab was hidden', async () => {
    const asked = await open()
    wire = DEAD
    await pass(POLL_MS)
    expect(marked()).toBe(true)

    act(() => focusManager.setFocused(false))
    await pass(10 * 60_000)
    const before = asked.length
    act(() => focusManager.setFocused(true))
    await pass(50)
    expect(asked.slice(before)).toEqual(expect.arrayContaining(CLASSES))
    expect(screen.getByRole('heading', { name: NAME })).toBeTruthy()
    expect(marked()).toBe(true)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)

    wire = undefined
    await pass(POLL_MS)
    expect(marked()).toBe(false)
  })

  it('draws the one board only after the daemon has failed for the set time', async () => {
    await open()
    wire = DEAD
    await pass(HOLD_MS - POLL_MS)
    expect(screen.getByRole('heading', { name: NAME })).toBeTruthy()
    expect(marked()).toBe(true)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)

    await pass(3 * POLL_MS)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'yantrad is not answering' })).toBeTruthy()
    expect(screen.queryByText(NAME)).toBeNull()
    expect(marked()).toBe(false)

    wire = undefined
    await pass(POLL_MS)
    expect(await screen.findByRole('heading', { name: NAME })).toBeTruthy()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(marked()).toBe(false)
  })

  it('draws a refusal at once, because the daemon answered', async () => {
    await open()
    wire = { status: 403, body: 'the account x may only join itself' }
    await pass(POLL_MS)
    expect(within(screen.getByRole('alert')).getByRole('heading', { name: 'Yantra refused this device' })).toBeTruthy()
    expect(screen.queryByText(NAME)).toBeNull()
    expect(marked()).toBe(false)
  })
})

describe('the cause the screen names', () => {
  it('blames the daemon when the proxy answered for it', () => {
    for (const code of [502, 503, 504]) {
      expect(causeOf(`${NOT_REACHED}: HTTP ${code}`)).toMatchObject({ daemon: true, title: 'yantrad is not answering' })
    }
  })

  it('blames this device when the fetch failed', () => {
    expect(causeOf('TypeError: Failed to fetch')).toMatchObject({ daemon: false, title: 'This device cannot reach Yantra' })
    expect(causeOf(`${NOT_REACHED}: HTTP 500`).daemon).toBe(false)
  })

  /** The walk on the real fleet: every read was 403 from the hub's own
   *  address, and the screen said to turn Tailscale on. */
  it('names the HTTPS address, not Tailscale, when the daemon refused its own address', () => {
    const own = `${REFUSED}: a request from this machine's own address may not act, because any account here could have sent it.`
    expect(causeOf(own)).toMatchObject({ daemon: true, title: 'Open Yantra at its HTTPS address' })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotReached since={null} why={own} />
      </QueryClientProvider>,
    )
    const board = within(screen.getByRole('alert'))
    expect(board.getByRole('heading', { name: 'Open Yantra at its HTTPS address' })).toBeTruthy()
    expect(board.getByText(/Open the dashboard's https:\/\/ address/)).toBeTruthy()
    expect(board.queryByRole('link', { name: 'Open Tailscale' })).toBeNull()
    expect(board.queryByText(/any account here/)).toBeNull()
    fireEvent.click(board.getByRole('button', { name: 'Details' }))
    expect(board.getByText(/any account here could have sent it/).textContent).not.toContain(REFUSED)
  })

  it('says the daemon refused this device for any other 403', () => {
    expect(causeOf(`${REFUSED}: the account x may only join itself`)).toMatchObject({
      daemon: true,
      title: 'Yantra refused this device',
      said: 'the account x may only join itself',
    })
  })

  it('draws one Open Tailscale button, not Try again, when this device cannot reach Yantra', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotReached since={null} why="TypeError: Failed to fetch" />
      </QueryClientProvider>,
    )
    const board = within(screen.getByRole('alert'))
    expect(board.getByRole('heading', { name: 'This device cannot reach Yantra' })).toBeTruthy()
    expect(board.getByRole('link', { name: 'Open Tailscale' }).getAttribute('href')).toBe(
      'https://login.tailscale.com/admin/machines',
    )
    expect(board.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(board.queryByText('TypeError: Failed to fetch')).toBeNull()
    fireEvent.click(board.getByRole('button', { name: 'Details' }))
    expect(board.getByText('TypeError: Failed to fetch')).toBeTruthy()
  })
})
