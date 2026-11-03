/** The commit, push and PR controls against a stubbed daemon, route by route. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { threadCommitted, threadMessage, threadPrOpened, threadPushed, threads } from '@/contract.gen'
import type { Thread } from '@/api'
import { answer } from '@/test/daemon'
import { GitActions } from './GitActions'

afterEach(() => vi.unstubAllGlobals())

const mine = '0a1b2c3d4e5f6a7b'
const base = `/api/workspaces/site/threads/${mine}`

type Reply = [number, unknown]
type Routes = Partial<Record<'threads' | 'message' | 'commit' | 'push' | 'pr', Reply | (() => Reply)>>

/** Every call is answered by its route; the log keeps path and body in order. */
function daemon(routes: Routes) {
  const log: { path: string; body?: unknown }[] = []
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    const verb = path.endsWith('/threads') ? 'threads' : (path.split('/').pop() as keyof Routes)
    log.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const route = routes[verb] ?? [404, 'no route']
    const [status, body] = typeof route === 'function' ? route() : route
    return Promise.resolve(answer(status, body))
  })
  vi.stubGlobal('fetch', fetch)
  return log
}

const open = (props: Partial<{ thread: string | null; busy: boolean }> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <GitActions busy={props.busy ?? false} thread={props.thread === undefined ? mine : props.thread} workspace="site" />
    </QueryClientProvider>,
  )

const dialog = () => screen.findByRole('dialog')
const commitBox = async () => (await within(await dialog()).findByLabelText('Commit message')) as HTMLTextAreaElement

describe('the controls', () => {
  it('asks the thread list once the chat has a thread, and not before', async () => {
    const log = daemon({ threads: [200, threads] })
    open({ thread: null })
    expect(log).toHaveLength(0)
    open()
    await waitFor(() => expect(log.map((one) => one.path)).toEqual(['/api/workspaces/site/threads']))
  })

  it.each([
    ['no thread', { thread: null }, /no thread yet/],
    ['a running turn', { busy: true }, /turn is running/],
  ])('turns all three off for %s, and says why to a screen reader', async (_, props, reason) => {
    daemon({ threads: [200, threads] })
    open(props)
    for (const name of ['Commit', 'Push', 'Open PR']) {
      const button = screen.getByRole('button', { name })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(button.getAttribute('aria-describedby')).toBeTruthy()
    }
    expect(document.querySelector('.m3-sr-only')?.textContent).toMatch(reason)
  })
})

describe('commit', () => {
  it('drafts, fills the box, and commits an edited message', async () => {
    const log = daemon({ threads: [200, threads], message: [200, threadMessage], commit: [200, threadCommitted] })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))

    const box = await commitBox()
    await waitFor(() => expect(box.value).toBe(threadMessage.message))
    expect(log.some((one) => one.path === `${base}/message`)).toBe(true)

    fireEvent.change(box, { target: { value: 'Edited subject' } })
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(screen.getByText(`Committed: ${threadCommitted.subject}`)).toBeTruthy())
    expect(log.find((one) => one.path === `${base}/commit`)?.body).toEqual({ message: 'Edited subject' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a loading state while the draft is written', async () => {
    let release: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        path.endsWith('/message')
          ? new Promise<Response>((resolve) => (release = resolve))
          : Promise.resolve(answer(200, threads)),
      ),
    )
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    const box = await commitBox()
    await waitFor(() => expect(box.disabled).toBe(true))
    expect(within(await dialog()).getByRole('status').textContent).toMatch(/Drafting/)
    release(answer(200, threadMessage))
    await waitFor(() => expect(box.value).toBe(threadMessage.message))
    expect(box.disabled).toBe(false)
  })

  it('keeps Commit off while the box is empty', async () => {
    daemon({ threads: [200, threads], message: [200, { message: '' }] })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
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
      threads: [200, threads],
      message: () => (++tries === 1 ? [502, 'claude exited 1'] : [200, threadMessage]),
      commit: [200, threadCommitted],
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
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

  it('draws a refused commit and keeps the dialog open', async () => {
    daemon({
      threads: [200, threads],
      message: [200, threadMessage],
      commit: [409, 'Author identity unknown'],
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    const box = await commitBox()
    await waitFor(() => expect(box.value).not.toBe(''))
    fireEvent.click(within(await dialog()).getAllByRole('button', { name: 'Commit' }).at(-1)!)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The commit was refused' })).toBeTruthy()
    expect(within(alert).getByText('Author identity unknown')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('push', () => {
  it('shows the remote and branch it pushed', async () => {
    daemon({ threads: [200, threads], push: [200, threadPushed] })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await waitFor(() => expect(screen.getByText(`Pushed ${threadPushed.remote}/${threadPushed.branch}`)).toBeTruthy())
  })

  it('draws a refused push with the daemon text, and Retry asks again', async () => {
    let tries = 0
    daemon({
      threads: [200, threads],
      push: () => (++tries === 1 ? [409, '! [rejected] non-fast-forward'] : [200, threadPushed]),
    })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The push was refused' })).toBeTruthy()
    expect(within(alert).getByText('! [rejected] non-fast-forward')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText(/^Pushed origin/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('open PR', () => {
  it('opens one, then swaps the button for a link and refreshes the list', async () => {
    const log = daemon({ threads: [200, threads], pr: [200, threadPrOpened] })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }))

    const link = await screen.findByRole('link', { name: `PR #${threadPrOpened.number}` })
    expect(link.getAttribute('href')).toBe(threadPrOpened.url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByRole('button', { name: 'Open PR' })).toBeNull()
    await waitFor(() => expect(log.filter((one) => one.path === '/api/workspaces/site/threads')).toHaveLength(2))
  })

  it.each(['open', 'merged'] as const)('shows the link of a thread whose PR is %s, with no button', async (state) => {
    const listed: Thread[] = [{ ...threads[0]!, id: mine, pr: { state, number: 7, url: 'https://github.com/o/r/pull/7' } }]
    daemon({ threads: [200, listed] })
    open()
    const link = await screen.findByRole('link', { name: 'PR #7' })
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/7')
    expect(screen.queryByRole('button', { name: 'Open PR' })).toBeNull()
  })

  it('keeps the button for a thread whose PR is closed', async () => {
    const listed: Thread[] = [{ ...threads[0]!, id: mine, pr: { state: 'closed', number: 7, url: 'https://x/7' } }]
    const log = daemon({ threads: [200, listed] })
    open()
    await waitFor(() => expect(log).toHaveLength(1))
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open PR' })).toBeTruthy()
  })

  it('draws a refused PR with the daemon text', async () => {
    daemon({ threads: [200, threads], pr: [409, 'the branch is not pushed'] })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The pull request was refused' })).toBeTruthy()
    expect(within(alert).getByText('the branch is not pushed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open PR' })).toBeTruthy()
  })

  it('draws a network failure as such', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        path.endsWith('/pr') ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(answer(200, threads)),
      ),
    )
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The daemon did not answer' })).toBeTruthy()
  })
})
