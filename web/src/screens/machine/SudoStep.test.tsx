import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import type { Check, Event, Looked, Machine, Readiness } from '@/api'
import type { Target } from '@/api/socket'
import { useMachineReadiness } from '@/api/hooks'
import { keys } from '@/api/keys'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { ReadinessCard } from './Readiness'
import { useVerdict } from './useVerdict'

/* Y-778. A sudo step goes to the owner terminal, through the card that offers
   it. `Terminal.test.tsx` covers the socket; here the terminal records its
   target and the text it was handed to type. */

const opened: { target: Target; typeIn?: string }[] = []

vi.mock('@/screens/session/Terminal', () => ({
  Terminal: (props: { target: Target; typeIn?: string }) => {
    opened.push({ target: props.target, typeIn: props.typeIn })
    return <textarea aria-label="the shell" />
  },
}))

const IDS = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'provider-cli', 'provider-auth', 'login-session', 'folder-access', 'hooks', 'no-sudo', 'heartbeat']
const checks = (absent: string[]): Check[] =>
  IDS.map((id) => ({ check: id, state: absent.includes(id) ? 'absent' : 'present', detail: 'x' }))
const report = (list: Check[]): Looked<Readiness> => ({ looked: 'ok', age_seconds: 0, data: { machine: 'pi', checks: list, age_seconds: 0 } })
const ring = (events: Event[]): Looked<Event[]> => ({ looked: 'ok', age_seconds: 0, data: events })
const machine = { name: 'pi', dns_name: 'pi.ts.net.', os: 'linux', online: true, expired: false, last_seen: null, heartbeat: null } as unknown as Machine

const stopped = (commands: string[]): Event => ({
  at: 200,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi',
  said: 'pi: tmux left for you',
  commands,
})

beforeEach(() => {
  opened.length = 0
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1440 >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** `after` is what a re-check finds once the step has run. */
function daemon(after: string[] = ['agent-cli']) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.endsWith('/install')) return Promise.resolve(answer(202))
      if (path.endsWith('/readiness')) return Promise.resolve(answer(200, report(checks(after))))
      return Promise.resolve(answer(200, ring([])))
    }),
  )
  return asked
}

function Page() {
  const readiness = useMachineReadiness('pi')
  const state = useVerdict('pi', machine, readiness)
  return <ReadinessCard lastSeen={null} name="pi" readiness={readiness} state={state} />
}

/** The card on a result this page did not press for: the missing verdict,
 *  which still shows the commands the install left. */
async function draw(events: Event[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.notifications(), ring(events))
  client.setQueryData(keys.readiness('pi'), report(checks(['tmux', 'agent-cli'])))
  await renderInApp(<Page />, client)
  return client
}

const RECHECK = 'POST /api/machines/pi/readiness'
const keep = (admin: string) => localStorage.setItem('yantra.owner.pi', admin)
const run = () => screen.queryAllByRole('button', { name: 'Run in owner terminal' })
/** A real press puts focus on the button; `fireEvent.click` does not. */
const press = () => {
  run()[0]!.focus()
  fireEvent.click(run()[0]!)
}
const shell = (admin = 'biswa') => screen.findByRole('complementary', { name: `${admin} on pi` })
const close = (title = 'biswa on pi') => fireEvent.click(screen.getByRole('button', { name: `Close ${title}` }))

