import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import { ChatHeader, type ChatHeaderProps } from './ChatHeader'
import { groupThreads, prMark } from './threads'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** `asked` holds the POSTs, which are the ssh reads; `reads` holds the GETs of the live states. */
let reads: string[] = []
let live: [number, unknown] = [200, []]

function daemon(...replies: [number, unknown][]) {
  const asked: string[] = []
  let at = 0
  reads = []
  live = [200, []]
  // A thread with an open PR draws Checks, which reads the form factor; jsdom has no `matchMedia`.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        reads.push(path)
        return Promise.resolve(answer(...live))
      }
      asked.push(`${init.method} ${path}`)
      const [status, body] = replies[Math.min(at++, replies.length - 1)]!
      return Promise.resolve(answer(status, body))
    }),
  )
  return asked
}

const idle = { current: null }
const HEX = /[0-9a-f]{16}/

type Over = Partial<ChatHeaderProps>

/** The header in a router with the workspace route, so a picked thread can be followed. */
async function show(over: Over = {}, url = '/w/site?view=chat') {
  const props: ChatHeaderProps = {
    workspace: 'site',
    thread: null,
    busy: false,
    diffs: 0,
    diff: { open: false, onToggle: () => {}, onRefresh: () => {} },
    diffRef: idle,
    terminal: { open: false, onToggle: () => {} },
    terminalRef: idle,
    added: false,
    onFix: () => {},
    ...over,
  }
  const root = createRootRoute()
  const workspace = createRoute({ getParentRoute: () => root, path: '/w/$name', component: () => <ChatHeader {...props} /> })
  const router = createRouter({ routeTree: root.addChildren([workspace]), history: createMemoryHistory({ initialEntries: [url] }) })
  await router.load()
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const out = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, ...out }
}

const trigger = (name: string | RegExp = /^Threads, /) => screen.findByRole('button', { name })
const openMenu = async (name?: string | RegExp) => {
  fireEvent.click(await trigger(name))
  return screen.findByRole('menu')
}
const rows = () =>
  screen
    .findAllByRole('menuitem')
    .then((all) => all.filter((one) => one.tagName === 'A' && one.textContent !== 'New thread'))

describe('prMark', () => {
  it('names each of the five states', () => {
    expect(contract.threads.map((one) => prMark(one.pr).word)).toEqual([
      'no PR',
      'PR #512 open',
      'PR #511 closed',
      'PR #510 merged',
      'PR unknown',
    ])
  })

  it('groups what is still going apart from what is done', () => {
    expect(groupThreads(contract.threads).map((one) => [one.title, one.items.length])).toEqual([
      ['Active', 3],
      ['Finished', 2],
    ])
  })
})

describe('the breadcrumb', () => {
  it('names the workspace and, with no thread yet, "New thread"', async () => {
    daemon([200, contract.threads])
    await show()
    const crumbs = await screen.findByRole('navigation', { name: 'Thread' })
    expect(crumbs.textContent).toContain('site')
    expect(within(crumbs).getByRole('button', { name: 'Threads, New thread' })).toBeTruthy()
  })

  it('names the open thread by its title once the list has read, and never by its id', async () => {
    daemon([200, contract.threads])
    await show({ thread: '1a1b2c3d4e5f6a7b' })
    const button = await screen.findByRole('button', { name: 'Threads, #488 A workspace lists its threads' })
    expect(button.textContent).not.toMatch(HEX)
  })
})

