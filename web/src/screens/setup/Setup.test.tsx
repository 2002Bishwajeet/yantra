import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Event, Machine, Readiness } from '@/api'
import { aListed, aMachine, looked } from '@/api/fixtures'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import { renderRouted } from '@/test/inRouter'
import { CHANGED_KEY } from '@/test/sshSaid'
import { useSetupGate } from './progress'
import { Setup } from './Setup'

/* The checklist on its own, so every line state is drawn and asserted — the
   ones the Dashboard only shows once a machine is online. */

/* The FAB belongs to the shell; a test sets what it carries. */
const fab = vi.hoisted(() => ({ carries: false }))
vi.mock('@/shell/primary', async (original) => ({
  ...(await original<typeof import('@/shell/primary')>()),
  useFab: () => (fab.carries ? ({ kind: 'add-device' } as never) : null),
}))

const NOW = Date.parse('2026-09-06T12:00:00Z')
const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'

type Routes = Record<string, [number, unknown]>

const linux = aMachine({ name: 'cachyos-g14', os: 'linux', online: false, last_seen: '2026-09-06T11:00:00Z' })
const mac = aMachine({ name: 'macbook', os: 'macOS', online: false, last_seen: '2026-09-06T11:00:00Z' })
const phone = aMachine({ name: 'iphone', os: 'iOS', online: true })
const tablet = aMachine({ name: 'pixel-tablet', os: 'android', online: false })
const windows = aMachine({ name: 'gaming-pc', os: 'windows', online: false })
const up = { ...linux, online: true }
const upToo = { ...mac, online: true }
const linux2 = aMachine({ name: 'ubuntu', os: 'linux', online: true })

const checks = (states: Record<string, 'present' | 'absent'>, detail = '', machine = up.name): Readiness => ({
  machine,
  age_seconds: 0,
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
  'GET /api/readiness/github': [200, contract.githubReadiness],
})

