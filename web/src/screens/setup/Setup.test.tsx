import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Event, Machine, Readiness } from '@/api'
import { aListed, aMachine, looked } from '@/api/fixtures'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import { renderRouted } from '@/test/inRouter'
import { Setup } from './Setup'

/* The checklist on its own, so every line state is drawn and asserted — the
   ones the Dashboard only shows once a machine is online. */

const NOW = Date.parse('2026-09-06T12:00:00Z')
const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'

type Routes = Record<string, [number, unknown]>

const linux = aMachine({ name: 'cachyos-g14', os: 'linux', online: false, last_seen: '2026-09-06T11:00:00Z' })
const mac = aMachine({ name: 'macbook', os: 'macOS', online: false, last_seen: '2026-09-06T11:00:00Z' })
const phone = aMachine({ name: 'iphone', os: 'iOS', online: true })
const tablet = aMachine({ name: 'pixel-tablet', os: 'android', online: false })
const windows = aMachine({ name: 'gaming-pc', os: 'windows', online: false })
const up = { ...linux, online: true }

const checks = (states: Record<string, 'present' | 'absent'>, detail = ''): Readiness => ({
  machine: up.name,
  checks: Object.entries(states).map(([check, state]) => ({ check, state, detail })),
})
/** The seven checks a session needs (`lib/ready`). */
const tools = {
  reachable: 'present',
  sshd: 'present',
  tmux: 'present',
  git: 'present',
  'agent-cli': 'present',
  terminfo: 'present',
  'login-session': 'present',
} as const

const base = (machines: Machine[] = [linux, mac, phone, tablet, windows]): Routes => ({
  'GET /api/machines': [200, looked.ok(machines)],
  'GET /api/readiness': [200, looked.ok<Readiness[]>([])],
  'GET /api/workspaces': [200, looked.ok([])],
  'GET /api/notifications': [200, looked.ok<Event[]>([])],
  'GET /api/about': [200, { ...contract.about, relay: false }],
  'GET /api/ssh-identity': [404, 'no ssh identity yet — the first join makes one'],
  'GET /api/github': [200, contract.disconnected],
})

async function draw(routes: Routes) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
      asked.push(key)
      const [status, body] = routes[key] ?? [404, 'no']
      return Promise.resolve(answer(status, body))
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await renderRouted(
    <QueryClientProvider client={client}>
      <Setup />
    </QueryClientProvider>,
  )
  await screen.findByText(/of 4 done/)
  return asked
}

