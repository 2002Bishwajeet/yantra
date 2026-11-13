/** The chords run the verbs of GitActions through its own `run`, so a verb that asks still asks. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ThreadPr } from '@/api'
import { answer } from '@/test/daemon'
import { useLoopChords, useLoopCommands } from '@/shell/loopCommands'
import { GitActions } from './GitActions'
import { KEYS } from './keys'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mine = '0a1b2c3d4e5f6a7b'

function Probe() {
  useLoopChords()
  const commands = useLoopCommands()
  return <output data-testid="reasons">{commands.map((one) => `${one.id}:${one.reason ?? 'on'}`).join(' ')}</output>
}

function daemon(replies: Record<string, [number, unknown]> = {}) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      const [status, body] = replies[path.split('/').pop()!] ?? [404, 'no route']
      return Promise.resolve(answer(status, body))
    }),
  )
  return calls
}

const show = (listed?: ThreadPr, diffs = 1) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <Probe />
      <GitActions busy={false} diffs={diffs} listed={listed} onRemoved={() => {}} refresh={() => {}} thread={mine} workspace="site" />
    </QueryClientProvider>,
  )

const chord = (id: string) => {
  const one = KEYS.find((key) => key.id === id)!
  fireEvent.keyDown(document, { code: one.code, altKey: one.alt, ctrlKey: true })
}
const open: ThreadPr = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' }

describe('the git chords', () => {
  it('Merge opens the confirmation, reads the PR and merges nothing', async () => {
    const calls = daemon()
    show(open)
    chord('merge')
    const dialog = await screen.findByRole('dialog', { name: 'Merge PR #7' })
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeTruthy()
    expect(calls.filter((one) => one.startsWith('POST'))).toEqual([`POST /api/workspaces/site/threads/${mine}/pending`])
  })

  it('Commit opens the editable message dialog', async () => {
    daemon({ message: [200, { message: 'Add it' }] })
    show()
    chord('commit')
    expect(await screen.findByRole('dialog', { name: 'Commit this thread' })).toBeTruthy()
    expect(((await screen.findByLabelText('Commit message')) as HTMLTextAreaElement).value).toBeDefined()
  })

  it('Push runs the push, and a refusal draws the git failure surface', async () => {
    const calls = daemon({ push: [500, 'boom'] })
    show(undefined, 0)
    // Nothing changed and nothing is committed, so Push is the only verb the chord can still reach.
    await waitFor(() => expect(screen.getByTestId('reasons').textContent).toContain('push:on'))
    chord('push')
    await waitFor(() => expect(calls.some((one) => one.endsWith('/push'))).toBe(true))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('Open PR runs the open verb', async () => {
    const calls = daemon()
    show()
    chord('pr')
    await waitFor(() => expect(calls.some((one) => one.endsWith('/pr'))).toBe(true))
  })

  it('does nothing for a verb that is off, and says why to the palette', async () => {
    const calls = daemon()
    show()
    expect(screen.getByTestId('reasons').textContent).toContain('merge:There is no open PR to merge.')
    chord('merge')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls).toEqual([])
  })

  it('drops its commands when the Chat unmounts', () => {
    daemon()
    const view = show()
    expect(screen.getByTestId('reasons').textContent).toContain('commit:on')
    view.unmount()
    cleanup()
    render(<Probe />)
    expect(screen.getByTestId('reasons').textContent).toBe('')
  })
})
