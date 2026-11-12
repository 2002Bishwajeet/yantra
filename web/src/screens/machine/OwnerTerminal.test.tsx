import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import type { Target } from '@/api/socket'
import { sshIdentity } from '@/contract.gen'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { OwnerTerminal } from './OwnerTerminal'

/* Y-701. The card and the sheet around the owner terminal. The terminal is
   `Terminal.test.tsx`'s, against a real socket; here it is a stand-in that
   says which target it was handed and ends when told to. */

const opened: Target[] = []

vi.mock('@/screens/session/Terminal', () => ({
  Terminal: (props: { target: Target; onExit?: (exit: number | null) => void }) => {
    opened.push(props.target)
    return (
      <div>
        <button onClick={() => props.onExit?.(0)} type="button">
          the shell exits
        </button>
        <button onClick={() => props.onExit?.(255)} type="button">
          ssh is refused
        </button>
      </div>
    )
  },
}))

let width = 1440

beforeEach(() => {
  opened.length = 0
  width = 1440
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function identity(status: number, body?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(answer(status, body))),
  )
}

async function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await renderInApp(<OwnerTerminal machine="pi" />, client)
}

const card = () => within(screen.getByRole('region', { name: 'Owner terminal' }))
const field = () => card().getByRole('textbox', { name: 'Admin account' })
const type = (text: string) => fireEvent.change(field(), { target: { value: text } })
const press = () => fireEvent.click(card().getByRole('button', { name: 'Open owner terminal' }))

describe('the owner terminal card', () => {
  it('shows the authorized_keys line with from=, and copies it', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    identity(200, sshIdentity)
    await draw()
    expect(await card().findByText(sshIdentity.owner_line)).toBeTruthy()
    expect(sshIdentity.owner_line.startsWith('from="')).toBe(true)
    type('biswa')
    expect(card().getByText('~biswa/.ssh/authorized_keys')).toBeTruthy()
    fireEvent.click(card().getByRole('button', { name: 'Copy the authorized_keys line' }))
    expect(await card().findByRole('button', { name: 'Copied the authorized_keys line' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(sshIdentity.owner_line)
  })

  it('says to run yantra ssh-identity when the hub has no key', async () => {
    identity(404, { error: 'no ssh identity yet' })
    await draw()
    expect(await card().findByText(/The hub has no ssh key yet/)).toBeTruthy()
    expect(card().getByText('yantra ssh-identity')).toBeTruthy()
  })

  it('draws a failed read inline', async () => {
    identity(500, { error: 'could not read /home/x/.ssh/id_yantra.pub' })
    await draw()
    expect(await card().findByText("The hub's key could not be read")).toBeTruthy()
  })

  it('puts the line behind a disclosure on the phone', async () => {
    width = 390
    identity(200, sshIdentity)
    await draw()
    expect(card().queryByText(sshIdentity.owner_line)).toBeNull()
    fireEvent.click(card().getByRole('button', { name: /^Show/ }))
    expect(await card().findByText(sshIdentity.owner_line)).toBeTruthy()
  })

  it('refuses a bad name inline, and asks for one before it opens', async () => {
    identity(200, sshIdentity)
    await draw()
    press()
    expect(card().getByText('Name the admin account first')).toBeTruthy()
    type('-x')
    expect(card().getByText('An account name cannot start with - or .')).toBeTruthy()
    type('a b')
    expect(card().getByText('Use letters, digits, ., _ and - only')).toBeTruthy()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    press()
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(opened).toHaveLength(0)
  })

  it('remembers the name for this machine', async () => {
    identity(200, sshIdentity)
    await draw()
    type('biswa')
    expect(localStorage.getItem('yantra.owner.pi')).toBe('biswa')
    cleanup()
    await draw()
    expect((field() as HTMLInputElement).value).toBe('biswa')
  })

  it('opens without storage, where the browser refuses it', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    identity(200, sshIdentity)
    await draw()
    expect((field() as HTMLInputElement).value).toBe('')
    type('biswa')
    press()
    expect(await screen.findByText('the shell exits')).toBeTruthy()
  })
})

describe('the owner terminal sheet', () => {
  const sheet = () => within(screen.getByRole('complementary', { name: 'biswa on pi' }))

  it('opens on the machine as the admin account, and says the shell ended', async () => {
    identity(200, sshIdentity)
    await draw()
    type('biswa')
    press()
    expect(sheet().getByText(/You are biswa on pi/)).toBeTruthy()
    fireEvent.click(await sheet().findByText('the shell exits'))
    expect(opened.at(-1)).toEqual({ machine: 'pi', owner: 'biswa' })
    expect(sheet().getByText('The shell ended.')).toBeTruthy()
  })

  it('says what a 255 from ssh means', async () => {
    identity(200, sshIdentity)
    await draw()
    type('biswa')
    press()
    fireEvent.click(await sheet().findByText('ssh is refused'))
    expect(sheet().getByText(/refused the key or could not be reached/)).toBeTruthy()
  })

  it('keeps Escape in the terminal, and closing hangs up', async () => {
    identity(200, sshIdentity)
    await draw()
    type('biswa')
    press()
    const pane = await sheet().findByText('the shell exits')
    fireEvent.keyDown(pane, { key: 'Escape' })
    expect(screen.getByRole('complementary', { name: 'biswa on pi' })).toBeTruthy()
    fireEvent.click(sheet().getByRole('button', { name: 'Close biswa on pi' }))
    expect(screen.queryByText('the shell exits')).toBeNull()
  })

  it('keeps the account it opened as while the field is edited', async () => {
    identity(200, sshIdentity)
    await draw()
    type('biswa')
    press()
    await sheet().findByText('the shell exits')
    type('other')
    expect(opened.every((target) => 'owner' in target && target.owner === 'biswa')).toBe(true)
  })
})
