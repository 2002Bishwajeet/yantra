import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import type { Check, Event, Looked, Machine, Readiness } from '@/api'
import { useMachineReadiness } from '@/api/hooks'
import { keys } from '@/api/keys'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { CHANGED_KEY, CHECK_RULE } from '@/test/sshSaid'
import { ReadinessCard } from './Readiness'
import { useVerdict } from './useVerdict'
import { chipOf, verdictOf } from './verdict'

// The sudo sheet reads the form factor, and jsdom has no `matchMedia`.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1440 >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
})

const IDS = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'provider-cli', 'provider-auth', 'login-session', 'folder-access', 'hooks', 'no-sudo', 'heartbeat']

const checks = (absent: string[] = [], detail: Record<string, string> = {}): Check[] =>
  IDS.map((id) => ({
    check: id,
    state: absent.includes(id) ? 'absent' : 'present',
    detail: detail[id] ?? (absent.includes(id) ? `no \`${id}\` there` : 'found'),
  }))

/** doctor.rs `no_login_server`, word for word. */
const NO_SERVER =
  'no tmux server from a login session is running on this Mac. Panes in a server started over ssh cannot read the login keychain, so Yantra starts one in the login session when a session starts. Start one in Terminal there: `tmux -L yantra new-session -d`'

const report = (list: Check[]): Looked<Readiness> => ({ looked: 'ok', age_seconds: 0, data: { machine: 'pi', checks: list, age_seconds: 0 } })

const machine = (over: Partial<Machine> = {}) =>
  ({ name: 'pi', dns_name: 'pi.ts.net.', os: 'linux', online: true, expired: false, last_seen: null, heartbeat: null, ...over }) as Machine

const earlier: Event = { at: 100, kind: 'relay-test', workspace: null, machine: null, said: 'yantra can reach this topic', commands: [] }

const stopped: Event = {
  at: 200,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi',
  said: 'pi: claude installed; tmux left for you: sudo asks for a password — run `sudo apk add tmux` on pi',
  commands: ['sudo apk add tmux'],
}

const ring = (events: Event[]): Looked<Event[]> => ({ looked: 'ok', age_seconds: 0, data: events })

const ABOUT = {
  version: '0.2.0',
  target: 'x86_64-unknown-linux-gnu',
  built: '2026-09-13',
  uptime_seconds: 1,
  listening_on: ['100.64.0.1:7717'],
  tailnet: null,
  relay: false,
  published: { looked: 'never' },
}

/** Every call answered by path, as `yantrad` would. `after` is what a
 *  re-check finds. */
function daemon(install: [number, string?] = [202], after: Check[] = checks(), about: typeof ABOUT = ABOUT) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.split('?')[0]!.endsWith('/install')) return Promise.resolve(answer(install[0], install[1]))
      if (path.endsWith('/readiness')) return Promise.resolve(answer(200, report(after)))
      if (path === '/api/about') return Promise.resolve(answer(200, about))
      return Promise.resolve(answer(200, ring([earlier])))
    }),
  )
  return asked
}

function Page(props: { machine: Machine; lastSeen?: string }) {
  const readiness = useMachineReadiness('pi')
  const state = useVerdict('pi', props.machine, readiness)
  return <ReadinessCard lastSeen={props.lastSeen ?? null} name="pi" readiness={readiness} state={state} />
}

async function draw(
  readiness: Looked<Readiness>,
  events: Event[] = [earlier],
  options: { machine?: Machine; lastSeen?: string } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.notifications(), ring(events))
  client.setQueryData(keys.readiness('pi'), readiness)
  await renderInApp(<Page lastSeen={options.lastSeen} machine={options.machine ?? machine()} />, client)
  return client
}

const card = () => within(screen.getByRole('region', { name: 'Readiness' }))
/** The microphone's box and Install wait inside the closed Optional row on a machine that can start sessions. */
const showOptional = () => fireEvent.click(card().getByRole('button', { name: /^Show Optional: microphone/ }))

/** The folded checks; the button named "What ssh said" is the other disclosure. */
const openChecks = () => fireEvent.click(card().getByRole('button', { name: /^Show (?!What ssh said)/ }))
/** The first closed Fix row; its command and words are mounted only once it opens. */
const pressFix = () => fireEvent.click(card().getAllByRole('button', { name: /^Fix/ })[0]!)
const openSaid = () => fireEvent.click(card().getByRole('button', { name: /^Show What ssh said/ }))

