import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Workspace } from '@/api'
import type { Target } from '@/api/socket'
import { threadTerminal } from '@/contract.gen'
import { answer } from '@/test/daemon'
import { TerminalDrawer } from './TerminalDrawer'

/* Y-498. The terminal itself is `Terminal.test.tsx`'s, against a real socket;
   here it is a stand-in that says which target it was handed. */

const opened: { target: Target; label: string }[] = []

vi.mock('./Terminal', () => ({
  Terminal: (props: { target: Target; label: string; children?: ReactNode }) => {
    opened.push({ target: props.target, label: props.label })
    return (
      <div data-testid="pane">
        {props.label}
        {props.children}
      </div>
    )
  },
}))

const web: Workspace = { name: 'site', machine: 'cachyos-g14', repo: '/home/u/site', startup: null }
const thread = '0a1b2c3d4e5f6a7b'
const path = `/api/workspaces/site/threads/${thread}/terminal`

/** `width` picks the form factor, as the shell reads it. */
function at(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** Each POST takes the next answer; `null` is a fetch that rejects. */
function daemon(...answers: (Response | null)[]) {
  const asked = vi.fn((_path: string, _init?: RequestInit) => {
    const next = answers.shift()
    return next ? Promise.resolve(next) : Promise.reject(new TypeError('Failed to fetch'))
  })
  vi.stubGlobal('fetch', asked)
  return asked
}

function draw(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TerminalDrawer agent="Claude" onClose={onClose} thread={thread} workspace={web} />
    </QueryClientProvider>,
  )
  return onClose
}

beforeEach(() => {
  opened.length = 0
  at(1440)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the terminal drawer', () => {
  it("opens the thread's session and attaches to it by name", async () => {
    const asked = daemon(answer(200, threadTerminal))
    draw()
    expect(screen.getByRole('status').textContent).toBe('Opening the terminal on cachyos-g14…')
    await waitFor(() => expect(screen.getByTestId('pane')).toBeTruthy())
    expect(asked).toHaveBeenCalledWith(path, { method: 'POST' })
    expect(opened.at(-1)).toEqual({
      target: { machine: threadTerminal.machine, session: threadTerminal.session },
      label: `tmux ${threadTerminal.session} on ${threadTerminal.machine}`,
    })
    expect(screen.getByText(/This shell and Claude share the thread's worktree/)).toBeTruthy()
    expect(screen.queryByRole('toolbar', { name: 'Keys' })).toBeNull()
  })

  it('adds the key row on a phone', async () => {
    at(390)
    daemon(answer(200, threadTerminal))
    draw()
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Keys' })).toBeTruthy())
  })

  it.each([
    ['no thread', answer(404, 'the workspace has no thread 0a1b2c3d4e5f6a7b'), 'The thread has no worktree to open a terminal in'],
    [
      'no tmux server on a Mac',
      answer(409, '`cachyos-g14` runs macOS and has no tmux server'),
      'cachyos-g14 has no tmux server to open the terminal in',
    ],
    ['a machine that did not answer', answer(503, 'ssh: connect timed out'), 'The terminal could not be opened on cachyos-g14'],
  ])('draws %s, and Retry asks again', async (_, refused, title) => {
    const asked = daemon(refused, answer(200, threadTerminal))
    draw()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading').textContent).toBe(title)
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('pane')).toBeTruthy())
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('draws a daemon that did not answer, and Try again asks again', async () => {
    const asked = daemon(null, answer(200, threadTerminal))
    draw()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading').textContent).toBe('The daemon did not answer, so no terminal was opened')
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('pane')).toBeTruthy())
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('closes on Close', async () => {
    daemon(answer(200, threadTerminal))
    const onClose = draw()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