describe('the thread menu', () => {
  it('reads once on mount, not on opening, and draws title, branch, state and PR for each thread', async () => {
    const asked = daemon([200, contract.threads])
    await show({ thread: '1a1b2c3d4e5f6a7b' })
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(screen.queryByRole('menu')).toBeNull()
    await openMenu()
    const all = await rows()
    expect(all).toHaveLength(5)
    expect(asked).toEqual(['POST /api/workspaces/site/threads'])
    const open = all[1]!
    expect(within(open).getByText('#488 A workspace lists its threads')).toBeTruthy()
    expect(within(open).getByText('from main')).toBeTruthy()
    expect(within(open).getByText('PR #512 open')).toBeTruthy()
    expect(screen.getByText('PR #510 merged')).toBeTruthy()
    expect(screen.getByText('PR #511 closed')).toBeTruthy()
    expect(screen.getByText('no PR')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Active' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Finished' })).toBeTruthy()
  })

  it('marks the open thread with aria-current, taken from the URL before the daemon names it', async () => {
    daemon([200, contract.threads])
    await show({ urlThread: '1a1b2c3d4e5f6a7b' })
    await openMenu()
    const all = await rows()
    expect(all.map((one) => one.getAttribute('href'))).toContain('/w/site?view=chat&thread=1a1b2c3d4e5f6a7b')
    const current = all.filter((one) => one.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0]!.getAttribute('href')).toContain('thread=1a1b2c3d4e5f6a7b')
  })

  it('offers New thread, a push to the blank chat, only while a thread is open', async () => {
    daemon([200, contract.threads])
    const { router } = await show({ urlThread: '1a1b2c3d4e5f6a7b' }, '/w/site?view=chat&thread=1a1b2c3d4e5f6a7b')
    await openMenu()
    const fresh = await screen.findByRole('menuitem', { name: 'New thread' })
    expect(fresh.getAttribute('href')).toBe('/w/site?view=chat')
    const before = router.history.length
    fireEvent.click(fresh)
    await waitFor(() => expect(router.state.location.search).toEqual({ view: 'chat' }))
    expect(router.history.length).toBe(before + 1)
  })

  it('leaves New thread out of a blank chat, whose title already says it', async () => {
    daemon([200, contract.threads])
    await show()
    await openMenu()
    await rows()
    expect(screen.queryByRole('menuitem', { name: 'New thread' })).toBeNull()
  })

  it('replaces the thread search param when a thread is picked', async () => {
    daemon([200, contract.threads])
    const { router } = await show({ thread: '1a1b2c3d4e5f6a7b' }, '/w/site?view=chat&thread=1a1b2c3d4e5f6a7b')
    await openMenu()
    const other = (await rows()).find((one) => !one.getAttribute('href')!.includes('1a1b2c3d4e5f6a7b'))!
    const id = new URL(other.getAttribute('href')!, 'http://x').searchParams.get('thread')!
    const before = router.history.length
    fireEvent.click(other)
    await waitFor(() => expect(router.state.location.search).toEqual({ view: 'chat', thread: id }))
    expect(router.history.length).toBe(before)
  })

  it('shows an unknown PR with its reason and keeps the list', async () => {
    daemon([200, contract.threads])
    await show()
    await openMenu()
    expect(await screen.findByText('no GitHub grant — run `yantra github login`')).toBeTruthy()
    expect(await rows()).toHaveLength(5)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says "No threads yet" inside the menu, and nowhere else', async () => {
    const asked = daemon([200, []])
    await show()
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(screen.queryByText(/No threads yet/)).toBeNull()
    await openMenu()
    expect(await screen.findByText(/No threads yet/)).toBeTruthy()
  })

  it('asks again on Refresh threads, and keeps the list while it reads', async () => {
    const asked = daemon([200, []], [200, contract.threads])
    await show()
    await openMenu()
    await screen.findByText(/No threads yet/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh threads' }))
    await waitFor(async () => expect(await rows()).toHaveLength(5))
    expect(asked).toEqual(['POST /api/workspaces/site/threads', 'POST /api/workspaces/site/threads'])

    const fetching = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetching)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh threads' }))
    await waitFor(() => expect(fetching).toHaveBeenCalled())
    expect(await rows()).toHaveLength(5)
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('reads again once when the chat names a thread the list does not hold', async () => {
    const asked = daemon([200, contract.threads])
    const control: { pick: (thread: string) => void } = { pick: () => {} }
    function Switch() {
      const [thread, setThread] = useState('1a1b2c3d4e5f6a7b')
      const set = useRef(setThread)
      useEffect(() => {
        control.pick = set.current
      }, [])
      return <ChatHeader busy={false} diff={{ open: false, onToggle: () => {}, onRefresh: () => {} }} diffRef={idle} diffs={0} terminal={{ open: false, onToggle: () => {} }} terminalRef={idle} added={false} onFix={() => {}} thread={thread} workspace="site" />
    }
    const root = createRootRoute({ component: Switch })
    const router = createRouter({ routeTree: root, history: createMemoryHistory() })
    await router.load()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(asked).toHaveLength(1))
    act(() => control.pick('ffffffffffffffff'))
    await waitFor(() => expect(asked).toHaveLength(2))
    await new Promise((done) => setTimeout(done, 50))
    expect(asked).toHaveLength(2)
  })

  it('draws a pending state while the read is out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    await show()
    await openMenu()
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy())
  })

  it('fails in the menu with the daemon words and a way to retry', async () => {
    const asked = daemon([503, 'ssh to cachyos-g14 timed out'], [200, contract.threads])
    await show()
    await openMenu()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The threads could not be listed')
    expect(alert.textContent).toContain('ssh to cachyos-g14 timed out')
    fireEvent.click(within(alert).getByRole('menuitem', { name: 'Try again' }))
    await waitFor(async () => expect(await rows()).toHaveLength(5))
    expect(asked).toHaveLength(2)
  })

  it('opens from the keyboard and Escape closes it with focus back on the title', async () => {
    daemon([200, contract.threads])
    await show()
    const title = await trigger()
    title.focus()
    fireEvent.keyDown(title, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    expect(title.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(title))
  })
})