async function draw(routes: Routes) {
  const asked: string[] = []
  // The push sheet asks the form factor; a desktop answers every query.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
      asked.push(key)
      const [status, body] = routes[key] ?? [404, 'no']
      return status === 0 ? new Promise<Response>(() => {}) : Promise.resolve(answer(status, body))
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
  fab.carries = false
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

  it('says GitHub refused the grant and links Sign in again to Providers', async () => {
    await draw({
      ...base(),
      'GET /api/github': [200, contract.github],
      'GET /api/readiness/github': [200, contract.githubRefused],
    })
    const later = within(screen.getByRole('list', { name: 'Later, when you want them' }))
    expect(await later.findByText(/GitHub refused the grant · sign in again/)).toBeTruthy()
    expect(later.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe('/settings/providers')
    expect(document.body.textContent).not.toContain('someone')
  })

  /** Y-477: the appliance is the node the daemon is bound to. */
  it('shows the appliance key expiry with a link to the admin console, and no link when expiry is off', async () => {
    const node = aMachine({ name: 'pi', address: '100.64.0.1', hub: true, key_expires: '2026-09-12T12:00:00Z' })
    await draw(base([node]))
    let later = within(screen.getByRole('list', { name: 'Later, when you want them' }))
    expect(later.getByText("The appliance's Tailscale key")).toBeTruthy()
    expect(later.getByText(/soon · expires on 2026-09-12, in 6 days/)).toBeTruthy()
    const link = later.getByRole('link', { name: 'Admin console' })
    expect(link.getAttribute('href')).toBe('https://login.tailscale.com/admin/machines')
    expect(link.getAttribute('target')).toBe('_blank')
    cleanup()

    await draw(base([{ ...node, key_expires: null }]))
    later = within(screen.getByRole('list', { name: 'Later, when you want them' }))
    expect(later.getByText(/done · key expiry is off/)).toBeTruthy()
    expect(later.queryByRole('link', { name: 'Admin console' })).toBeNull()
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

  /** Y-615: a fresh install lists guests nobody has checked, so step 2 does not deny them. */
  it('says how many machines wait for a check, and puts Check all on step 3', async () => {
    await draw(base([up, upToo]))
    expect(screen.getByText('not yet · 2 machines on the tailnet, none checked yet · a check shows which joined')).toBeTruthy()
    expect(screen.getByText('not yet · needs one ready machine · none is checked yet')).toBeTruthy()
    const row = (title: string) => screen.getByText(title).closest('.m3-list__row') as HTMLElement
    expect(within(row('Get it ready')).getByRole('button', { name: 'Check all' })).toBeTruthy()
    expect(within(row('Add a machine')).queryByRole('button', { name: 'Check all' })).toBeNull()
    expect(document.querySelector('.setup__bulk')).toBeNull()
  })

  it('puts Install on all on step 3 once every machine is checked', async () => {
    await draw({
      ...base([up]),
      'GET /api/ssh-identity': [200, contract.sshIdentity],
      'GET /api/readiness': [200, looked.ok([checks({ ...tools, tmux: 'absent' })])],
    })
    const row = screen.getByText('Get it ready').closest('.m3-list__row') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Install on all' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Check all' })).toBeNull()
  })

  it('keeps Install on all beside Check all while one machine is unchecked', async () => {
    await draw({
      ...base([up, upToo]),
      'GET /api/ssh-identity': [200, contract.sshIdentity],
      'GET /api/readiness': [200, looked.ok([checks({ ...tools, tmux: 'absent' })])],
    })
    const row = screen.getByText('Get it ready').closest('.m3-list__row') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Check all' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Install on all' })).toBeTruthy()
    expect(screen.queryByText(/none is checked/)).toBeNull()
  })

  /** Y-615: the FAB is the one Add a device on a phone and a tablet. */
  it('draws no Add a device in the page while the FAB carries it', async () => {
    fab.carries = true
    await draw(base())
    expect(screen.queryByRole('link', { name: 'Add a device' })).toBeNull()
    expect(filled()).toEqual([])
  })

  it('keeps one filled Add a device on a desktop, which has no FAB', async () => {
    await draw(base())
    expect(screen.getAllByRole('link', { name: 'Add a device' })).toHaveLength(1)
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

  /** Y-576: the walkthrough opens the same guided flow as Settings, in place. */
  it('opens the push setup in place from Push to your phone', async () => {
    await draw(base())
    const later = within(screen.getByRole('list', { name: 'Later, when you want them' }))
    expect(later.queryByRole('link', { name: 'Set up' })).toBeNull()
    fireEvent.click(later.getByRole('button', { name: 'Set up' }))
    expect(await screen.findByRole('dialog', { name: 'Push relay' })).toBeTruthy()
  })

  it('walks the push setup from Generate to a test that arrived', async () => {
    const asked = await draw({ ...base(), 'POST /api/relay': [204, undefined] })
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    const sheet = within(await screen.findByRole('dialog', { name: 'Push relay' }))
    fireEvent.click(sheet.getByRole('button', { name: 'Generate' }))
    const url = (sheet.getByLabelText('Topic URL') as HTMLInputElement).value
    expect(await sheet.findByRole('img', { name: /QR/ })).toBeTruthy()
    expect(sheet.getByRole('link', { name: 'Open the topic' }).getAttribute('href')).toBe(url)
    expect(sheet.getByRole('button', { name: 'Copy the topic URL' })).toBeTruthy()
    fireEvent.click(sheet.getByRole('button', { name: 'Save and send a test' }))
    expect(await sheet.findByText('The test message arrived at the relay.')).toBeTruthy()
    expect(sheet.getByRole('button', { name: 'Restart now' })).toBeTruthy()
    expect(asked.filter((one) => one === 'POST /api/relay')).toHaveLength(1)
    fireEvent.click(sheet.getByRole('button', { name: 'Yes' }))
    expect(sheet.getByText(/Push works/)).toBeTruthy()
  })

  it('is done at the first session once a workspace exists', async () => {
    await draw({ ...base(), 'GET /api/workspaces': [200, looked.ok([aListed()])] })
    expect(screen.getByText(/done · 1 workspace made/)).toBeTruthy()
  })

  it('says the one step that runs in a terminal is the join command', async () => {
    await draw(base())
    expect(
      screen.getByText(
        'One step runs in a terminal: the join command, once on each new machine, as an account without sudo named karigar. Each step here re-checks itself every few seconds.',
      ),
    ).toBeTruthy()
  })
})

