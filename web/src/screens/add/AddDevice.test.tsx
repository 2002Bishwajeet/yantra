import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Event, Machine, Readiness } from '@/api'
import { aMachine, looked } from '@/api/fixtures'
import { mountSettings, unmountSettings, type Answers } from '@/screens/settings/harness'

/* The flow mounted whole, over a fleet with one device mid-flow. The
   settings harness is the app with its fleet answered; `/add` is its path. */

const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'
const laptop = aMachine({ name: 'laptop', os: 'linux', online: true })

const event = (kind: Event['kind'], at: number, more: Partial<Event> = {}): Event => ({
  at,
  kind,
  workspace: null,
  machine: 'laptop',
  said: `laptop ${kind}`,
  commands: [],
  joined: null,
  ...more,
})

const checks = (states: Record<string, 'present' | 'absent'>): Readiness => ({
  machine: 'laptop',
  checks: Object.entries(states).map(([check, state]) => ({ check, state, detail: `${check} ${state}` })),
})

const reached = checks({ reachable: 'present', sshd: 'present', tmux: 'absent', git: 'present', 'agent-cli': 'present' })
const whole = checks({ reachable: 'present', sshd: 'present', tmux: 'present', git: 'present', 'agent-cli': 'present' })
const clean = event('joined', 5, {
  said: 'laptop joined, and Yantra logs in there as biswa',
  joined: { machine: 'laptop', user: 'biswa', kept: false, logs_in_as: 'biswa' },
})

function fleet(machines: Machine[], events: Event[], sweep: Readiness[] = [], more: Answers = {}): Answers {
  return {
    'GET /api/machines': [200, looked.ok(machines)],
    'GET /api/notifications': [200, looked.ok(events)],
    'GET /api/readiness': [200, looked.ok(sweep)],
    ...more,
  }
}

const beat = (name: string) => within(screen.getByRole('heading', { level: 2, name }).closest('li')!)

afterEach(() => {
  cleanup()
  unmountSettings()
})

describe('the platform', () => {
  it('guesses it from this browser, and lets it be changed', async () => {
    mountSettings('desktop', '/add', fleet([], []))
    expect(await screen.findByText(/guessed from this browser/)).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Linux' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'macOS' }))
    expect(await screen.findByText('chosen by you')).toBeTruthy()
    expect(screen.getByText(/waiting for a new Mac on the tailnet/)).toBeTruthy()
    expect(screen.getByText(/tailscale.com\/download\/mac/)).toBeTruthy()
  })

  it('says Windows is coming and draws no beat', async () => {
    mountSettings('desktop', '/add?platform=windows', fleet([], []))
    expect(await screen.findByRole('heading', { name: 'Windows · coming soon' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'On the tailnet' })).toBeNull()
  })

  it('ends a phone at the home screen, with nothing after the tailnet to wait on', async () => {
    const phone = aMachine({ name: 'iphone', os: 'iOS', online: true })
    mountSettings('phone', '/add?platform=phone&machine=iphone', fleet([phone], []))
    expect(await screen.findByText(/done · iphone is on the tailnet as iOS/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Open the dashboard there' })).toBeTruthy()
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy()
    expect(screen.getByRole('img', { name: /QR code/ })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Reachable over ssh' })).toBeNull()
  })
})

describe('beat 1, on the tailnet', () => {
  it("waits with Tailscale's commands, and offers the nodes already there", async () => {
    mountSettings('desktop', '/add?platform=linux', fleet([laptop], []))
    const one = await screen.findByText(/waiting for a new Linux machine on the tailnet/)
    expect(one).toBeTruthy()
    expect(screen.getByText('curl -fsSL https://tailscale.com/install.sh | sh')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'laptop' }).getAttribute('href')).toBe('/add?platform=linux&machine=laptop')
    expect(beat('Joined').getByText(/waits for the device to be on the tailnet/)).toBeTruthy()
  })

  it('is stuck when the tailnet list failed', async () => {
    mountSettings('desktop', '/add?platform=linux', { 'GET /api/machines': [200, looked.failed('tailscaled is down')] })
    expect(await screen.findByText(/stuck · the tailnet list could not be read · tailscaled is down/)).toBeTruthy()
  })

  it('is stuck on a device that is offline', async () => {
    mountSettings('desktop', '/add?platform=linux&machine=laptop', fleet([{ ...laptop, online: false }], []))
    expect(await screen.findByText(/laptop is on the tailnet and offline now/)).toBeTruthy()
  })
})

describe('beat 2, joined', () => {
  it('waits with the join command, a link to this page and its QR code', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent, clipboard: { writeText } })
    mountSettings('desktop', '/add?platform=linux&machine=laptop', fleet([laptop], []))
    expect(await screen.findByText(/waiting · run the join command once in a terminal on laptop/)).toBeTruthy()
    expect(await screen.findByText(COMMAND)).toBeTruthy()
    expect(screen.getByText('http://localhost:3000/add?platform=linux&machine=laptop')).toBeTruthy()
    expect(screen.getByRole('img', { name: /QR code for http:\/\/localhost:3000\/add/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMAND))
  })

  it("is done on the join event, in the daemon's words", async () => {
    mountSettings('desktop', '/add?platform=linux&machine=laptop', fleet([laptop], [clean]))
    expect(await screen.findByText(/done · laptop joined, and Yantra logs in there as biswa/)).toBeTruthy()
    expect(screen.queryByText(COMMAND)).toBeNull()
  })

  it('is stuck, and says so, when the ssh config logs in as another account', async () => {
    const other = event('joined', 5, {
      said: 'laptop joined as biswa, but the ssh config logs in there as yantra, so Yantra cannot reach it until the owner edits that config',
      joined: { machine: 'laptop', user: 'biswa', kept: true, logs_in_as: 'yantra' },
    })
    mountSettings('desktop', '/add?platform=linux&machine=laptop', fleet([laptop], [other]))
    expect(await screen.findByText(/stuck · laptop joined as biswa, but the ssh config logs in there as yantra/)).toBeTruthy()
    expect(beat('Reachable over ssh').getByText(/waits for the join/)).toBeTruthy()
  })

  it('draws the failure when the events could not be read', async () => {
    mountSettings('desktop', '/add?platform=linux&machine=laptop', {
      ...fleet([laptop], []),
      'GET /api/notifications': [503, 'tailscale did not answer'],
    })
    expect(await screen.findByText(/stuck · the daemon's events could not be read/)).toBeTruthy()
    expect(within(beat('Joined').getByRole('alert')).getByText('tailscale did not answer')).toBeTruthy()
  })

  it('shows Remote Login on a Mac', async () => {
    const mac = aMachine({ name: 'laptop', os: 'macOS', online: true })
    mountSettings('desktop', '/add?platform=macOS&machine=laptop', fleet([mac], []))
    expect(await screen.findByText(/turn on Remote Login in System Settings → General → Sharing/)).toBeTruthy()
  })
})

describe('beat 3, reachable', () => {
  it('asks when Check is pressed, and goes done on the answer', async () => {
    const asked = mountSettings('desktop', '/add?platform=linux&machine=laptop', {
      ...fleet([laptop], [clean]),
      'POST /api/machines/laptop/readiness': [200, looked.ok(reached)],
    })
    expect(await screen.findByText(/Yantra asks laptop when it joins · Check asks now/)).toBeTruthy()
    expect(asked).not.toContain('POST /api/machines/laptop/readiness')
    fireEvent.click(beat('Reachable over ssh').getByRole('button', { name: 'Check' }))
    expect(await screen.findByText(/done · Yantra reached laptop over ssh · sshd present/)).toBeTruthy()
  })

  it('is stuck on a refused reach', async () => {
    const refused = { machine: 'laptop', checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] } as Readiness
    mountSettings('desktop', '/add?platform=linux&machine=laptop', fleet([laptop], [clean], [refused]))
    expect(await screen.findByText(/stuck · ssh did not get into laptop · Permission denied/)).toBeTruthy()
  })

  it('draws the refusal when the ask failed', async () => {
    mountSettings('desktop', '/add?platform=linux&machine=laptop', {
      ...fleet([laptop], [clean]),
      'POST /api/machines/laptop/readiness': [503, 'tailscale did not answer'],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))
    const alert = await beat('Reachable over ssh').findByRole('alert')
    expect(within(alert).getByText('laptop was not asked')).toBeTruthy()
    expect(within(alert).getByText('tailscale did not answer')).toBeTruthy()
  })
})