describe('a sudo step on the machine page', () => {
  it('goes to the owner terminal with the command typed in, and never to the one-off terminal', async () => {
    daemon()
    keep('biswa')
    await draw([stopped(['xcode-select --install', 'sudo apk add tmux'])])
    expect(run()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open a terminal' })).toBeNull()

    press()
    const sheet = within(await shell())
    expect(sheet.getByText('The command is typed in. Read it, press Enter, then type your password.')).toBeTruthy()
    await sheet.findByLabelText('the shell')
    expect(opened.at(-1)).toEqual({ target: { machine: 'pi', owner: 'biswa' }, typeIn: 'sudo apk add tmux' })
    expect(opened.filter((one) => 'step' in one.target)).toEqual([])
  })

  it('asks for the admin account first, refuses a bad name, then opens the shell and keeps the name', async () => {
    const asked = daemon()
    await draw([stopped(['sudo apk add tmux'])])
    press()
    expect(await screen.findByRole('complementary', { name: 'Owner terminal on pi' })).toBeTruthy()
    const name = (text: string) =>
      fireEvent.change(screen.getByRole('textbox', { name: 'Admin account' }), { target: { value: text } })
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open owner terminal' }))

    open()
    expect(screen.getByText('Name the admin account first')).toBeTruthy()
    name('a b')
    expect(screen.getByText('Use letters, digits, ., _ and - only')).toBeTruthy()
    open()
    expect(opened).toHaveLength(0)
    // No shell opened, so nothing on pi changed and readiness is not asked.
    close('Owner terminal on pi')
    expect(asked).not.toContain(RECHECK)

    press()
    name('biswa')
    open()
    await within(await shell()).findByLabelText('the shell')
    expect(opened.at(-1)).toEqual({ target: { machine: 'pi', owner: 'biswa' }, typeIn: 'sudo apk add tmux' })
    expect(localStorage.getItem('yantra.owner.pi')).toBe('biswa')
  })

  it('offers no terminal for a command without sudo', async () => {
    daemon()
    await draw([stopped(['apk add tmux'])])
    expect(screen.getByRole('button', { name: 'Copy the command for pi' })).toBeTruthy()
    expect(run()).toHaveLength(0)
  })

  it('shows a command with a control character and does not type it', async () => {
    daemon()
    keep('biswa')
    await draw([stopped(['sudo apk add tmux \u001b[2J'])])
    expect(screen.getByText(/holds a control character, so Yantra will not type it/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the command for pi' })).toBeTruthy()
    expect(run()).toHaveLength(0)
  })

  it('keeps Escape for the shell', async () => {
    daemon()
    keep('biswa')
    await draw([stopped(['sudo apk add tmux'])])
    press()
    const sheet = await shell()
    fireEvent.keyDown(await within(sheet).findByLabelText('the shell'), { key: 'Escape' })
    expect(sheet.hidden).toBe(false)
  })

  it('asks readiness again when the sheet closes, and gives focus back to the button', async () => {
    const asked = daemon()
    keep('biswa')
    await draw([stopped(['sudo apk add tmux'])])
    press()
    await shell()
    expect(asked).not.toContain(RECHECK)
    close()
    await waitFor(() => expect(asked).toContain(RECHECK))
    expect(document.activeElement).toBe(run()[0])
  })

  /** The recheck that the close starts finds the step done, so the button
   *  goes while it holds focus. */
  it('puts focus on the card’s title when the recheck takes the button away', async () => {
    daemon([])
    keep('biswa')
    await draw([stopped(['sudo apk add tmux'])])
    press()
    await shell()
    close()
    const ready = await screen.findByRole('heading', { name: 'Ready for sessions' })
    expect(run()).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(ready))
  })

  /** A poll or Check again can find the step done while the shell is open. */
  it('keeps the shell open when its button goes, and closes onto the card’s title', async () => {
    daemon([])
    keep('biswa')
    const client = await draw([stopped(['sudo apk add tmux'])])
    press()
    const sheet = await shell()
    await within(sheet).findByLabelText('the shell')
    act(() => client.setQueryData(keys.readiness('pi'), report(checks([]))))
    const ready = await screen.findByRole('heading', { name: 'Ready for sessions' })
    expect(run()).toHaveLength(0)
    expect(sheet.hidden).toBe(false)
    expect(opened).toHaveLength(1)

    close()
    await waitFor(() => expect(document.activeElement).toBe(ready))
  })
})
