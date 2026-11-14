import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { answer } from '@/test/daemon'
import { Join } from './Join'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function draw(status: number, body: unknown) {
  const asked = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(answer(status, body)))
  vi.stubGlobal('fetch', asked)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Join machine="laptop" what="the join command" />
      <Join machine="mac" what="the join command for mac" />
    </QueryClientProvider>,
  )
  return asked
}

const COMMAND = "curl -fsSL 'https://hub.example.ts.net:8443/join?code=ABCD2345' | sh"

describe('the join command', () => {
  it('carries the code the hub made, one code for each machine', async () => {
    const asked = draw(200, { code: 'ABCD2345', expires_in: 600, command: COMMAND })
    expect(await screen.findByRole('button', { name: 'Copy the join command' })).toBeTruthy()
    expect(screen.getAllByText(COMMAND)).toHaveLength(2)
    expect(asked.mock.calls.map(([path, init]) => `${init?.method} ${path}`)).toEqual([
      'POST /api/join/code',
      'POST /api/join/code',
    ])
    expect(screen.getAllByText(/works once, within 10 minutes/)).toHaveLength(2)
  })

  it('draws a filled Copy when it is the hero', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer(200, { code: 'ABCD2345', expires_in: 600, command: COMMAND }))))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Join hero machine="laptop" what="the join command" />
      </QueryClientProvider>,
    )
    const copy = await screen.findByRole('button', { name: 'Copy the join command' })
    expect(copy.getAttribute('data-variant')).toBe('filled')
  })

  it('says there is none in a short row, and keeps the daemon’s words behind Details', async () => {
    draw(503, 'the hub does not know its MagicDNS name yet')
    const [row] = await screen.findAllByRole('alert')
    expect(within(row).getByRole('heading', { name: 'The join command could not be made' })).toBeTruthy()
    expect(row.textContent).not.toContain('MagicDNS')
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }))
    expect(within(row).getByText('the hub does not know its MagicDNS name yet')).toBeTruthy()
  })

  /** The own-address refusal is about 250 characters with two shell commands. */
  it('names the proxy, not the commands, when the hub refused its own address', async () => {
    draw(403, "a request from this machine's own address may not act, because any account here could have sent it.")
    const [row] = await screen.findAllByRole('alert')
    expect(within(row).getByRole('heading', { name: 'The proxy hides who is calling' })).toBeTruthy()
    expect(row.textContent).not.toContain('any account here')
  })
})
