import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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

  it('says why there is none, in the daemon’s words', async () => {
    draw(503, 'the hub does not know its MagicDNS name yet')
    expect((await screen.findAllByText(/the join command could not be made/))[0].textContent).toContain(
      'the hub does not know its MagicDNS name yet',
    )
  })
})