const filled = () => [...document.querySelectorAll('[data-variant="filled"]')].map((one) => one.textContent)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('the steps', () => {
  it('counts four required steps, and keeps GitHub and push for later', async () => {
    await draw(base())
    expect(screen.getByText('Yantra runs AI agents on your own machines. Four steps get the first one ready, and each step checks itself.')).toBeTruthy()
    for (const title of ['The appliance is on your tailnet', 'Add a machine', 'Get it ready', 'Your first session']) {
      expect(screen.getByText(title)).toBeTruthy()
    }
    expect(screen.getByText('1 of 4 done')).toBeTruthy()
    const later = within(screen.getByRole('list', { name: 'Later, when you want them' }))
    expect(later.getByText('GitHub')).toBeTruthy()
    expect(later.getByText('Push to your phone')).toBeTruthy()
    expect(later.getByRole('link', { name: 'Connect' }).dataset.variant).toBe('tonal')
  })

  /** D7 B5: a step that is not done draws its number, never a tick. */
  it('leads each step with its state', async () => {
    await draw(base())
    const leads = [...document.querySelectorAll('.m3-lead')]
    expect(leads[0]!.querySelector('svg')).toBeTruthy()
    expect(leads[1]!.textContent).toBe('2')
    expect(leads[3]!.textContent).toBe('4')
  })

  /** D7 §3.1 and B4: one filled button, and it is the next required thing. */
  it('fills only the next required action, which is Add a device before any join', async () => {
    await draw(base())
    expect(filled()).toEqual(['Add a device'])
    expect(screen.getByRole('link', { name: 'Add a device' }).getAttribute('href')).toBe('/machines/add')
    expect(screen.getByRole('link', { name: 'New session' }).dataset.variant).toBe('tonal')
  })

  /** ADR-0029: the first join makes the key, so with no key nothing has
   *  joined, whatever an old report about an asleep machine says. */
  it('counts no join while the key does not exist, and keeps Add a device the next thing', async () => {
    const old = { machine: linux.name, checks: [{ check: 'reachable', state: 'present', detail: '' }] }
    await draw({ ...base([linux]), 'GET /api/readiness': [200, looked.ok([old as Readiness])] })
    expect(screen.getByText(/not yet · no machine has joined yet/)).toBeTruthy()
    expect(filled()).toEqual(['Add a device'])
  })

  /** A machine ssh reaches through the account's own keys is ready, and has
   *  not joined: step 2 says so rather than *no machine has joined*. */
  it("says a machine ready without Yantra's key was reached without it, and to run the join command", async () => {
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([checks(tools)])] })
    expect(screen.getByText("not yet · cachyos-g14 reached without Yantra's key · run the join command on it once")).toBeTruthy()
    expect(screen.getByText(/done · 1 of 1 machines ready/)).toBeTruthy()
    expect(filled()).toEqual(['Add a device'])
  })

  it('names no terminal command for the key, and shows its fingerprint once it exists', async () => {
    await draw(base())
    expect(screen.getByText('the key is made when the first machine joins')).toBeTruthy()
    expect(screen.queryByText(/yantra ssh-identity/)).toBeNull()
    cleanup()
    await draw({ ...base(), 'GET /api/ssh-identity': [200, contract.sshIdentity] })
    expect(screen.getByText('SHA256:<fingerprint>')).toBeTruthy()
  })

  /** A key that could not be read is not *no key yet*. */
  it('draws the failure under step 2 when the key could not be read', async () => {
    await draw({ ...base(), 'GET /api/ssh-identity': [500, 'the key file could not be read'] })
    const surface = (await screen.findByText("The appliance's key could not be read")).closest('[role="alert"]')!
    expect(within(surface as HTMLElement).getByText(/the key file could not be read/)).toBeTruthy()
    expect(screen.getByText(/could not be read · .*the key file could not be read/)).toBeTruthy()
    expect(screen.queryByText('the key is made when the first machine joins')).toBeNull()
    expect([...document.querySelectorAll('.m3-lead')][1]!.querySelector('svg')).toBeTruthy()
  })

  it('reads the relay the daemon holds, and fails with the daemon words', async () => {
    await draw({ ...base(), 'GET /api/about': [200, { ...contract.about, relay: true }] })
    expect(screen.getByText(/the daemon holds a relay and pushes to it/)).toBeTruthy()
    cleanup()
    await draw({ ...base(), 'GET /api/about': [503, 'tailscale did not answer'] })
    expect(screen.getAllByText(/tailscale did not answer/).length).toBeGreaterThan(0)
  })

  it('is done at the first session once a workspace exists', async () => {
    await draw({ ...base(), 'GET /api/workspaces': [200, looked.ok([aListed()])] })
    expect(screen.getByText(/done · 1 workspace made/)).toBeTruthy()
  })

  it('says the one step that runs in a terminal is the join command', async () => {
    await draw(base())
    expect(screen.getByText(/One step runs in a terminal: the join command/)).toBeTruthy()
  })
})