describe('the counts on a machine with optional checks absent', () => {
  const list = [...checks(['provider-cli', 'hooks', 'heartbeat']), { check: 'mic', state: 'absent', detail: 'not installed' } as Check]

  /** Y-580: the chip, the title and the rows count the same checks. */
  it('agrees: chip N, title N and the needs-marked rows are one number', async () => {
    daemon()
    await draw(report(list))
    openChecks()
    const rows = [...document.querySelectorAll('.machine__check')]
    const needs = rows.filter((one) => one.querySelector('.m3-state')?.getAttribute('data-state') === 'needs')
    expect(needs).toHaveLength(3)
    // Y-714: a passing check has no row; the three that need you and the optional one do.
    expect(rows).toHaveLength(4)

    const verdict = verdictOf({ name: 'pi', machine: machine(), readiness: report(list), events: [], watch: null })
    expect(chipOf(verdict, null).word).toBe(`ready · ${needs.length} to fix`)
    expect(card().getByRole('heading', { name: `${needs.length} checks need you` })).toBeTruthy()

    expect(card().getByText(new RegExp(`^10 of ${list.length} · asked`))).toBeTruthy()
  })

  it('draws the absent microphone idle, with the word optional', async () => {
    daemon()
    await draw(report(list))
    openChecks()
    const mic = [...document.querySelectorAll('.machine__check')].find((one) => one.textContent?.includes('microphone'))!
    expect(mic.querySelector('.m3-state')?.getAttribute('data-state')).toBe('idle')
    expect(within(mic as HTMLElement).getByText('optional')).toBeTruthy()
  })

  it('names no ADR, invariant, beat or yantra-agent on any row', async () => {
    daemon()
    const everything = list.map((one) => ({ ...one, state: 'absent' as const }))
    await draw(report(everything))
    expect([...document.querySelectorAll('.machine__check')].map((one) => one.textContent).join(' ')).not.toMatch(/ADR-\d|I-\d\d|beat|yantra-agent/)
  })
})