describe('beat 4, ready', () => {
  it('installs on request and waits for the install event', async () => {
    const asked = mountSettings('desktop', '/add?platform=linux&machine=laptop', {
      ...fleet([laptop], [clean], [reached]),
      'POST /api/machines/laptop/install': [202],
    })
    expect(await screen.findByText(/waiting · missing tmux · Install adds what is missing/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText(/waiting · installing on laptop/)).toBeTruthy()
    expect(asked).toContain('POST /api/machines/laptop/install')
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('shows each command a sudo-blocked install left, with Copy', async () => {
    const stopped = event('install_stopped', 9, {
      said: 'laptop: tmux left for you: sudo asks for a password there',
      commands: ['sudo apt-get install -y tmux'],
    })
    mountSettings('desktop', '/add?platform=linux&machine=laptop', fleet([laptop], [stopped, clean], [reached]))
    expect(await screen.findByText(/stuck · laptop: tmux left for you/)).toBeTruthy()
    expect(screen.getByText('sudo apt-get install -y tmux')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the command for laptop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it("draws the daemon's refusal when the install did not start", async () => {
    mountSettings('desktop', '/add?platform=linux&machine=laptop', {
      ...fleet([laptop], [clean], [reached]),
      'POST /api/machines/laptop/install': [409, 'an install is already running on laptop'],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    const alert = await beat('Ready').findByRole('alert')
    expect(within(alert).getByText('an install is already running on laptop')).toBeTruthy()
  })

  it('names Homebrew and the Command Line Tools on a Mac', async () => {
    const mac = aMachine({ name: 'laptop', os: 'macOS', online: true })
    mountSettings('desktop', '/add?platform=macOS&machine=laptop', fleet([mac], [clean], [reached]))
    expect(await screen.findByText(/Install needs Homebrew for tmux and git/)).toBeTruthy()
    expect(screen.getByText('xcode-select --install')).toBeTruthy()
  })

  it('ends at New session when tmux, git and claude are there', async () => {
    mountSettings('desktop', '/add?platform=linux&machine=laptop', fleet([laptop], [clean], [whole]))
    expect(await screen.findByText(/done · laptop is ready · tmux, git and claude are there/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'New session' }).getAttribute('href')).toBe('/new')
  })
})
