import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Machine, Readiness } from '@/api'
import { aMachine, looked } from '@/api/fixtures'
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

const clipboard = (writeText: ((text: string) => Promise<void>) | undefined) =>
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clipboard(undefined)
  window.getSelection()?.removeAllRanges()
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

  it('draws the daemon words when the machines could not be read, and still names the join command', async () => {
    await draw({ ...base(), 'GET /api/machines': [200, { looked: 'failed', age_seconds: 0, error: 'tailscaled is down' }] })
    expect(await screen.findByText('Machines could not be read')).toBeTruthy()
    expect(screen.getByText(COMMAND)).toBeTruthy()
  })

  /** Walk-through Q2.3: one ready machine is enough, and an asleep one waits
   *  for nothing. */
  it('is done at one ready machine', async () => {
    const up = { ...linux, online: true }
    const checks = ['reachable', 'sshd', 'tmux', 'agent-cli'].map((one) => ({ check: one, state: 'present', detail: '' }))
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
    expect(screen.getAllByText(COMMAND)).toHaveLength(2)
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

  it('fails with the daemon words when the daemon facts could not be read, and builds no command', async () => {
    await draw({ ...base(), 'GET /api/about': [503, 'tailscale did not answer'] })
    expect((await screen.findAllByText(/tailscale did not answer/)).length).toBeGreaterThan(0)
    expect(screen.getByText("the daemon's address could not be read, so the join command cannot be built")).toBeTruthy()
    expect(screen.queryByText(COMMAND)).toBeNull()
  })
})

describe('the join command and Copy', () => {
  /** `listen_on` refuses to start without an address, so this is rare, but a
   *  line that says "reading…" forever would be a lie. */
  it('says the daemon reports no tailnet address, and what to check, when it lists none', async () => {
    await draw({ ...base(), 'GET /api/about': [200, { ...contract.about, relay: false, listening_on: [] }] })
    expect(
      await screen.findByText(/the daemon reports no tailnet address, so the join command cannot be built · check that Tailscale is up/),
    ).toBeTruthy()
    expect(screen.queryByText(/reading the daemon's address/)).toBeNull()
    expect(screen.queryByText(/curl -fsSL/)).toBeNull()
  })

  it("is built from the daemon's bound address on HTTP, and the footer says it runs in a terminal", async () => {
    await draw(base())
    expect(screen.getByText(COMMAND)).toBeTruthy()
    expect(screen.getByText(/One step runs in a terminal: the join command/)).toBeTruthy()
    expect(screen.queryByText(/Nothing here needs a terminal/)).toBeNull()
  })

  it('copies where a clipboard exists', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    clipboard(writeText)
    await draw(base())
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    expect(await screen.findByRole('button', { name: 'Copied the join command' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(COMMAND)
  })

  /** `navigator.clipboard` needs a secure context, and plain HTTP to a
   *  tailnet address is not one. */
  it('selects the text and says how to copy it where there is no clipboard', async () => {
    clipboard(undefined)
    await draw(base())
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    expect(await screen.findByText(/this page has no clipboard, so the text is selected/)).toBeTruthy()
    expect(window.getSelection()?.toString()).toBe(COMMAND)
    expect(screen.getByRole('button', { name: 'Copy the join command' })).toBeTruthy()
  })

  it('selects the text when the clipboard refuses the write', async () => {
    clipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    await draw(base())
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    expect(await screen.findByText(/the text is selected/)).toBeTruthy()
    expect(window.getSelection()?.toString()).toBe(COMMAND)
  })
})
