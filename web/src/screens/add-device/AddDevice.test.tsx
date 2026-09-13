import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Event, Machine, Readiness } from '@/api'
import { aMachine, looked } from '@/api/fixtures'
import { mountSettings, unmountSettings, type Answers } from '@/screens/settings/harness'

/* The flow mounted whole, over a fleet with one device mid-flow. The
   settings harness is the app with its fleet answered; `/machines/add` is its
   path. */

const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'
const HERE = 'http://localhost:3000/machines/add?platform=linux&machine=laptop'
const laptop = aMachine({ name: 'laptop', os: 'linux', online: true })
const at = (query: string) => `/machines/add?${query}`

const event = (kind: Event['kind'], time: number, more: Partial<Event> = {}): Event => ({
  at: time,
  kind,
  workspace: null,
  machine: 'laptop',
  said: `laptop ${kind}`,
  commands: [],
  ...more,
})

const checks = (states: Record<string, 'present' | 'absent'>): Readiness => ({
  machine: 'laptop',
  checks: Object.entries(states).map(([check, state]) => ({ check, state, detail: `${check} ${state}` })),
})

const reached = checks({ reachable: 'present', sshd: 'present', tmux: 'absent', git: 'present', 'agent-cli': 'present' })
const whole = checks({ reachable: 'present', sshd: 'present', tmux: 'present', git: 'present', 'agent-cli': 'present' })
const clean = event('joined', 5, { joined: { machine: 'laptop', user: 'biswa', kept: false, logs_in_as: 'biswa' } })

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
    mountSettings('desktop', '/machines/add', fleet([], []))
    expect(await screen.findByText(/guessed from this browser/)).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Linux' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'macOS' }))
    expect(await screen.findByText('chosen by you')).toBeTruthy()
    expect(screen.getByText(/watching the tailnet for a new Mac/)).toBeTruthy()
    expect(screen.getByText(/tailscale.com\/download\/mac/)).toBeTruthy()
  })

  it('says Windows is coming and draws no beat', async () => {
    mountSettings('desktop', at('platform=windows'), fleet([], []))
    expect(await screen.findByRole('heading', { name: 'Windows · coming soon' })).toBeTruthy()
    expect(screen.getByText(/it cannot run a session yet/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'On the tailnet' })).toBeNull()
  })

  it('ends a phone at the home screen, with nothing after the tailnet to wait on', async () => {
    const phone = aMachine({ name: 'iphone', os: 'iOS', online: true })
    mountSettings('phone', at('platform=mobile&machine=iphone'), fleet([phone], []))
    expect(await screen.findByText(/done · iphone is on the tailnet/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Open the dashboard on it and add it to your home screen' })).toBeTruthy()
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy()
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Reachable over ssh' })).toBeNull()
  })
})

describe('beat 1, on the tailnet', () => {
  it("watches with Tailscale's commands, and offers the nodes already there", async () => {
    mountSettings('desktop', at('platform=linux'), fleet([laptop], []))
    expect(await screen.findByText(/waiting · watching the tailnet for a new Linux machine/)).toBeTruthy()
    expect(screen.getByText('curl -fsSL https://tailscale.com/install.sh | sh')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'laptop' }).getAttribute('href')).toBe('/machines/add?platform=linux&machine=laptop')
    expect(beat('Joined').getByText(/not yet · waits for the device to be on the tailnet/)).toBeTruthy()
  })

  it('draws the failure inline when the tailnet list could not be read', async () => {
    mountSettings('desktop', at('platform=linux'), { 'GET /api/machines': [200, looked.failed('tailscaled is down')] })
    expect(await screen.findByText(/stuck · the tailnet list could not be read/)).toBeTruthy()
    expect(within(beat('On the tailnet').getByRole('alert')).getByText('tailscaled is down')).toBeTruthy()
  })

  it('is stuck on a device that is offline', async () => {
    mountSettings('desktop', at('platform=linux&machine=laptop'), fleet([{ ...laptop, online: false }], []))
    expect(await screen.findByText(/laptop is on the tailnet and offline now/)).toBeTruthy()
  })
})