/** The home gate (owner's ruling (b)), which the dashboard reads: one ready
 *  machine you own passes it, and a ready one shared in never does (Y-404). */
describe('the setup gate', () => {
  function Gate(props: { machines: Machine[] }) {
    const gate = useSetupGate(props.machines)
    return <p>{gate.key === 'reading' ? 'reading' : gate.passed ? 'passed' : 'held'}</p>
  }

  async function gate(machine: Machine) {
    const routes: Routes = {
      ...base([machine]),
      'GET /api/ssh-identity': [200, contract.sshIdentity],
      'GET /api/readiness': [200, looked.ok([checks(tools)])],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        const [status, body] = routes[`${init?.method ?? 'GET'} ${path.split('?')[0]}`] ?? [404, 'no']
        return status === 0 ? new Promise<Response>(() => {}) : Promise.resolve(answer(status, body))
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <Gate machines={[machine]} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.queryByText('reading')).toBeNull())
    // The readiness sweep lands after the key, so wait for the gate to settle on it.
    await waitFor(() => expect(client.isFetching()).toBe(0))
    return screen.getByRole('paragraph').textContent
  }

  it('passes on a ready machine you own', async () => {
    expect(await gate(up)).toBe('passed')
  })

  /** Y-582: the hub runs agents, so a ready hub alone passes the gate. */
  it('passes on a ready hub with no other machine', async () => {
    expect(await gate({ ...up, hub: true })).toBe('passed')
  })

  it('holds on a ready machine another account shares, or the tailnet owns', async () => {
    expect(await gate({ ...up, ownership: 'shared' })).toBe('held')
    cleanup()
    expect(await gate({ ...up, ownership: 'tagged' })).toBe('held')
  })
})

/** Y-582: the hub is the daemon's own node. Setup shows it under step 1 and
 *  never offers to add it. */