describe('the right side', () => {
  it('draws Diff pressed, and Refresh only while the diff is open', async () => {
    daemon([200, contract.threads])
    const toggle = vi.fn()
    const refresh = vi.fn()
    const diff = { open: false, onToggle: toggle, onRefresh: refresh }
    const { unmount } = await show({ diff })
    const button = await screen.findByRole('button', { name: 'Diff' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Refresh the diff' })).toBeNull()
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalled()
    unmount()

    await show({ diff: { ...diff, open: true } })
    expect((await screen.findByRole('button', { name: 'Diff' })).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the diff' }))
    expect(refresh).toHaveBeenCalled()
  })

  it('holds Terminal until the first turn makes a thread, and says why', async () => {
    daemon([200, contract.threads])
    const toggle = vi.fn()
    await show({ terminal: { open: false, onToggle: toggle } })
    const button = await screen.findByRole('button', { name: 'Terminal' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const why = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(why?.textContent).toBe("The terminal opens in the thread's worktree, which the first turn makes.")
    fireEvent.click(button)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('draws Terminal pressed while the drawer is open, beside Diff', async () => {
    daemon([200, contract.threads])
    const toggle = vi.fn()
    const terminal = { open: false, onToggle: toggle }
    const { unmount } = await show({ thread: '1a1b2c3d4e5f6a7b', terminal })
    const button = await screen.findByRole('button', { name: 'Terminal' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('aria-describedby')).toBeNull()
    expect(button.nextElementSibling).toBe(screen.getByRole('button', { name: 'Diff' }))
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledOnce()
    unmount()

    await show({ thread: '1a1b2c3d4e5f6a7b', terminal: { ...terminal, open: true } })
    expect((await screen.findByRole('button', { name: 'Terminal' })).getAttribute('aria-pressed')).toBe('true')
  })

  it('says a comment was added, politely', async () => {
    daemon([200, contract.threads])
    await show({ added: true })
    expect(await screen.findByText('Comment added to your message.')).toBeTruthy()
  })

  it('hands the PR the thread list read to the git actions', async () => {
    daemon([200, contract.threads])
    await show({ thread: '1a1b2c3d4e5f6a7b' })
    const link = await screen.findByRole('link', { name: 'PR #512' })
    expect(link.getAttribute('href')).toContain('github.com')
  })
})

describe('the live state of each thread (Y-649)', () => {
  const since = 1_790_000_000_000
  const lone = (over: Partial<(typeof contract.threads)[number]>) => [{ ...contract.threads[0]!, ...over }]

  it('shows no hex id in the header or the opened menu, and a title, "from main" and a state per row', async () => {
    daemon([200, contract.threads])
    await show({ thread: '0a1b2c3d4e5f6a7b' })
    const menu = await openMenu()
    const all = await rows()
    expect(all).toHaveLength(5)
    expect(document.querySelector('header')!.textContent).not.toMatch(HEX)
    expect(menu.textContent).not.toMatch(HEX)
    for (const row of all) {
      expect(within(row).getByText('from main')).toBeTruthy()
      expect(row.textContent).toMatch(/Idle|Working/)
    }
    expect(within(menu).getAllByText('Fix the login redirect')).toHaveLength(4)
  })

  it('reads the states only while the menu is open, and they override the list', async () => {
    const asked = daemon([200, lone({ state: 'idle' })])
    live = [200, [{ id: contract.threads[0]!.id, state: 'working', since: null }]]
    await show()
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(reads).toEqual([])
    const [row] = await (async () => {
      await openMenu()
      return rows()
    })()
    await waitFor(() => expect(row!.textContent).toContain('Working'))
    expect(row!.textContent).not.toContain('·')
    expect(reads).toEqual(['/api/workspaces/site/threads'])
  })

  it('advances a working thread\'s elapsed time with the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: since + 8_000 })
    try {
      daemon([200, lone({ state: 'working', since })])
      await show()
      fireEvent.click(await trigger())
      expect((await rows())[0]!.textContent).toContain('Working · 8s')
      await act(async () => {
        vi.advanceTimersByTime(65_000)
      })
      expect((await rows())[0]!.textContent).toContain('Working · 1m 13s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads an untitled thread as "Untitled thread" and an issue thread by its issue', async () => {
    daemon([200, [{ ...contract.threads[0]!, title: null, issue: null }, { ...contract.threads[1]!, id: 'b', title: null }]])
    await show()
    await openMenu()
    await rows()
    expect(screen.getByText('Untitled thread')).toBeTruthy()
    expect(screen.getByText('2002Bishwajeet/yantra#488')).toBeTruthy()
  })

  it('says the states could not be read and keeps the list\'s state', async () => {
    daemon([200, lone({ state: 'working', since })])
    live = [503, 'daemon is restarting']
    await show()
    await openMenu()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The thread states could not be read')
    expect((await rows())[0]!.textContent).toContain('Working')
  })

  it('lets the socket\'s busy override the open thread\'s row', async () => {
    const id = contract.threads[0]!.id
    daemon([200, lone({ state: 'idle' })])
    live = [200, [{ id, state: 'idle', since: null }]]
    const { unmount } = await show({ thread: id, busy: true })
    await openMenu()
    await waitFor(async () => expect((await rows())[0]!.textContent).toContain('Working'))
    unmount()

    daemon([200, lone({ state: 'working', since })])
    live = [200, [{ id, state: 'working', since }]]
    await show({ thread: id, busy: false })
    await openMenu()
    await waitFor(async () => expect((await rows())[0]!.textContent).toContain('Idle'))
  })
})
