/** The commit, push and PR controls against a stubbed daemon, route by route. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { threadCommitted, threadMessage, threadPrOpened, threadPushed } from '@/contract.gen'
import type { ThreadPr } from '@/api'
import { answer } from '@/test/daemon'
import { GitActions } from './GitActions'

afterEach(() => vi.unstubAllGlobals())

const mine = '0a1b2c3d4e5f6a7b'
const base = `/api/workspaces/site/threads/${mine}`

type Reply = [number, unknown]
type Routes = Partial<Record<'message' | 'commit' | 'push' | 'pr', Reply | (() => Reply)>>

/** Every call is answered by its route; the log keeps path and body in order. */
function daemon(routes: Routes) {
  const log: { path: string; body?: unknown }[] = []
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    const verb = path.split('/').pop() as keyof Routes
    log.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const route = routes[verb] ?? [404, 'no route']
    const [status, body] = typeof route === 'function' ? route() : route
    return Promise.resolve(answer(status, body))
  })
  vi.stubGlobal('fetch', fetch)
  return log
}

type Props = Partial<{ thread: string | null; busy: boolean; diffs: number; listed: ThreadPr }>

const open = (props: Props = {}) => {
  const refresh = vi.fn()
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <GitActions
        busy={props.busy ?? false}
        diffs={props.diffs ?? 1}
        listed={props.listed}
        refresh={refresh}
        thread={props.thread === undefined ? mine : props.thread}
        workspace="site"
      />
    </QueryClientProvider>,
  )
  return { ...view, refresh }
}

const dialog = () => screen.findByRole('dialog')
const commitBox = async () => (await within(await dialog()).findByLabelText('Commit message')) as HTMLTextAreaElement
const quick = (name: string | RegExp) => screen.getByRole('button', { name })
const menuTrigger = () => screen.getByRole('button', { name: 'Git actions' })
/** Opens the menu and picks one item. */
async function pick(name: string) {
  fireEvent.click(menuTrigger())
  fireEvent.click(await screen.findByRole('menuitem', { name }))
}
const openPr = { number: 7, url: 'https://github.com/o/r/pull/7' }

describe('the quick action', () => {
  it.each([
    ['no thread', { thread: null }, 'Commit', /no thread yet/],
    ['a running turn', { busy: true }, 'Commit', /turn is running/],
    ['nothing to do', { diffs: 0 }, 'Up to date', /Nothing to commit/],
    ['a PR that is closed', { diffs: 0, listed: { state: 'closed', ...openPr } }, 'Up to date', /Nothing to commit/],
  ] as const)('is a disabled hint for %s, with the reason for a screen reader', (_, props, label, reason) => {
    open(props as Props)
    const button = quick(label) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toMatch(reason)
    expect(document.querySelector('.m3-sr-only[id]')?.textContent).toMatch(reason)
  })

  it('names the next step as the page learns it: Commit, Push, Open PR, then the PR', async () => {
    daemon({ message: [200, threadMessage], commit: [200, threadCommitted], push: [200, threadPushed], pr: [200, threadPrOpened] })
    open()
    fireEvent.click(quick('Commit'))
    await commitBox()
    await waitFor(() => expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe(threadMessage.message))
    fireEvent.click(within(await dialog()).getAllByRole('button', { name: 'Commit' }).at(-1)!)
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open PR' }))
    const link = await screen.findByRole('link', { name: `PR #${threadPrOpened.number}` })
    expect(link.getAttribute('href')).toBe(threadPrOpened.url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByRole('button', { name: 'Open PR' })).toBeNull()
  })

  it.each(['open', 'merged'] as const)('is the link of a thread whose PR is %s', (state) => {
    open({ diffs: 0, listed: { state, ...openPr } })
    expect(screen.getByRole('link', { name: 'PR #7' }).getAttribute('href')).toBe(openPr.url)
  })

  it('asks for a commit again when a later turn changes files', async () => {
    daemon({ message: [200, threadMessage], commit: [200, threadCommitted] })
    const view = open()
    fireEvent.click(quick('Commit'))
    await commitBox()
    await waitFor(() => expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).not.toBe(''))
    fireEvent.click(within(await dialog()).getAllByRole('button', { name: 'Commit' }).at(-1)!)
    await screen.findByRole('button', { name: 'Push' })
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <GitActions busy={false} diffs={2} listed={undefined} refresh={view.refresh} thread={mine} workspace="site" />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Commit' })).toBeTruthy()
  })
})