describe('the hub', () => {
  const box = aMachine({ name: 'yantra-box', os: 'linux', online: true, hub: true, address: '100.64.0.1' })
  const keyed = { 'GET /api/ssh-identity': [200, contract.sshIdentity] } as Routes
  const hubList = () => within(screen.getByRole('list', { name: 'The hub' }))

  it('is ready with no action on a fresh install, and step 2 has nothing to add', async () => {
    await draw({
      ...base([box, phone]),
      ...keyed,
      'GET /api/readiness': [200, looked.ok([checks(tools, '', box.name)])],
    })
    const hub = hubList()
    expect(hub.getByText('yantra-box')).toBeTruthy()
    expect(hub.getByText('ready · 7 of 7')).toBeTruthy()
    expect(hub.getByText('19,942 MB free · 15% busy')).toBeTruthy()
    expect(hub.queryByRole('button')).toBeNull()
    expect(hub.queryByRole('link')).toBeNull()
    expect([...document.querySelectorAll('.m3-lead')][0]!.querySelector('svg')).toBeTruthy()
    expect(
      screen.getByText('done · yantra-box is the hub and needs no adding · more machines can be added later'),
    ).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Other machines' })).toBeNull()
    expect(screen.getByText(/done · 1 of 1 machines ready/)).toBeTruthy()
    expect(screen.queryByText('Devices that open the dashboard')).toBeNull()
    expect(screen.queryByText('iphone')).toBeNull()
    expect(filled()).toEqual(['New session'])
  })

  it('lists only the other machines under step 3, with the key and strangers under step 2', async () => {
    await draw({
      ...base([box, up]),
      ...keyed,
      'GET /api/readiness': [200, looked.ok([checks(tools, '', box.name), checks(tools)])],
    })
    const added = within(screen.getByRole('list', { name: 'Other machines' }))
    expect(added.getByText('cachyos-g14')).toBeTruthy()
    expect(added.queryByText('yantra-box')).toBeNull()
    expect(hubList().queryByText('cachyos-g14')).toBeNull()
    expect(screen.getByText('done · cachyos-g14 joined · more machines can be added later')).toBeTruthy()
    expect(screen.getByText(/done · 2 of 2 machines ready/)).toBeTruthy()
    const rows = [...document.querySelectorAll('.setup__list > li')]
    const lines = screen.getByRole('list', { name: 'Other machines' })
    const step = (title: string) => rows.findIndex((one) => one.textContent?.includes(title))
    expect(rows.indexOf(lines.closest('.setup__sub')!)).toBe(step('Get it ready') + 1)
  })

  it('links a hub that is not ready to its machine page, and offers no Check or Install', async () => {
    await draw({
      ...base([box]),
      ...keyed,
      'GET /api/readiness': [200, looked.ok([checks({ ...tools, tmux: 'absent' }, '', box.name)])],
    })
    const hub = hubList()
    expect(hub.getByText('missing tmux')).toBeTruthy()
    expect(hub.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/m/yantra-box')
    expect(hub.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull()
  })

  /** Y-585: the hub speaks as plainly as a machine line, and it is never
   *  added, so it never offers the join command. */
  it('gives a hub ssh cannot reach a cause and a next step, with ssh behind a press and no join command', async () => {
    const silent = { machine: box.name, checks: [{ check: 'reachable', state: 'absent', detail: 'No route to host' }] }
    await draw({ ...base([box]), ...keyed, 'GET /api/readiness': [200, looked.ok([silent as Readiness])] })
    const hub = hubList()
    expect(hub.getByText(/^Yantra can’t reach yantra-box over ssh\./)).toBeTruthy()
    expect(hub.getByText(/^The join command does not fix this\./)).toBeTruthy()
    expect(hub.queryByText('No route to host')).toBeNull()
    const press = hub.getByRole('button', { name: /What ssh said/ })
    expect(press.getAttribute('aria-expanded')).toBe('false')
    expect(hub.queryByRole('button', { name: /Copy the join command/ })).toBeNull()
    expect(screen.queryByText(COMMAND)).toBeNull()
    fireEvent.click(press)
    expect(await hub.findByText('No route to host')).toBeTruthy()
  })

  it('says the key was refused on a refused hub, with ssh behind a press and no join command', async () => {
    const refused = { machine: box.name, checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] }
    await draw({ ...base([box]), ...keyed, 'GET /api/readiness': [200, looked.ok([refused as Readiness])] })
    const hub = hubList()
    expect(hub.getByText('the key was refused · its machine page shows how')).toBeTruthy()
    expect(hub.queryByText(/join command/)).toBeNull()
    expect(hub.queryByText('Permission denied (publickey)')).toBeNull()
    expect(hub.queryByRole('button', { name: /Copy the join command/ })).toBeNull()
    fireEvent.click(hub.getByRole('button', { name: /What ssh said/ }))
    expect(await hub.findByText('Permission denied (publickey)')).toBeTruthy()
  })

  /** Y-622: the box is the hub, so no word on the page sends the owner to the join command. */
  const named = { name: 'yantra-box', dns_name: 'yantra-box.tail3a1b.ts.net.', hub: true }
  const otherMachines = () => screen.queryByRole('list', { name: 'Other machines' })

  it.each([
    ['unjoined', 'the ssh config here names no account for yantra-box, so ssh tried `yantra` · Permission denied (publickey).', 'no account named for it · its machine page shows how'],
    ['browser', 'Tailscale SSH requires an additional check', 'Tailscale asks for a browser sign-in · its machine page shows how'],
  ])('lists a %s hub once, under step 1, with no join command', async (_kind, detail, words) => {
    const one = aMachine({ ...named, os: 'linux', online: true, address: '100.64.0.1' })
    const report = { machine: one.name, checks: [{ check: 'reachable', state: 'absent', detail }] }
    await draw({ ...base([one]), ...keyed, 'GET /api/readiness': [200, looked.ok([report as Readiness])] })
    expect(screen.getAllByText('yantra-box')).toHaveLength(1)
    const hub = hubList()
    expect(hub.getByText('yantra-box')).toBeTruthy()
    expect(hub.getByText(words)).toBeTruthy()
    expect(otherMachines()).toBeNull()
    expect(hub.queryByText(/join command/)).toBeNull()
    expect(hub.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/m/yantra-box')
  })

  it('lists a tagged hub once, under step 1, and not among the devices the account does not own', async () => {
    const one = aMachine({ ...named, os: 'linux', online: true, ownership: 'tagged', address: '100.64.0.1' })
    await draw({ ...base([one]), ...keyed })
    expect(screen.getAllByText('yantra-box')).toHaveLength(1)
    expect(hubList().getByText(/^tagged, so the tailnet owns it/)).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Devices your account does not own' })).toBeNull()
    expect(hubList().queryByRole('button')).toBeNull()
  })

  it('still draws the hub when the key could not be read', async () => {
    await draw({
      ...base([box]),
      'GET /api/ssh-identity': [500, 'the key file could not be read'],
      'GET /api/readiness': [200, looked.ok([checks(tools, '', box.name)])],
    })
    expect(await screen.findByText("The appliance's key could not be read")).toBeTruthy()
    expect(hubList().getByText('ready · 7 of 7')).toBeTruthy()
  })

  it('draws no hub and keeps the failure when the machines could not be read', async () => {
    await draw({ ...base(), 'GET /api/machines': [200, { looked: 'failed', age_seconds: 0, error: 'tailscaled is down' }] })
    expect(screen.getByText('Machines could not be read')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'The hub' })).toBeNull()
  })
})

