import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { runsSessions } from '@/lib/platform'
import { mount, unmount } from '@/shell/harness'

// The chat's own behaviour is session/Chat.test.tsx's; here it shows what the screen hands it.
vi.mock('@/screens/session/Chat', () => ({
  Chat: (props: { target: { kind: string; machine?: string }; thread?: string; onThread: (id: string) => void }) => (
    <section aria-label="Chat" data-target={JSON.stringify(props.target)} data-thread={props.thread ?? ''}>
      <button onClick={() => props.onThread('6a1b2c3d4e5f6a7b')} type="button">
        name the thread
      </button>
    </section>
  ),
}))

afterEach(() => {
  cleanup()
  unmount()
})

const machine = contract.machines.data.find((one) => runsSessions(one))!.name

describe('the home chat route', () => {
  it('renders Chat with the home target of the machine, and the thread the URL names', async () => {
    mount('desktop', `/m/${machine}/home?thread=1a2b3c4d`)
    const chat = await screen.findByRole('region', { name: 'Chat' })
    expect(JSON.parse(chat.getAttribute('data-target')!)).toEqual({ kind: 'home', machine })
    expect(chat.getAttribute('data-thread')).toBe('1a2b3c4d')
    expect(document.title).toBe(`Home on ${machine} · Yantra`)
  })

  it('puts the thread the chat names in the URL, replacing the entry', async () => {
    const before = history.length
    mount('desktop', `/m/${machine}/home`)
    fireEvent.click(await screen.findByRole('button', { name: 'name the thread' }))
    await waitFor(() => expect(location.search).toBe('?thread=6a1b2c3d4e5f6a7b'))
    expect(history.length).toBeLessThanOrEqual(before + 1)
  })

  it('reads the thread as the workspace route does: an empty one is none', async () => {
    mount('desktop', `/m/${machine}/home?thread=`)
    const chat = await screen.findByRole('region', { name: 'Chat' })
    expect(chat.getAttribute('data-thread')).toBe('')
  })

  it('says so, with a typed surface, for a machine the list does not have', async () => {
    mount('desktop', '/m/no-such-box/home')
    expect(await screen.findByRole('heading', { name: 'No machine is called no-such-box' })).toBeTruthy()

    expect(screen.getByText('The tailnet has no machine called no-such-box.')).toBeTruthy()
    expect((screen.getAllByRole('link', { name: 'Machines' }).find((a) => a.classList.contains('m3-not-found__way')))?.getAttribute('href')).toBe('/machines')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull()
  })

  it('says so when the machines cannot be read', async () => {
    mount('desktop', `/m/${machine}/home`, {
      overrides: { '/api/machines': { body: { looked: 'failed', age_seconds: 0, error: 'tailscale did not answer' } } },
    })
    const title = await screen.findByText('The machines could not be read')
    const alert = title.closest('[role="alert"]') as HTMLElement
    fireEvent.click(within(alert).getByRole('button', { name: 'Details' }))
    expect(within(alert).getByText('tailscale did not answer')).toBeTruthy()
    expect(alert.textContent).not.toContain('off the tailnet')
  })
})