describe('the machine lines', () => {
  it('lists only the machines that run a session, and shows the rest apart', async () => {
    await draw(base())
    expect(screen.getByText(/0 of 2 machines ready/)).toBeTruthy()
    const apart = within(screen.getByRole('list', { name: 'Devices that open the dashboard' }))
    expect(apart.getByText('iphone')).toBeTruthy()
    expect(apart.getAllByText('opens the dashboard · runs no session')).toHaveLength(2)
    expect(apart.getByText(/Windows · coming soon/)).toBeTruthy()
    expect(apart.queryByText('cachyos-g14')).toBeNull()
  })

  /** D7 S3 and S5: an asleep machine is normal, and ssh cannot answer it. */
  it('draws an asleep machine as asleep, with no button', async () => {
    await draw(base([linux, mac]))
    expect(screen.getAllByText('asleep · last seen 1h ago')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Check/ })).toBeNull()
  })

  it('offers Check on a machine that is online and not asked', async () => {
    await draw(base([up]))
    expect(screen.getByText('not checked yet · a check costs one ssh round trip')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy()
  })

  it('says the tailnet lists no machine when only phones are on it', async () => {
    await draw(base([phone, tablet]))
    expect(screen.getByText(/lists no machine that runs Linux or macOS/)).toBeTruthy()
  })

  it('draws the daemon words when the machines could not be read, and still offers Add a device', async () => {
    await draw({ ...base(), 'GET /api/machines': [200, { looked: 'failed', age_seconds: 0, error: 'tailscaled is down' }] })
    expect(screen.getByText('Machines could not be read')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Add a device' })).toBeTruthy()
  })

  it('gives a refused machine the join command to run on it', async () => {
    const refused = { machine: up.name, checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] }
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([refused as Readiness])] })
    expect(screen.getByText('the key was refused · run the join command on it')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the join command for cachyos-g14' })).toBeTruthy()
    expect(screen.getAllByText(COMMAND)).toHaveLength(1)
  })

  /** D7 §4.1: the first machine with only Install-able checks missing gets
   *  the page's one filled action. */
  it('fills Install on the machine that needs only what Install adds, and runs it', async () => {
    const missing = checks({ ...tools, tmux: 'absent' })
    const asked = await draw({
      ...base([up]),
      // It joined, so the key exists (ADR-0029).
      'GET /api/ssh-identity': [200, contract.sshIdentity],
      'GET /api/readiness': [200, looked.ok([missing])],
      'POST /api/machines/cachyos-g14/install': [202, undefined],
    })
    expect(screen.getByText('missing tmux')).toBeTruthy()
    expect(filled()).toEqual(['Install on cachyos-g14'])
    fireEvent.click(screen.getByRole('button', { name: 'Install on cachyos-g14' }))
    expect(await screen.findByText('installing on cachyos-g14…')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'installing on cachyos-g14' })).toBeTruthy()
    expect(asked).toContain('POST /api/machines/cachyos-g14/install')
  })

  /** D7 §4.1: the line says what needs the password; the command is below it,
   *  once, with Copy. */
  it('says what a sudo-blocked install needs, and shows each command it left with Copy', async () => {
    const missing = checks({ ...tools, tmux: 'absent' })
    const stopped: Event = {
      at: 9,
      kind: 'install_stopped',
      workspace: null,
      machine: up.name,
      said: 'cachyos-g14: tmux left for you: run `sudo pacman -S --noconfirm tmux` on cachyos-g14',
      commands: ['sudo pacman -S --noconfirm tmux'],
    }
    await draw({
      ...base([up]),
      'GET /api/readiness': [200, looked.ok([missing])],
      'GET /api/notifications': [200, looked.ok([stopped])],
    })
    expect(screen.getByText('tmux needs your password')).toBeTruthy()
    expect(screen.queryByText(/tmux left for you/)).toBeNull()
    expect(screen.getAllByText('sudo pacman -S --noconfirm tmux')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Copy the command for cachyos-g14' })).toBeTruthy()
  })

  it('sends a check Install does not fix to the machine page', async () => {
    const term = checks({ ...tools, terminfo: 'absent' })
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([term])] })
    expect(screen.getByText('missing terminfo · the machine page shows how')).toBeTruthy()
    const open = screen.getAllByRole('link', { name: 'Open' }).map((one) => one.getAttribute('href'))
    expect(open).toContain('/m/cachyos-g14')
  })

  /** Walk-through Q2.3: one ready machine is enough, and an asleep one waits
   *  for nothing. Ready is the seven checks a session needs (`lib/ready`). */
  it('is done at one ready machine, and fills New session next', async () => {
    await draw({
      ...base([up, mac]),
      'GET /api/ssh-identity': [200, contract.sshIdentity],
      'GET /api/readiness': [200, looked.ok([checks(tools)])],
    })
    expect(screen.getByText(/1 of 2 machines ready · one is enough to start/)).toBeTruthy()
    expect(screen.getByText('ready · 7 of 7')).toBeTruthy()
    expect(filled()).toEqual(['New session'])
  })

  /** GitHub is optional (coordinator's ruling, 2026-09-13). */
  it('draws a machine with gh not signed in as ready', async () => {
    await draw({
      ...base([up]),
      'GET /api/ssh-identity': [200, contract.sshIdentity],
      'GET /api/readiness': [200, looked.ok([checks({ ...tools, 'provider-auth': 'absent' })])],
    })
    expect(screen.getByText('ready · 7 of 8')).toBeTruthy()
    expect(screen.getByText(/done · 1 of 1 machines ready/)).toBeTruthy()
  })
})
