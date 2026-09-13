import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Machine, Readiness } from '@/api'
import { aListed, aMachine, looked } from '@/api/fixtures'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import { renderRouted } from '@/test/inRouter'
import { Setup } from './Setup'

/* The checklist on its own, so a state the Dashboard never draws it in — a
   machine online and refused — is still drawn and asserted. */

const NOW = Date.parse('2026-09-06T12:00:00Z')
const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'

type Routes = Record<string, [number, unknown]>

const linux = aMachine({ name: 'cachyos-g14', os: 'linux', online: false, last_seen: '2026-09-06T11:00:00Z' })
const mac = aMachine({ name: 'macbook', os: 'macOS', online: false, last_seen: '2026-09-06T11:00:00Z' })
const phone = aMachine({ name: 'iphone', os: 'iOS', online: true })
const tablet = aMachine({ name: 'pixel-tablet', os: 'android', online: false })
const windows = aMachine({ name: 'gaming-pc', os: 'windows', online: false })

const base = (machines: Machine[] = [linux, mac, phone, tablet, windows]): Routes => ({
  'GET /api/machines': [200, looked.ok(machines)],
  'GET /api/readiness': [200, looked.ok<Readiness[]>([])],
  'GET /api/workspaces': [200, looked.ok([])],
  'GET /api/about': [200, { ...contract.about, relay: false }],
  'GET /api/ssh-identity': [404, 'no ssh identity yet — the first join makes one'],
  'GET /api/github': [200, contract.disconnected],
})

async function draw(routes: Routes) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const [status, body] = routes[`${init?.method ?? 'GET'} ${path.split('?')[0]}`] ?? [404, 'no']
      return Promise.resolve(answer(status, body))
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await renderRouted(
    <QueryClientProvider client={client}>
      <Setup />
    </QueryClientProvider>,
  )
  await screen.findByText(/of 6 done/)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('the machines the checklist lists', () => {
  it('lists only the machines that run a session, and shows the rest apart', async () => {
    await draw(base())
    expect(await screen.findByText(/0 of 2 machines ready/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Check/ })).toHaveLength(2)
    const apart = within(screen.getByRole('list', { name: 'Devices that open the dashboard' }))
    expect(apart.getByText('iphone')).toBeTruthy()
    expect(apart.getByText('pixel-tablet')).toBeTruthy()
    expect(apart.getAllByText('opens the dashboard · runs no session')).toHaveLength(2)
    expect(apart.getByText('gaming-pc')).toBeTruthy()
    expect(apart.getByText(/Windows · coming soon/)).toBeTruthy()
    expect(apart.queryByText('cachyos-g14')).toBeNull()
  })

  it('draws no second list when every node runs a session', async () => {
    await draw(base([linux, mac]))
    expect(screen.queryByRole('list', { name: 'Devices that open the dashboard' })).toBeNull()
  })

  it('says the tailnet lists no machine when only phones are on it', async () => {
    await draw(base([phone, tablet]))
    expect(await screen.findByText(/lists no machine that runs Linux or macOS/)).toBeTruthy()
  })

  /** Y-390: the join command moved into the guided flow; this slot opens it. */
  it('draws the daemon words when the machines could not be read, and still offers Add a device', async () => {
    await draw({ ...base(), 'GET /api/machines': [200, { looked: 'failed', age_seconds: 0, error: 'tailscaled is down' }] })
    expect(await screen.findByText('Machines could not be read')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Add a device' }).getAttribute('href')).toBe('/add')
    expect(screen.queryByText(COMMAND)).toBeNull()
  })

  /** Walk-through Q2.3: one ready machine is enough, and an asleep one waits
   *  for nothing. Ready is tmux, git and claude behind ssh (§3.2 beat 4). */
  it('is done at one ready machine', async () => {
    const up = { ...linux, online: true }
    const checks = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli'].map((one) => ({ check: one, state: 'present', detail: '' }))
    await draw({
      ...base([up, mac]),
      'GET /api/readiness': [200, looked.ok([{ machine: up.name, checks } as Readiness])],
    })
    expect(await screen.findByText(/1 of 2 machines ready · one is enough to start/)).toBeTruthy()
    expect(screen.getByText(/you have 1/)).toBeTruthy()
  })

  it('gives a refused machine the join command to run on it', async () => {
    const up = { ...linux, online: true }
    const refused = { machine: up.name, checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] }
    await draw({ ...base([up]), 'GET /api/readiness': [200, looked.ok([refused as Readiness])] })
    expect(await screen.findByText(/key refused · run the join command once in a terminal on cachyos-g14/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the join command for cachyos-g14' })).toBeTruthy()
    expect(screen.getAllByText(COMMAND)).toHaveLength(1)
    expect(screen.queryByText(/authorized_keys/)).toBeNull()
  })
})

describe('the ssh step', () => {
  it('names no terminal command before the first join', async () => {
    await draw(base())
    expect(await screen.findByText(/made when the first machine joins/)).toBeTruthy()
    expect(screen.queryByText(/yantra ssh-identity/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy the public key' })).toBeNull()
  })

  it('shows the fingerprint and the key once the daemon has one', async () => {
    await draw({ ...base(), 'GET /api/ssh-identity': [200, contract.sshIdentity] })
    expect(await screen.findByText(/created on the appliance · SHA256:<fingerprint>/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the public key' })).toBeTruthy()
  })
})

describe('push to your phone', () => {
  it('reads the relay the daemon holds', async () => {
    await draw({ ...base(), 'GET /api/about': [200, { ...contract.about, relay: true }] })
    expect(await screen.findByText(/the daemon holds a relay and pushes to it/)).toBeTruthy()
  })

  it('says a saved relay waits for a restart while the daemon holds none', async () => {
    await draw(base())
    expect(await screen.findByText(/no relay yet · one saved in Settings is used after yantrad restarts/)).toBeTruthy()
  })

  it('fails with the daemon words when the daemon facts could not be read', async () => {
    await draw({ ...base(), 'GET /api/about': [503, 'tailscale did not answer'] })
    expect((await screen.findAllByText(/tailscale did not answer/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(COMMAND)).toBeNull()
  })
})

describe('the first session', () => {
  it('waits on you until a workspace exists', async () => {
    await draw(base())
    expect(screen.getByText(/waiting on you · needs one ready machine, you have none yet/)).toBeTruthy()
  })

  it('is done once a workspace exists', async () => {
    await draw({ ...base(), 'GET /api/workspaces': [200, looked.ok([aListed()])] })
    expect(await screen.findByText(/done · 1 workspace made/)).toBeTruthy()
    expect(screen.queryByText('waiting on you')).toBeNull()
  })
})

it('says the one step that runs in a terminal is the join command', async () => {
  await draw(base())
  expect(screen.getByText(/One step runs in a terminal: the join command/)).toBeTruthy()
  expect(screen.queryByText(/Nothing here needs a terminal/)).toBeNull()
})