describe('the menu', () => {
  it('holds Commit, Push and Open PR, on when the thread is idle', async () => {
    open({ diffs: 0 })
    fireEvent.click(menuTrigger())
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((one) => [one.textContent, one.getAttribute('aria-disabled')])).toEqual([
      ['Commit', null],
      ['Push', null],
      ['Open PR', null],
    ])
  })

  it.each([
    ['no thread', { thread: null }, /no thread yet/],
    ['a running turn', { busy: true }, /turn is running/],
  ] as const)('turns all three off for %s, and says why', async (_, props, reason) => {
    open(props as Props)
    fireEvent.click(menuTrigger())
    const items = await screen.findAllByRole('menuitem')
    expect(items).toHaveLength(3)
    for (const item of items) {
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toMatch(reason)
    }
  })

  it('swaps Open PR for a link to the PR', async () => {
    open({ listed: { state: 'open', ...openPr } })
    fireEvent.click(menuTrigger())
    const item = await screen.findByRole('menuitem', { name: 'PR #7' })
    expect(item.getAttribute('href')).toBe(openPr.url)
    expect(screen.queryByRole('menuitem', { name: 'Open PR' })).toBeNull()
  })
})

describe('commit', () => {
  it.each([
    ['the quick action', async () => fireEvent.click(quick('Commit'))],
    ['the menu', async () => pick('Commit')],
  ])('drafts, fills the box, and commits an edited message from %s', async (_, start) => {
    const log = daemon({ message: [200, threadMessage], commit: [200, threadCommitted] })
    open()
    await start()

    const box = await commitBox()
    await waitFor(() => expect(box.value).toBe(threadMessage.message))
    expect(log.some((one) => one.path === `${base}/message`)).toBe(true)

    fireEvent.change(box, { target: { value: 'Edited subject' } })
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(screen.getByText(`Committed: ${threadCommitted.subject}`)).toBeTruthy())
    expect(log.find((one) => one.path === `${base}/commit`)?.body).toEqual({ message: 'Edited subject' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hands focus back to the quick action, or to the menu button, whichever opened the dialog', async () => {
    daemon({ message: [200, threadMessage] })
    open()
    fireEvent.click(quick('Commit'))
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(quick('Commit')))

    await pick('Commit')
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(menuTrigger()))
  })

  it('shows a loading state while the draft is written', async () => {
    let release: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    )
    open()
    fireEvent.click(quick('Commit'))
    const box = await commitBox()
    await waitFor(() => expect(box.disabled).toBe(true))
    expect(within(await dialog()).getByRole('status').textContent).toMatch(/Drafting/)
    release(answer(200, threadMessage))
    await waitFor(() => expect(box.value).toBe(threadMessage.message))
    expect(box.disabled).toBe(false)
  })

  it('keeps Commit off while the box is empty', async () => {
    daemon({ message: [200, { message: '' }] })
    open()
    fireEvent.click(quick('Commit'))
    const box = await commitBox()
    await waitFor(() => expect(box.disabled).toBe(false))
    const go = within(await dialog()).getByRole('button', { name: 'Commit' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(box, { target: { value: 'x' } })
    expect(go.disabled).toBe(false)
  })

  it('draws a failed draft, lets the person write one, and retries the draft', async () => {
    let tries = 0
    const log = daemon({
      message: () => (++tries === 1 ? [502, 'claude exited 1'] : [200, threadMessage]),
      commit: [200, threadCommitted],
    })
    open()
    fireEvent.click(quick('Commit'))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The draft failed' })).toBeTruthy()
    expect(within(alert).getByText('claude exited 1')).toBeTruthy()

    const box = await commitBox()
    fireEvent.change(box, { target: { value: 'Mine' } })
    expect((within(await dialog()).getAllByRole('button', { name: 'Commit' }).at(-1) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(box.value).toBe(threadMessage.message))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(log.filter((one) => one.path.endsWith('/message'))).toHaveLength(2)
  })

  it.each([
    ['the Mac has no tmux server from a login session', 'The Mac has no login tmux server'],
  ])('draws a 409 draft saying "%s" as %s, not as a running turn', async (said, title) => {
    daemon({ message: [409, said] })
    open()
    await pick('Commit')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: title })).toBeTruthy()
    expect(within(alert).queryByText(/Wait for the turn/)).toBeNull()
  })

  it.each([
    ['the quick action', async () => fireEvent.click(quick('Commit'))],
    ['the menu', async () => pick('Commit')],
  ])('draws a draft that finds nothing to commit from %s as an empty state, with nothing to fill or retry', async (_, start) => {
    daemon({ message: [409, 'the thread has nothing to commit'] })
    open()
    await start()
    const popup = within(await dialog())
    expect(await popup.findByText('Nothing to commit')).toBeTruthy()
    expect(popup.getByText('The thread has no changes.')).toBeTruthy()
    expect(popup.queryByRole('textbox')).toBeNull()
    expect(popup.queryByRole('alert')).toBeNull()
    expect(popup.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(popup.queryByRole('button', { name: 'Commit' })).toBeNull()
    expect(popup.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it.each([
    ['the quick action', async () => fireEvent.click(quick('Commit'))],
    ['the menu', async () => pick('Commit')],
  ])('draws a refused commit from %s and keeps the dialog open', async (_, start) => {
    daemon({ message: [200, threadMessage], commit: [409, 'Author identity unknown'] })
    open()
    await start()
    const box = await commitBox()
    await waitFor(() => expect(box.value).not.toBe(''))
    fireEvent.click(within(await dialog()).getAllByRole('button', { name: 'Commit' }).at(-1)!)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The commit was refused' })).toBeTruthy()
    expect(within(alert).getByText('Author identity unknown')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

/** Commits through the quick action so that it names Push, as a person would reach it. */
async function committed() {
  fireEvent.click(quick('Commit'))
  const box = await commitBox()
  await waitFor(() => expect(box.value).not.toBe(''))
  fireEvent.click(within(await dialog()).getAllByRole('button', { name: 'Commit' }).at(-1)!)
  await screen.findByRole('button', { name: 'Push' })
}

describe('push', () => {
  it('shows the remote and branch it pushed, from the menu', async () => {
    daemon({ push: [200, threadPushed] })
    open()
    await pick('Push')
    await waitFor(() => expect(screen.getByText(`Pushed ${threadPushed.remote}/${threadPushed.branch}`)).toBeTruthy())
  })

  it.each([
    ['the quick action', async () => { await committed(); fireEvent.click(quick('Push')) }],
    ['the menu', async () => pick('Push')],
  ])('draws a refused push from %s with the daemon text, and Retry asks again', async (_, start) => {
    let tries = 0
    daemon({
      message: [200, threadMessage],
      commit: [200, threadCommitted],
      push: () => (++tries === 1 ? [409, '! [rejected] non-fast-forward'] : [200, threadPushed]),
    })
    open()
    await start()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The push was refused' })).toBeTruthy()
    expect(within(alert).getByText('! [rejected] non-fast-forward')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText(/^Pushed origin/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('open PR', () => {
  it('opens one from the menu, then swaps the item for a link and reads the thread list again', async () => {
    daemon({ pr: [200, threadPrOpened] })
    const { refresh } = open()
    await pick('Open PR')
    await waitFor(() => expect(screen.getByText(`Opened PR #${threadPrOpened.number}`)).toBeTruthy())
    expect(refresh).toHaveBeenCalledOnce()
    fireEvent.click(menuTrigger())
    const item = await screen.findByRole('menuitem', { name: `PR #${threadPrOpened.number}` })
    expect(item.getAttribute('href')).toBe(threadPrOpened.url)
    expect(screen.queryByRole('menuitem', { name: 'Open PR' })).toBeNull()
  })

  it.each([
    ['the quick action', async () => {
      await committed()
      fireEvent.click(quick('Push'))
      fireEvent.click(await screen.findByRole('button', { name: 'Open PR' }))
    }],
    ['the menu', async () => pick('Open PR')],
  ])('draws a refused PR from %s with the daemon text', async (_, start) => {
    daemon({
      message: [200, threadMessage],
      commit: [200, threadCommitted],
      push: [200, threadPushed],
      pr: [409, 'the branch is not pushed'],
    })
    open()
    await start()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The pull request was refused' })).toBeTruthy()
    expect(within(alert).getByText('the branch is not pushed')).toBeTruthy()
    fireEvent.click(menuTrigger())
    expect(await screen.findByRole('menuitem', { name: 'Open PR' })).toBeTruthy()
  })

  it('draws a network failure as such', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    open()
    await pick('Open PR')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The daemon did not answer' })).toBeTruthy()
  })
})