describe('beat 2, joined', () => {
  it('waits with the join command, this page to open on the device, and its QR code', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent, clipboard: { writeText } })
    mountSettings('desktop', at('platform=linux&machine=laptop'), fleet([laptop], []))
    expect(await screen.findByText(/waiting · run this in a terminal on laptop/)).toBeTruthy()
    expect(await screen.findByText(COMMAND)).toBeTruthy()
    expect(screen.getByText(HERE)).toBeTruthy()
    expect(await screen.findByRole('img', { name: `A QR code for ${HERE}` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMAND))
  })

  it('is done on the join event, and folds its body away', async () => {
    mountSettings('desktop', at('platform=linux&machine=laptop'), fleet([laptop], [clean]))
    expect(await screen.findByText(/done · joined as biswa/)).toBeTruthy()
    expect(screen.queryByText(COMMAND)).toBeNull()
  })

  /** The owner's ruling: the page says when the account differs. */
  it('is stuck, and says so, when the ssh config logs in as another account', async () => {
    const other = event('joined', 5, { joined: { machine: 'laptop', user: 'biswa', kept: true, logs_in_as: 'yantra' } })
    mountSettings('desktop', at('platform=linux&machine=laptop'), fleet([laptop], [other]))
    expect(await screen.findByText(/stuck · joined as biswa, and ssh logs in as yantra; a config you wrote was kept/)).toBeTruthy()
    expect(beat('Reachable over ssh').getByText(/not yet · waits for the join/)).toBeTruthy()
  })

  it('draws the failure inline when the events could not be read', async () => {
    mountSettings('desktop', at('platform=linux&machine=laptop'), {
      ...fleet([laptop], []),
      'GET /api/notifications': [503, 'tailscale did not answer'],
    })
    expect(await screen.findByText(/stuck · the daemon's events could not be read/)).toBeTruthy()
    expect(within(beat('Joined').getByRole('alert')).getByText('tailscale did not answer')).toBeTruthy()
  })

  it('shows Remote Login on a Mac', async () => {
    const mac = aMachine({ name: 'laptop', os: 'macOS', online: true })
    mountSettings('desktop', at('platform=macos&machine=laptop'), fleet([mac], []))
    expect(await screen.findByText(/First turn on Remote Login: System Settings → General → Sharing/)).toBeTruthy()
  })
})

describe('beat 3, reachable', () => {
  it('asks when Check again is pressed, and goes done on the answer', async () => {
    const asked = mountSettings('desktop', at('platform=linux&machine=laptop'), {
      ...fleet([laptop], [clean]),
      'POST /api/machines/laptop/readiness': [200, looked.ok(reached)],
    })
    expect(await screen.findByText(/Check asks now/)).toBeTruthy()
    expect(asked).not.toContain('POST /api/machines/laptop/readiness')
    fireEvent.click(beat('Reachable over ssh').getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/done · reachable over ssh/)).toBeTruthy()
  })

  it("is stuck with the check's own detail", async () => {
    const refused = { machine: 'laptop', checks: [{ check: 'reachable', state: 'absent', detail: 'Permission denied (publickey)' }] } as Readiness
    mountSettings('desktop', at('platform=linux&machine=laptop'), fleet([laptop], [clean], [refused]))
    expect(await screen.findByText(/stuck · Permission denied \(publickey\)/)).toBeTruthy()
  })

  it('draws the refusal when the ask failed', async () => {
    mountSettings('desktop', at('platform=linux&machine=laptop'), {
      ...fleet([laptop], [clean]),
      'POST /api/machines/laptop/readiness': [503, 'tailscale did not answer'],
    })
    expect(await screen.findByText(/Check asks now/)).toBeTruthy()
    fireEvent.click(beat('Reachable over ssh').getByRole('button', { name: 'Check again' }))
    const alert = await beat('Reachable over ssh').findByRole('alert')
    expect(within(alert).getByText('laptop was not asked')).toBeTruthy()
    expect(within(alert).getByText('tailscale did not answer')).toBeTruthy()
  })
})

describe('beat 4, ready', () => {
  it('installs on request and waits for the install event', async () => {
    const asked = mountSettings('desktop', at('platform=linux&machine=laptop'), {
      ...fleet([laptop], [clean], [reached]),
      'POST /api/machines/laptop/install': [202],
    })
    expect(await screen.findByText(/waiting · missing tmux · Install adds tmux, git and claude/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText(/waiting · installing…/)).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'installing on laptop' })).toBeTruthy()
    expect(asked).toContain('POST /api/machines/laptop/install')
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('shows each command a sudo-blocked install left, with Copy', async () => {
    const stopped = event('install_stopped', 9, {
      said: 'laptop: tmux left for you: sudo asks for a password there',
      commands: ['sudo apt-get install -y tmux'],
    })
    mountSettings('desktop', at('platform=linux&machine=laptop'), fleet([laptop], [stopped, clean], [reached]))
    expect(await screen.findByText(/stuck · laptop: tmux left for you/)).toBeTruthy()
    expect(screen.getByText('sudo apt-get install -y tmux')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the command for laptop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install' }).dataset.variant).toBe('tonal')
  })

  it("draws the daemon's refusal when the install did not start", async () => {
    mountSettings('desktop', at('platform=linux&machine=laptop'), {
      ...fleet([laptop], [clean], [reached]),
      'POST /api/machines/laptop/install': [409, 'an install is already running on laptop'],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    const alert = await beat('Ready').findByRole('alert')
    expect(within(alert).getByText('an install is already running on laptop')).toBeTruthy()
  })

  it('names Homebrew and the Command Line Tools on a Mac', async () => {
    const mac = aMachine({ name: 'laptop', os: 'macOS', online: true })
    mountSettings('desktop', at('platform=macos&machine=laptop'), fleet([mac], [clean], [reached]))
    expect(await screen.findByText(/Install needs Homebrew for tmux and git/)).toBeTruthy()
    expect(screen.getByText('xcode-select --install')).toBeTruthy()
  })

  it('ends at New session when every check is present', async () => {
    mountSettings('desktop', at('platform=linux&machine=laptop'), fleet([laptop], [clean], [whole]))
    expect(await screen.findByText(/done · ready · open a session on laptop/)).toBeTruthy()
    expect(beat('Ready').getByRole('link', { name: 'New session' }).getAttribute('href')).toBe('/new')
  })
})
