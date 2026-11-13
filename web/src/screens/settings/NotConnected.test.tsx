import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { REFUSED } from '@/lib/github'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { githubReadiness } from '@/contract.gen'
import { daemon } from '@/test/daemon'
import { useConnecting } from '@/lib/connecting'
import { keys } from '@/api/keys'
import { NotConnected } from './NotConnected'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function draw(props: Parameters<typeof NotConnected>[0]) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
  daemon(200, githubReadiness)
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NotConnected {...props} />
    </QueryClientProvider>,
  )
}

describe('NotConnected', () => {
  it('draws the title, the reason and a Connect button, and none of the daemon\'s words', () => {
    draw({ why: 'Connect to see the reviews and issues that wait on you.' })
    expect(screen.getByText('GitHub is not connected')).toBeTruthy()
    expect(screen.getByText('Connect to see the reviews and issues that wait on you.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByText(/github login/)).toBeNull()
  })

  it('opens the Connect GitHub dialog in place', async () => {
    draw({ why: 'why' })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('dialog', { name: 'Connect GitHub' })).toBeTruthy()
  })

  it('says REFUSED and offers Sign in again for a refused grant', () => {
    draw({ refused: true, why: 'why' })
    expect(screen.getByText(REFUSED)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
    expect(screen.queryByText('GitHub is not connected')).toBeNull()
  })

  it('stays under an open sheet when its screen stops asking for it, then reads attention again on close', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
    daemon(200, githubReadiness)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    // The parents draw the row while `lacks || connecting`; the grant landing turns `lacks` false.
    function Screen(props: { lacks: boolean }) {
      const connecting = useConnecting()
      return props.lacks || connecting ? <NotConnected why="why" /> : <p>Connected</p>
    }
    const tree = (lacks: boolean) => (
      <QueryClientProvider client={client}>
        <Screen lacks={lacks} />
      </QueryClientProvider>
    )
    const { rerender } = render(tree(true))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('dialog', { name: 'Connect GitHub' })).toBeTruthy()
    rerender(tree(false))
    expect(screen.getByRole('dialog', { name: 'Connect GitHub' })).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: keys.attention() })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Connected')).toBeTruthy()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.attention() }))
  })
})