describe('the machine lines', () => {
  /** Y-582: the devices block lives on Machines, so Setup lists only what runs a session. */
  it('lists only the machines that run a session, and no devices block', async () => {
    await draw(base())
    expect(screen.getByText(/0 of 2 machines ready/)).toBeTruthy()
    expect(screen.queryByText('Devices that open the dashboard')).toBeNull()
    expect(screen.queryByText('iphone')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Other machines' })).getByText('cachyos-g14')).toBeTruthy()
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

  it('gives a machine that wants a browser the join command too', async () => {
    const browser = { machine: up.name, checks: [{ check: 'reachable', state: 'absent', detail: 'Tailscale SSH requires an additional check' }] }
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([browser as Readiness])] })
    expect(screen.getByText('Tailscale asks for a browser sign-in · run the join command on it')).toBeTruthy()
  })

  /** Y-621: a changed key names the forget command, and the join command
   *  would not help, so it is not offered. */
  it('gives a machine whose host key changed the forget command, and no join command', async () => {
    const changed = { machine: up.name, checks: [{ check: 'reachable', state: 'absent', detail: CHANGED_KEY }] }
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([changed as Readiness])] })
    expect(
      screen.getByText('its host key changed · run sudo -u yantra -H yantra forget-host-key cachyos-g14 once you know why'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy the join command for cachyos-g14' })).toBeNull()
  })

  /** Y-585, #520: the first-run page speaks plainly, and the join command
   *  would not help this machine, so it is not offered. */
  it('gives a machine ssh cannot reach a cause and a next step, with ssh behind a press', async () => {
    const silent = { machine: up.name, checks: [{ check: 'reachable', state: 'absent', detail: 'No route to host' }] }
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([silent as Readiness])] })
    expect(screen.getByText(/^Yantra can’t reach cachyos-g14 over ssh\./)).toBeTruthy()
    expect(screen.getByText(/^The join command does not fix this\./)).toBeTruthy()
    expect(screen.queryByText('No route to host')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy the join command for cachyos-g14' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /What ssh said/ }))
    expect(await screen.findByText('No route to host')).toBeTruthy()
  })

  it('gives a refused machine the join command to run on it', async () => {
    const refused = { machine: up.name, checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] }
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([refused as Readiness])] })
    expect(screen.getByText('the key was refused · run the join command on it')).toBeTruthy()
    expect(screen.queryByText('Permission denied (publickey)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /What ssh said/ }))
    expect(await screen.findByText('Permission denied (publickey)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the join command for cachyos-g14' })).toBeTruthy()
    expect(screen.getAllByText(COMMAND)).toHaveLength(1)
  })

  /** Y-628: the join command on a line names karigar, and opens the commands that make it. */
  it('tells a Linux line to join as karigar, with the commands that make it and start sshd', async () => {
    const refused = { machine: up.name, checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] }
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([refused as Readiness])] })
    const how = screen.getByRole('button', { name: /How Run it as karigar, an account without sudo/ })
    expect(how.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(how)
    expect(how.getAttribute('aria-expanded')).toBe('true')
    for (const command of [
      'sudo systemctl enable --now sshd',
      'sudo useradd --create-home --shell /bin/bash karigar',
      "sudo usermod -p '*' karigar",
      'sudo -iu karigar',
    ]) {
      expect(screen.getByText(command)).toBeTruthy()
    }
    expect(screen.queryByText(/sysadminctl/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy the join command for cachyos-g14' })).toBeTruthy()
  })

  it('tells a Mac line to join as a Standard account named karigar', async () => {
    const refused = { machine: upToo.name, checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] }
    await draw({ ...base([upToo]), 'GET /api/readiness': [200, looked.ok([refused as Readiness])] })
    fireEvent.click(screen.getByRole('button', { name: /How Run it as karigar/ }))
    expect(screen.getByText('sudo sysadminctl -addUser karigar -fullName Karigar -password -')).toBeTruthy()
    expect(screen.queryByText(/useradd/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy the join command for macbook' })).toBeTruthy()
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

  /** Y-404, owner 2026-09-13: a node another account owns is listed with the
   *  reason and never counts, even when every check is present. */
  it('lists a node your account does not own apart, and never counts it ready', async () => {
    const shared = { ...up, ownership: 'shared' as const }
    await draw({
      ...base([shared, aMachine({ name: 'ci', os: 'linux', ownership: 'tagged' })]),
      'GET /api/ssh-identity': [200, contract.sshIdentity],
      'GET /api/readiness': [200, looked.ok([checks(tools)])],
    })
    const foreign = within(screen.getByRole('list', { name: 'Devices your account does not own' }))
    expect(foreign.getByText('shared from another account · not supported yet')).toBeTruthy()
    expect(foreign.getByText(/tagged, so the tailnet owns it/)).toBeTruthy()
    expect(screen.queryByText('ready · 7 of 7')).toBeNull()
    expect(filled()).not.toEqual(['New session'])
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

/** Y-478: one press fires each line's own mutation, so each keeps its own ring and error. */
describe('the bulk buttons', () => {
  const both = [up, upToo]
  const keyed = { 'GET /api/ssh-identity': [200, contract.sshIdentity] } as Routes
  const missing = (machine: string) => checks({ ...tools, tmux: 'absent' }, '', machine)

  it('checks every online machine that was not asked, then goes away', async () => {
    const routes: Routes = {
      ...base(both),
      ...keyed,
      'POST /api/machines/cachyos-g14/readiness': [200, looked.ok(checks(tools))],
      'POST /api/machines/macbook/readiness': [200, looked.ok(checks(tools, '', 'macbook'))],
    }
    const asked = await draw(routes)
    fireEvent.click(screen.getByRole('button', { name: 'Check all' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Check all' })).toBeNull())
    expect(asked).toContain('POST /api/machines/cachyos-g14/readiness')
    expect(asked).toContain('POST /api/machines/macbook/readiness')
    expect(filled().length).toBeLessThanOrEqual(1)
  })

  it('skips a machine whose check is already pending', async () => {
    const asked = await draw({
      ...base(both),
      ...keyed,
      'POST /api/machines/cachyos-g14/readiness': [0, undefined],
      'POST /api/machines/macbook/readiness': [200, looked.ok(checks(tools, '', 'macbook'))],
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Check' })[0])
    await screen.findByText('asking…')
    fireEvent.click(screen.getByRole('button', { name: 'Check all' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/macbook/readiness'))
    expect(asked.filter((one) => one === 'POST /api/machines/cachyos-g14/readiness')).toHaveLength(1)
  })

  it('hides Install on all while an install it started is running', async () => {
    await draw({
      ...base(both),
      ...keyed,
      'GET /api/readiness': [200, looked.ok([missing('cachyos-g14'), missing('macbook')])],
      'POST /api/machines/cachyos-g14/install': [0, undefined],
      'POST /api/machines/macbook/install': [202, undefined],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Install on all' }))
    expect(await screen.findByText('installing on cachyos-g14…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install on all' })).toBeNull()
  })

  it('installs on every machine that offers Install, and leaves the others alone', async () => {
    const routes: Routes = {
      ...base([up, upToo, linux2]),
      ...keyed,
      'GET /api/readiness': [200, looked.ok([missing('cachyos-g14'), missing('macbook'), checks(tools, '', 'ubuntu')])],
      'POST /api/machines/cachyos-g14/install': [202, undefined],
      'POST /api/machines/macbook/install': [202, undefined],
    }
    const asked = await draw(routes)
    fireEvent.click(screen.getByRole('button', { name: 'Install on all' }))
    expect(await screen.findByText('installing on cachyos-g14…')).toBeTruthy()
    expect(await screen.findByText('installing on macbook…')).toBeTruthy()
    expect(asked.filter((one) => one.endsWith('/install'))).toHaveLength(2)
    expect(asked).not.toContain('POST /api/machines/ubuntu/install')
  })

  it('skips a machine whose install stopped on a password', async () => {
    const stopped: Event = {
      at: 9,
      kind: 'install_stopped',
      workspace: null,
      machine: up.name,
      said: 'x',
      commands: ['sudo pacman -S --noconfirm tmux'],
    }
    const asked = await draw({
      ...base(both),
      ...keyed,
      'GET /api/readiness': [200, looked.ok([missing('cachyos-g14'), missing('macbook')])],
      'GET /api/notifications': [200, looked.ok([stopped])],
      'POST /api/machines/macbook/install': [202, undefined],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Install on all' }))
    expect(await screen.findByText('installing on macbook…')).toBeTruthy()
    expect(asked).not.toContain('POST /api/machines/cachyos-g14/install')
  })

  it('lets one machine fail without stopping the others', async () => {
    await draw({
      ...base(both),
      ...keyed,
      'GET /api/readiness': [200, looked.ok([missing('cachyos-g14'), missing('macbook')])],
      'POST /api/machines/cachyos-g14/install': [500, 'ssh did not answer'],
      'POST /api/machines/macbook/install': [202, undefined],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Install on all' }))
    expect(await screen.findByText('The install on cachyos-g14 did not start')).toBeTruthy()
    expect(await screen.findByText('installing on macbook…')).toBeTruthy()
  })

  it('lets one check fail without stopping the others', async () => {
    await draw({
      ...base(both),
      ...keyed,
      'POST /api/machines/cachyos-g14/readiness': [500, 'ssh did not answer'],
      'POST /api/machines/macbook/readiness': [200, looked.ok(checks(tools, '', 'macbook'))],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check all' }))
    expect(await screen.findByText('cachyos-g14 was not asked')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('ready · 7 of 7')).toBeTruthy())
  })

  it('shows neither button when every machine is asleep or ready', async () => {
    await draw(base([linux, mac]))
    expect(screen.queryByRole('button', { name: /all$/ })).toBeNull()
    cleanup()
    await draw({ ...base(both), ...keyed, 'GET /api/readiness': [200, looked.ok([checks(tools), checks(tools, '', 'macbook')])] })
    expect(screen.queryByRole('button', { name: /all$/ })).toBeNull()
  })
})
