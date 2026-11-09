import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Looked, Pull } from '@/api'
import { pulls } from '@/contract.gen'
import { answer } from '@/test/daemon'
import { Checks } from './Checks'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const URL_21 = 'https://github.com/o/r/pull/21'
const watched = pulls.data[0]! as Pull

function at(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** Each GET of `/api/pulls` takes the next reply; the last one repeats. */
function daemon(...replies: (() => Promise<Response>)[]) {
  let read = 0
  const asked = vi.fn((path: string) => {
    expect(path).toBe('/api/pulls')
    return replies[Math.min(read++, replies.length - 1)]!()
  })
  vi.stubGlobal('fetch', asked)
  return asked
}

const ok = (data: Pull[]): Looked<Pull[]> => ({ looked: 'ok', age_seconds: 0, data })
const reply = (status: number, body: unknown) => () => Promise.resolve(answer(status, body))

function show(pr: { number: number; url: string } | null = { number: 21, url: URL_21 }) {
  const onFix = vi.fn<(block: string) => void>()
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <Checks onFix={onFix} pr={pr} />
    </QueryClientProvider>,
  )
  return onFix
}

const openChecks = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Checks' }))
  return screen.findByRole('dialog', { name: 'Checks on PR #21' })
}

describe('Checks', () => {
  it('draws nothing and reads nothing for a thread with no open PR', () => {
    at(1440)
    const asked = daemon(reply(200, ok([])))
    show(null)
    expect(screen.queryByRole('button', { name: 'Checks' })).toBeNull()
    expect(asked).not.toHaveBeenCalled()
  })

  it('lists each check with its mark and summary, and each review and line comment', async () => {
    at(1440)
    daemon(reply(200, pulls))
    show()
    const surface = await openChecks()
    await waitFor(() => expect(within(surface).getByText('1 of 2 failing')).toBeTruthy())
    const checks = within(within(surface).getByRole('list', { name: 'Checks' })).getAllByRole('listitem')
    expect(checks.map((one) => one.getAttribute('data-status'))).toEqual(['failure', 'success'])
    expect(checks[0]!.textContent).toContain('Failed')
    expect(checks[0]!.textContent).toContain('1 failed')
    // The summary is markdown: its inline code is code.
    expect(within(checks[0]!).getByText('watch::look').tagName).toBe('CODE')
    const comments = within(within(surface).getByRole('list', { name: 'Review comments' })).getAllByRole('listitem')
    expect(comments[0]!.textContent).toContain('friend · changes requested')
    expect(comments[0]!.textContent).toContain('Please add a test.')
    expect(comments[1]!.textContent).toContain('src/watch.rs:12')
    expect(comments[1]!.textContent).toContain('This drops the etag.')
  })

  it('says it is reading while the first read is out', async () => {
    at(1440)
    daemon(() => new Promise<Response>(() => {}))
    show()
    const surface = await openChecks()
    expect(within(surface).getByText('Reading the checks…')).toBeTruthy()
  })

  it('says GitHub reported no checks yet, with Fix off', async () => {
    at(1440)
    daemon(reply(200, ok([{ ...watched, checks: [], reviews: [], comments: [] }])))
    show()
    const surface = await openChecks()
    await waitFor(() => expect(within(surface).getByText('GitHub reported no checks yet')).toBeTruthy())
    expect((within(surface).getByRole('button', { name: 'Fix with agent' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says the PR is not watched when the watch holds no PR at its address', async () => {
    at(1440)
    daemon(reply(200, ok([{ ...watched, url: 'https://github.com/o/r/pull/9' }])))
    show()
    const surface = await openChecks()
    await waitFor(() => expect(within(surface).getByText('This PR is not watched')).toBeTruthy())
  })

  it.each([
    ['the daemon not answering', () => Promise.reject(new TypeError('Failed to fetch')), 'The daemon did not answer', 'Failed to fetch'],
    ['a watch that could not look', reply(200, { looked: 'failed', age_seconds: 0, error: 'GitHub refused the grant' }), 'The watch could not look', 'GitHub refused the grant'],
    ['an older daemon', reply(404, 'this daemon serves no such route under /api'), 'The checks could not be read', 'no such route'],
    ['a body it cannot read', reply(200, { data: [] }), 'The checks could not be read', 'looked'],
  ])('draws %s as a typed failure, and Try again reads again', async (_, first, title, said) => {
    at(1440)
    const asked = daemon(first, reply(200, pulls))
    show()
    const surface = await openChecks()
    const alert = await within(surface).findByRole('alert')
    expect(within(alert).getByRole('heading', { name: title })).toBeTruthy()
    expect(alert.textContent).toContain(said)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(surface).getByText('1 of 2 failing')).toBeTruthy())
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('Fix with agent hands over one block and closes, and sends nothing itself', async () => {
    at(1440)
    const asked = daemon(reply(200, pulls))
    const onFix = show()
    const surface = await openChecks()
    fireEvent.click(await within(surface).findByRole('button', { name: 'Fix with agent' }))
    await waitFor(() => expect(onFix).toHaveBeenCalledTimes(1))
    expect(onFix.mock.calls[0]![0]).toMatch(/^Fix PR #21:\n\nCheck test failed \(failure\)\./)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The one request is the read; Fix posts nothing.
    expect(asked.mock.calls.every(([path]) => path === '/api/pulls')).toBe(true)
  })

  it('opens as a bottom sheet on a phone', async () => {
    at(390)
    daemon(reply(200, pulls))
    const onFix = show()
    const surface = await openChecks()
    expect(surface.classList.contains('m3-bottom-sheet')).toBe(true)
    fireEvent.click(await within(surface).findByRole('button', { name: 'Fix with agent' }))
    await waitFor(() => expect(onFix).toHaveBeenCalledTimes(1))
  })
})