describe('the Readiness card', () => {
  it('leads with Ready for sessions and New session when nothing is absent', async () => {
    daemon()
    await draw(report(checks()))
    expect(card().getByRole('heading', { name: 'Ready for sessions' })).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
    expect(card().queryByRole('button', { name: 'Install' })).toBeNull()
  })

  /** ADR-0031 §1, §9: the microphone is optional, offered unticked beside
   *  Install, and ready stays ready without it. */
  it('offers the microphone on a ready machine, unticked, and sends it only when ticked', async () => {
    const asked = daemon()
    await draw(report([...checks(), { check: 'mic', state: 'absent', detail: 'not installed — the microphone is optional' }]))
    expect(card().getByRole('heading', { name: 'Ready for sessions' })).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
    showOptional()
    const box = card().getByRole('checkbox', { name: 'Microphone' }) as HTMLInputElement
    expect(box.checked).toBe(false)
    box.focus()
    expect(document.activeElement).toBe(box)

    fireEvent.click(box)
    expect(box.checked).toBe(true)
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/install?mic=true'))
  })

  /** On a ready machine the microphone is all Install could do, so Install
   *  waits for the box; an absent microphone is a row of its own, marked optional. */
  it.each([
    ['ready', [] as string[], 'Ready for sessions', '13 of 14'],
    ['manual', ['provider-auth'], 'gh is not signed in', '12 of 14'],
  ])('enables Install on a %s machine only while Microphone is ticked', async (_, absent, title, count) => {
    daemon()
    await draw(report([...checks(absent), { check: 'mic', state: 'absent', detail: 'not installed' }]))
    expect(card().getByRole('heading', { name: title })).toBeTruthy()
    expect(card().getByText(new RegExp(`^${count} · asked`))).toBeTruthy()
    showOptional()
    const install = card().getByRole('button', { name: 'Install' })
    expect(install.hasAttribute('disabled')).toBe(true)
    fireEvent.click(card().getByRole('checkbox', { name: 'Microphone' }))
    expect(install.hasAttribute('disabled')).toBe(false)
    fireEvent.click(card().getByRole('checkbox', { name: 'Microphone' }))
    expect(install.hasAttribute('disabled')).toBe(true)
  })

  /** A Mac has no PipeWire, so its install can never set the microphone up. */
  it('never offers the microphone on a Mac', async () => {
    daemon()
    await draw(report([...checks(), { check: 'mic', state: 'absent', detail: 'not installed' }]), [earlier], {
      machine: machine({ os: 'macOS' }),
    })
    expect(card().getByRole('heading', { name: 'Ready for sessions' })).toBeTruthy()
    expect(card().queryByRole('checkbox', { name: 'Microphone' })).toBeNull()
    expect(card().queryByRole('button', { name: 'Install' })).toBeNull()
  })

  /** ADR-0031 §2: linger is the step sudo stopped, and the one-off terminal runs it. */
  it('leaves linger for a person when sudo asks, with a terminal for it', async () => {
    const mic: Check = { check: 'mic', state: 'absent', detail: 'not installed' }
    daemon([202], [...checks(), mic])
    const client = await draw(report([...checks(), mic]))
    showOptional()
    fireEvent.click(card().getByRole('checkbox', { name: 'Microphone' }))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing on pi' })

    const linger: Event = {
      ...stopped,
      at: 300,
      said: 'pi: mic left for you: it needs root, and sudo asks for a password or a terminal there',
      commands: ['sudo loginctl enable-linger biswa'],
    }
    act(() => client.setQueryData(keys.notifications(), ring([linger, earlier])))

    await card().findByRole('heading', { name: 'microphone needs your password' })
    // Y-733: one sentence, and the command is one line that scrolls.
    expect(card().getByText(/^sudo on pi wants a password/).textContent).toBe('sudo on pi wants a password; run this there.')
    expect(card().getByText('sudo loginctl enable-linger biswa').classList.contains('m3-copyable__text--line')).toBe(true)
    expect(card().getByRole('button', { name: 'Open a terminal' })).toBeTruthy()
  })

  /** ADR-0031 §1: on a ready machine, a package step sudo stopped is the microphone's. */
  it('asks for the microphone’s package step when sudo asks on a ready machine', async () => {
    const mic: Check = { check: 'mic', state: 'absent', detail: 'not installed' }
    daemon([202], [...checks(), mic])
    const client = await draw(report([...checks(), mic]))
    showOptional()
    fireEvent.click(card().getByRole('checkbox', { name: 'Microphone' }))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing on pi' })

    const command = 'sudo apt-get install -y pipewire pipewire-pulse wireplumber'
    const packages: Event = {
      ...stopped,
      at: 300,
      said: 'pi: mic left for you: it needs root, and sudo asks for a password or a terminal there',
      commands: [command],
    }
    act(() => client.setQueryData(keys.notifications(), ring([packages, earlier])))

    await card().findByRole('heading', { name: 'microphone needs your password' })
    expect(card().getByText(command)).toBeTruthy()
  })

  it('installs the basics alone while Microphone is unticked', async () => {
    const asked = daemon()
    await draw(report([...checks(['tmux']), { check: 'mic', state: 'absent', detail: 'not installed' }]))
    expect(card().getByRole('checkbox', { name: 'Microphone' })).toBeTruthy()
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/install'))
    expect(asked).not.toContain('POST /api/machines/pi/install?mic=true')
  })

  it('offers no microphone where doctor found one', async () => {
    daemon()
    await draw(report([...checks(), { check: 'mic', state: 'present', detail: 'PipeWire has the source yantra-mic' }]))
    expect(card().queryByRole('checkbox', { name: 'Microphone' })).toBeNull()
    expect(card().queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('names what is missing and offers Install, not a session', async () => {
    daemon()
    await draw(report(checks(['tmux', 'agent-cli'])))
    expect(card().getByRole('heading', { name: 'tmux and claude are missing' })).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(card().queryByRole('link', { name: 'New session' })).toBeNull()
  })

  it('runs after the 202, then asks for the password step, with Copy, and asks readiness again', async () => {
    const asked = daemon([202], checks(['tmux']))
    const client = await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))

    await card().findByRole('heading', { name: 'Installing tmux' })
    expect(asked).toContain('POST /api/machines/pi/install')
    expect(card().getByRole('progressbar', { name: 'Installing on pi' })).toBeTruthy()
    expect(card().getByRole('status').textContent).toContain('Running in the background')
    expect(card().queryByRole('button', { name: 'Install' })).toBeNull()

    act(() => client.setQueryData(keys.notifications(), ring([stopped, earlier])))

    await card().findByRole('heading', { name: 'tmux needs your password' })
    expect(card().getByText('sudo apk add tmux')).toBeTruthy()
    expect(card().getByRole('button', { name: 'Copy the command for pi' })).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install again' })).toBeTruthy()
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/readiness'))
  })

  it('says the machine is ready once the install lands and the re-check agrees', async () => {
    daemon([202], checks())
    const client = await draw(report(checks(['git'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing git' })
    const done: Event = { ...stopped, at: 300, kind: 'installed', said: 'pi: git installed', commands: [] }
    act(() => client.setQueryData(keys.notifications(), ring([done, earlier])))
    await card().findByRole('heading', { name: 'Ready for sessions' })
    expect(await screen.findByText('pi is ready for sessions')).toBeTruthy()
  })

  it('shows the last result, and its commands, before anything is pressed', async () => {
    daemon()
    await draw(report(checks(['tmux'])), [stopped, earlier])
    expect(card().getByRole('heading', { name: 'tmux is missing' })).toBeTruthy()
    expect(card().getByText(/The install stopped · the last install/)).toBeTruthy()
    expect(card().getByText('sudo apk add tmux')).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install again' })).toBeTruthy()
  })

  it('reads a 409 as an install already running, and waits for it', async () => {
    daemon([409, 'an install is already running on pi'])
    await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing tmux' })
    expect(card().getByRole('status').textContent).toContain('An install was already running on pi.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    [403, 'node biswas-iphone is on this tailnet but is not yours', 'not on a node'],
    [400, '`pi x` is not a machine name Yantra passes to ssh', 'would not take'],
    [503, 'tailscale whois failed: no tailscaled', 'Nothing could be asked'],
  ])('draws a %i as a refusal with the daemon’s words', async (status, said, sentence) => {
    daemon([status, said])
    await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Install did not start')
    expect(alert.textContent).toContain(sentence)
    expect(alert.textContent).toContain(said)
    expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('draws a daemon that did not answer, with Try again', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        asked.push(`${init?.method ?? 'GET'} ${path}`)
        return Promise.reject(new TypeError('Failed to fetch'))
      }),
    )
    await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The daemon did not answer.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(asked.filter((one) => one.endsWith('/install'))).toHaveLength(2))
  })

  it('says so when the result cannot be read while it waits', async () => {
    daemon()
    const client = await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing tmux' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer(403, 'not yours'))))
    await act(() => client.refetchQueries({ queryKey: keys.notifications() }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The result could not be read')
  })

  it('says when no result arrives and lets the person stop waiting', async () => {
    daemon()
    await draw(report(checks(['tmux'])))
    const start = Date.now()
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing tmux' })
    // The card's one-second clock is already running, so the next real tick
    // reads the moved instant.
    const later = vi.spyOn(Date, 'now').mockReturnValue(start + 17 * 60_000)
    try {
      await waitFor(() => expect(card().getByRole('status').textContent).toContain('No result arrived'), {
        timeout: 2_500,
      })
      fireEvent.click(card().getByRole('button', { name: 'Stop waiting' }))
      // Nothing answered, so there is no last result to install again after.
      expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
    } finally {
      later.mockRestore()
    }
  })

  it('says a date as a date for a machine last seen long ago', async () => {
    daemon()
    await draw(report(checks(['tmux'])), [earlier], { machine: machine({ online: false }), lastSeen: '8 Oct' })
    expect(card().getByText('Last seen on 8 Oct · Yantra asks again when it comes back.')).toBeTruthy()
  })

  it('is asleep for a machine the tailnet says is off, and offers nothing to press', async () => {
    daemon()
    await draw(report(checks(['tmux'])), [earlier], { machine: machine({ online: false }), lastSeen: '3h' })
    expect(card().getByRole('heading', { name: 'pi is asleep' })).toBeTruthy()
    expect(card().getByText('Last seen 3h ago · Yantra asks again when it comes back.')).toBeTruthy()
    expect(card().queryByRole('button')).toBeNull()
  })

  it('reads a machine nobody asked as Not checked yet, with Check', async () => {
    const asked = daemon()
    await draw({ looked: 'never' })
    expect(card().getByRole('heading', { name: 'Not checked yet' })).toBeTruthy()
    expect(card().queryByText(/has not asked/)).toBeNull()
    expect(card().queryByRole('button', { name: 'Check again' })).toBeNull()
    fireEvent.click(card().getByRole('button', { name: 'Check' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/readiness'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hands a refused key the join command', async () => {
    daemon()
    await draw(report(checks(['reachable'], { reachable: 'yantra@pi: Permission denied (publickey).' })))
    expect(card().getByRole('heading', { name: 'The key was refused' })).toBeTruthy()
    expect(await card().findByText('curl -fsSL http://100.64.0.1:7717/join | sh')).toBeTruthy()
  })

  /** Y-412: doctor's words for a machine no ssh config block names. */
  it('sends a machine that never joined to the join command and Add a device', async () => {
    daemon()
    const said =
      'the ssh config here names no account for pi, so ssh tried `yantra` — run the join command on pi ' +
      '(Add a device, or `yantra join-script`) · Connection closed by 100.64.0.2 port 22'
    await draw(report(checks(['reachable'], { reachable: said })))
    expect(card().getByRole('heading', { name: 'pi has not joined' })).toBeTruthy()
    expect(card().getByText(/does not know which account/)).toBeTruthy()
    expect(card().queryByText(said)).toBeNull()
    fireEvent.click(card().getByRole('button', { name: /What ssh said/ }))
    expect(card().getAllByText(said).length).toBeGreaterThan(0)
    expect(card().getByRole('link', { name: 'Add a device' }).getAttribute('href')).toBe('/machines/add')
    expect(await card().findByText('curl -fsSL http://100.64.0.1:7717/join | sh')).toBeTruthy()
  })

  /** Y-585: the plain words first, one next step, and the raw text one press
   *  away with no link in it. */
  it('tells a browser check in plain words and keeps ssh’s own behind a press', async () => {
    daemon()
    const said = 'Tailscale SSH requires an additional check, which needs a browser sign-in that Yantra cannot finish, so ssh was stopped'
    await draw(report(checks(['reachable'], { reachable: said })))
    expect(card().getByRole('heading', { name: 'pi needs a browser sign-in' })).toBeTruthy()
    expect(card().getByText(/waits for a browser sign-in, and the appliance has no browser/)).toBeTruthy()
    expect(card().getByText(/from check to accept/)).toBeTruthy()
    expect(await card().findByText('curl -fsSL http://100.64.0.1:7717/join | sh')).toBeTruthy()

    const press = card().getByRole('button', { name: /What ssh said/ })
    expect(press.getAttribute('aria-expanded')).toBe('false')
    expect(card().queryByText(said)).toBeNull()
    expect(card().queryByRole('link', { name: /login.tailscale/ })).toBeNull()

    fireEvent.click(press)
    expect(card().getAllByText(said).length).toBeGreaterThan(0)
    // Only checks that are not present are listed: tmux and the rest passed.
    expect(card().queryByText('tmux')).toBeNull()
  })

  /** Y-621: the two lines a daemon before v0.10.1 sends. The sign-in link is
   *  dead once ssh ends, so it is nowhere on the page, open or closed. */
  it('reads Tailscale’s real check text with the new cause, the join command and no link', async () => {
    daemon()
    await draw(report(checks(['reachable'], { reachable: CHECK_RULE })))
    expect(card().getByRole('heading', { name: 'pi needs a browser sign-in' })).toBeTruthy()
    expect(card().getByText('Tailscale SSH on pi waits for a browser sign-in, and the appliance has no browser.')).toBeTruthy()
    expect(await card().findByText('curl -fsSL http://100.64.0.1:7717/join | sh')).toBeTruthy()
    expect(card().getByRole('button', { name: /^Check/ })).toBeTruthy()
    fireEvent.click(card().getByRole('button', { name: /What ssh said/ }))
    expect(card().getAllByText(/Tailscale SSH requires an additional check\./).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('login.tailscale.com')
  })

  /** Y-621: a changed key names the forget command and never the join command. */
  it('names yantra forget-host-key for a changed host key, and keeps Check', async () => {
    daemon()
    await draw(report(checks(['reachable'], { reachable: CHANGED_KEY })))
    expect(card().getByRole('heading', { name: 'pi’s host key changed' })).toBeTruthy()
    expect(card().getByText(/pi answered with a different host key than the one the appliance recorded/)).toBeTruthy()
    expect(card().getByText(/If you know why it changed/)).toBeTruthy()
    expect(card().getByText('sudo -u yantra -H yantra forget-host-key pi')).toBeTruthy()
    expect(card().getByRole('button', { name: /^Check/ })).toBeTruthy()
    expect(card().queryByText(/curl -fsSL/)).toBeNull()
    expect(card().queryByText(/REMOTE HOST IDENTIFICATION/)).toBeNull()
  })

  /** R-23 on the page: every failure has words of its own, and none shows
   *  raw ssh until it is asked for. */
  it.each([
    ['yantra@pi: Permission denied (publickey).', 'The key was refused', /did not take the appliance’s key/, true],
    ['No route to host', 'ssh to pi fails', /can’t reach pi over ssh/, false],
  ])('keeps the raw text closed for %s', async (said, title, cause, join) => {
    daemon()
    await draw(report(checks(['reachable'], { reachable: said })))
    expect(card().getByRole('heading', { name: title })).toBeTruthy()
    expect(card().getByText(cause)).toBeTruthy()
    expect(card().queryByText(said)).toBeNull()
    if (join) expect(await card().findByText('curl -fsSL http://100.64.0.1:7717/join | sh')).toBeTruthy()
    else expect(card().queryByText(/curl -fsSL/)).toBeNull()
  })

  it('says how long a step took, and nothing where no step ran', async () => {
    daemon()
    const timed = checks(['tmux']).map((one) => (one.check === 'tmux' ? { ...one, took_ms: 84 } : one))
    await draw(report(timed))
    pressFix()
    expect(card().getByText('84 ms')).toBeTruthy()
    expect(document.querySelectorAll('.machine__detail')).toHaveLength(1)
  })

  it('puts a manual fix beside its check, and still offers a session', async () => {
    daemon()
    await draw(report(checks(['provider-auth'])))
    expect(card().getByRole('heading', { name: 'gh is not signed in' })).toBeTruthy()
    expect(card().queryByText('gh auth login')).toBeNull()
    pressFix()
    expect(card().getByText('gh auth login')).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
  })

  /** Y-619: a Mac with no login tmux server is signed in, so the card gives
   *  the Terminal command and never sends the owner to log in. */
  it('gives a Mac with no login tmux server the Terminal command, with Copy', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    daemon()
    const both = { 'login-session': NO_SERVER, 'provider-auth': NO_SERVER }
    await draw(report(checks(['login-session', 'provider-auth'], both)), [earlier], { machine: machine({ os: 'macOS' }) })
    expect(card().getByRole('heading', { name: 'No tmux server from a login on pi' })).toBeTruthy()
    // The first check carries the fix; the second is listed without one (Y-714).
    pressFix()
    expect(card().getAllByText('Open Terminal on pi and run:')).toHaveLength(1)
    expect(card().getAllByText('tmux -L yantra new-session -d')).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Readiness' }).textContent).not.toMatch(/log in|sign in/i)
    fireEvent.click(card().getByRole('button', { name: 'Copy the command that fixes gh signed in' }))
    expect(await card().findByRole('button', { name: 'Copied the command that fixes gh signed in' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('tmux -L yantra new-session -d')
  })

  /** Y-713: an agent older than the daemon is titled with both versions, never as missing, and gets the command that updates it. */
  it('names both versions of an older agent and gives the command that updates it, with Copy', async () => {
    daemon()
    const command = 'curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | YANTRA_VERSION=0.11.0 bash'
    const said = { heartbeat: `yantra-agent here is v0.3.2 and yantrad is v0.11.0. Update it on pi: \`${command}\`` }
    await draw(report(checks(['heartbeat'], said)), [earlier], { machine: machine({ os: 'macOS' }) })
    expect(card().getByRole('heading', { name: 'yantra-agent on pi is v0.3.2; yantrad is v0.11.0' })).toBeTruthy()
    expect(card().getByText('behind')).toBeTruthy()
    expect(card().getByText('installed; update it')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Readiness' }).textContent).not.toMatch(/missing/)
    expect(card().queryByRole('button', { name: /What ssh said/ })).toBeNull()
    expect(card().queryByText(command)).toBeNull()
    pressFix()
    expect(card().getByText('Run this on pi:')).toBeTruthy()
    expect(card().getByText(command)).toBeTruthy()
    expect(card().getByRole('button', { name: 'Copy the command that fixes yantra-agent' })).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
  })

  /** Y-713: an agent that sends no version predates the field, so it is older too. */
  it('says an agent with no version is older than the daemon', async () => {
    daemon()
    const said = { heartbeat: 'yantra-agent here sends no version, so it predates yantrad v0.11.0. Update it on pi: `curl x | bash`' }
    await draw(report(checks(['heartbeat'], said)), [earlier], { machine: machine({ os: 'macOS' }) })
    expect(card().getByRole('heading', { name: 'yantra-agent on pi is older than yantrad v0.11.0' })).toBeTruthy()
    expect(card().getByText('behind')).toBeTruthy()
    expect(card().getByText('installed; update it')).toBeTruthy()
  })

  /** Y-740: the hub's claude links into a home the daemon's account cannot enter. */
  it('says a claude this account cannot run is installed, and that Install puts it in this account’s home', async () => {
    daemon()
    const said =
      'claude is installed at /usr/local/bin/claude, but this account cannot run it. The file, or a directory it links through, is closed to this account. Install puts claude where this account can run it'
    const closed = checks(['agent-cli'], { 'agent-cli': said }).map((one): Check =>
      one.check === 'login-session' ? { ...one, state: 'unknown', detail: 'the gate runs `claude` inside that machine’s tmux server, and this account cannot run one of the two there' } : one,
    )
    await draw(report(closed))
    expect(card().getByRole('heading', { name: 'claude is installed, but this account cannot run it' })).toBeTruthy()
    expect(card().getByText('installed, no access; Install')).toBeTruthy()
    expect(card().getByText('Install puts claude in this account’s home on pi, with the vendor’s installer.')).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Readiness' }).textContent).not.toMatch(/missing|not found/)
    pressFix()
    expect(card().getAllByText(said).length).toBeGreaterThan(0)
    openSaid()
    expect(screen.getByRole('region', { name: 'Readiness' }).textContent).not.toMatch(/missing|not found/)
  })

  /** Y-591: a warning with the fix and its cost, and never a block on a session. */
  it('warns that macOS blocks the guarded folders, and still offers a session', async () => {
    daemon()
    await draw(report(checks(['folder-access'])), [earlier], { machine: machine({ os: 'macOS' }) })
    expect(card().getByRole('heading', { name: 'macOS blocks Desktop, Documents and Downloads' })).toBeTruthy()
    pressFix()
    expect(card().getByText(/Allow full disk access for remote users\. Every ssh login to pi, agents included/)).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
  })

  /** Y-640: the detail names the command, and the session is still offered. */
  it('names the command a hook cannot find, and still offers a session', async () => {
    daemon()
    const said = {
      hooks: 'the agent’s PATH lacks `node` (SessionStart in claude-mem@thedotmack), so those hooks fail each time an agent starts',
    }
    await draw(report(checks(['hooks'], said)), [earlier], { machine: machine({ os: 'macOS' }) })
    expect(card().getByRole('heading', { name: 'a hook cannot run' })).toBeTruthy()
    expect(card().queryByText(/lacks `node`/)).toBeNull()
    pressFix()
    expect(card().getAllByText(/lacks node \(SessionStart in claude-mem@thedotmack\)/)).toHaveLength(1)
    expect(card().getByText(/put its directory on PATH in your login shell/)).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
  })

  it('draws readiness it could not read, and Try again asks the machine now', async () => {
    const asked = daemon()
    await draw({ looked: 'failed', age_seconds: 0, error: 'yantrad was not reached: HTTP 503' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The checks could not be read')
    expect(alert.textContent).toContain('yantrad was not reached: HTTP 503')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/readiness'))
  })

  it('says so when readiness cannot be asked again after an install lands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        if (path.endsWith('/install')) return Promise.resolve(answer(202))
        if (path.endsWith('/readiness')) {
          return Promise.resolve(answer(503, 'ssh to pi failed before the command reported a status: Connection timed out'))
        }
        if (path === '/api/about') return Promise.resolve(answer(200, ABOUT))
        return Promise.resolve(answer(200, ring([earlier])))
      }),
    )
    const client = await draw(report(checks(['git'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing git' })
    const done: Event = { ...stopped, at: 300, kind: 'installed', said: 'pi: git installed', commands: [] }
    act(() => client.setQueryData(keys.notifications(), ring([done, earlier])))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Readiness could not be asked again')
    expect(alert.textContent).toContain('Connection timed out')
  })

  it('says a key Tailscale expired, and offers nothing to press', async () => {
    daemon()
    await draw(report(checks()), [earlier], { machine: machine({ expired: true }) })
    expect(card().getByRole('heading', { name: 'pi’s Tailscale key expired' })).toBeTruthy()
    expect(card().getByText(/logs in to Tailscale on it again/)).toBeTruthy()
    expect(card().queryByRole('button')).toBeNull()
  })

  it('holds Install until the first notifications read, so an older result cannot pass as the answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        path === '/api/notifications' ? new Promise(() => {}) : Promise.resolve(answer(200, ABOUT)),
      ),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(keys.readiness('pi'), report(checks(['tmux'])))
    await renderInApp(<Page machine={machine()} />, client)
    const install = card().getByRole('button', { name: 'Install' })
    expect(install.hasAttribute('disabled') || install.getAttribute('aria-disabled') === 'true').toBe(true)
  })
})

/** Y-676, Y-714: a phone's page is the first fix, not a wall of probe text. */
describe('the checks on a phone-sized card', () => {
  it('shows the first absent check with its fix, then the others without one', async () => {
    daemon()
    await draw(report(checks(['provider-auth', 'hooks'])))
    pressFix()
    expect(document.querySelectorAll('.machine__check')).toHaveLength(2)
    expect(card().queryByText('git')).toBeNull()
    expect(card().getAllByText('gh auth login')).toHaveLength(1)
    expect(card().queryByText(/Install the command where the agent finds it/)).toBeNull()
  })

  it('keeps a passing check’s probe text off the page, and shows the failed one', async () => {
    daemon()
    await draw(report(checks(['tmux'], { tmux: 'tmux is not on PATH or in any of: $HOME/.local/bin', git: 'git 2.45' })))
    expect(card().queryByText(/not on PATH or in any of/)).toBeNull()
    openSaid()
    expect(card().getByText(/tmux: tmux is not on PATH or in any of: \$HOME\/\.local\/bin/)).toBeTruthy()
    expect(card().queryByText(/git 2\.45/)).toBeNull()
  })

  it('draws a failed probe in the body font, not mono', async () => {
    daemon()
    await draw(report(checks(['tmux'], { tmux: 'gone', git: 'git 2.45' })))
    openSaid()
    const line = card().getByText(/tmux: gone/)
    expect(line.classList.contains('m3-mono')).toBe(false)
    expect(line.closest('.m3-disclosure')!.querySelector('.m3-mono')).toBeNull()
  })

  it('shows only the absent probe line when present checks carry details too', async () => {
    daemon()
    await draw(report(checks(['tmux'], { tmux: 'gone', git: 'git 2.45' })))
    openSaid()
    expect(card().getByText(/tmux: gone/)).toBeTruthy()
    expect(card().queryByText(/git: git 2\.45/)).toBeNull()
  })

  it('shows no What ssh said when no check failed', async () => {
    daemon()
    await draw(report(checks()))
    expect(card().queryByRole('button', { name: /What ssh said/ })).toBeNull()
  })
})

/** Y-714: a ready machine shows only what needs the owner. */
describe('a ready machine', () => {
  const withMic = [...checks(), { check: 'mic', state: 'absent', detail: 'not installed' } as Check]
  const filled = () =>
    [...card().queryAllByRole('button'), ...card().queryAllByRole('link')].filter((one) => one.getAttribute('data-variant') === 'filled')

  it('lists no passing check and no ok row', async () => {
    daemon()
    await draw(report(checks()))
    expect(document.querySelectorAll('.machine__check')).toHaveLength(0)
    expect(card().queryByText('ok')).toBeNull()
    expect(card().queryByRole('button', { name: /^Show/ })).toBeNull()
    expect(filled()).toHaveLength(1)
    expect(filled()[0]!.textContent).toBe('New session')
  })

  it('keeps the microphone fix behind Optional: microphone until it opens', async () => {
    daemon()
    await draw(report(withMic))
    expect(card().queryByText(/Run Install with Microphone ticked/)).toBeNull()
    expect(card().queryByText('ok')).toBeNull()
    expect(card().queryByRole('checkbox', { name: 'Microphone' })).toBeNull()
    expect(card().queryByRole('button', { name: 'Install' })).toBeNull()
    const open = card().getByRole('button', { name: /^Show Optional: microphone/ })
    expect(open.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(open)
    pressFix()
    expect(card().getByText(/Run Install with Microphone ticked/)).toBeTruthy()
    expect(card().getByRole('checkbox', { name: 'Microphone' })).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(filled()).toHaveLength(1)
  })

  it('leaves the microphone fix out on a Mac, where Install never offers it', async () => {
    daemon()
    await draw(report(withMic), [earlier], { machine: machine({ os: 'macOS' }) })
    expect(card().queryByRole('button', { name: /Optional: microphone/ })).toBeNull()
    expect(card().queryByRole('button', { name: /What ssh said/ })).toBeNull()
    expect(card().queryByText(/Run Install with Microphone ticked/)).toBeNull()
    expect(filled()).toHaveLength(1)
    expect(filled()[0]!.textContent).toBe('New session')
  })

  it('keeps an optional absent microphone out of What ssh said on Linux', async () => {
    daemon()
    await draw(report(withMic))
    expect(card().queryByRole('button', { name: /What ssh said/ })).toBeNull()
  })
})

/** Y-714: whatever the verdict, one button is filled. */
describe('the one filled action', () => {
  const filled = () =>
    [...card().queryAllByRole('button'), ...card().queryAllByRole('link')].filter((one) => one.getAttribute('data-variant') === 'filled')
  const fixes = () => card().queryAllByRole('button', { name: /^Copy the command/ })

  it('is Install on a machine missing a basic, with the rest listed without a fix', async () => {
    daemon()
    await draw(report(checks(['tmux', 'git', 'provider-auth'])))
    expect(filled().map((one) => one.textContent)).toEqual(['Install'])
    expect(document.querySelectorAll('.machine__check')).toHaveLength(3)
    expect(fixes()).toHaveLength(0)
  })

  it('is the first terminal button when sudo asks, and later commands and Install are tonal', async () => {
    daemon([202], checks(['tmux', 'git']))
    const client = await draw(report(checks(['tmux', 'git'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing tmux and git' })
    const two: Event = { ...stopped, commands: ['sudo apk add tmux', 'sudo apk add git'] }
    act(() => client.setQueryData(keys.notifications(), ring([two, earlier])))
    await card().findByRole('heading', { name: 'tmux and git need your password' })
    const openers = [...document.querySelectorAll<HTMLElement>('[data-sudo-opener]')]
    expect(openers.map((one) => one.getAttribute('data-variant'))).toEqual(['filled', 'tonal'])
    expect(filled()).toHaveLength(1)
  })

  it('is New session on a manual machine that is ready, with one fix', async () => {
    daemon()
    await draw(report(checks(['provider-auth'])))
    expect(filled().map((one) => one.textContent)).toEqual(['New session'])
    pressFix()
    expect(fixes()).toHaveLength(1)
  })

  it('is Check again on a manual machine that is not ready, and New session is tonal', async () => {
    daemon()
    // A session check that could not be asked holds a machine back from ready.
    const unknown = checks(['provider-auth']).map((one) => (one.check === 'login-session' ? { ...one, state: 'unknown' as const } : one))
    await draw(report(unknown))
    expect(filled().map((one) => one.textContent)).toEqual(['Check again'])
    expect(card().getByRole('link', { name: 'New session' }).getAttribute('data-variant')).toBe('tonal')
    pressFix()
    expect(fixes()).toHaveLength(1)
  })

  it('lists only the checks that are not present in a reach failure', async () => {
    daemon()
    await draw(report(checks(['reachable'], { reachable: 'No route to host' })))
    openSaid()
    expect(document.querySelectorAll('.machine__check')).toHaveLength(1)
  })
})

describe('one short line per problem (Y-733)', () => {
  const rows = () => [...document.querySelectorAll('.machine__check')] as HTMLElement[]

  it('draws a failing row as its cause, with no backtick and no daemon paragraph, and the fix closed', async () => {
    daemon()
    const said = { tmux: 'tmux is not on PATH or in any of: $HOME/.local/bin. Install `tmux` there' }
    await draw(report(checks(['tmux'], said)))
    const row = rows()[0]!
    expect(row.querySelector('.machine__cause')!.textContent).toBe('not found')
    expect(row.textContent).not.toMatch(/`|PATH or in any/)
    const fix = within(row).getByRole('button', { name: /^Fix/ })
    expect(fix.getAttribute('aria-expanded')).toBe('false')
    expect(card().queryByRole('button', { name: /^Copy/ })).toBeNull()
    fireEvent.click(fix)
    expect(fix.getAttribute('aria-expanded')).toBe('true')
    const opened = within(row).getByText(/tmux is not on PATH or in any of/)
    expect(opened.textContent).toBe('tmux is not on PATH or in any of: $HOME/.local/bin. Install tmux there')
  })

  it('shows Copy on a command only after Fix, and keeps the command on one line', async () => {
    daemon()
    await draw(report(checks(['provider-auth'])))
    expect(card().queryByRole('button', { name: /^Copy/ })).toBeNull()
    pressFix()
    expect(card().getByRole('button', { name: 'Copy the command that fixes gh signed in' })).toBeTruthy()
    expect(card().getByText('gh auth login').classList.contains('m3-copyable__text--line')).toBe(true)
  })

  it('gives a row that carries no fix no Fix button', async () => {
    daemon()
    await draw(report(checks(['provider-auth', 'hooks'])))
    expect(rows().filter((row) => within(row).queryByRole('button', { name: /^Fix/ }))).toHaveLength(1)
  })

  it('tells a Mac under a nightly daemon that nightly has no Mac build', async () => {
    const nightly = { ...ABOUT, version: '0.11.1-nightly.20261111000000.abc1234' }
    daemon([202], checks(), nightly)
    const command = 'curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash'
    const said = { heartbeat: `yantra-agent here is v0.3.2 and yantrad is v${nightly.version}. Update it on pi: \`${command}\`` }
    await draw(report(checks(['heartbeat'], said)), [earlier], { machine: machine({ os: 'macOS' }) })
    await waitFor(() => expect(card().getByRole('button', { name: /^Fix/ })).toBeTruthy())
    pressFix()
    await waitFor(() => expect(card().getByText('Nightly has no Mac build; this installs the latest stable.')).toBeTruthy())
    expect(card().getByText(command)).toBeTruthy()
  })
})
