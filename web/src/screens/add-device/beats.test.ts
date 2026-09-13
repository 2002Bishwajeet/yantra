import { describe, expect, it } from 'vitest'
import type { Check, Event, Readiness } from '@/api'
import { aMachine, looked } from '@/api/fixtures'
import { ApiError } from '@/api/errors'
import { guessPlatform, platformOf } from '@/lib/platform'
import { joined, lastAsk, lastInstall, newDevice, newStranger, onTailnet, password, reachable, ready, type Beat } from './beats'

const NAME = 'laptop'
const done: Beat = { state: 'done', words: '' }
const idle = { pending: false, error: null }

const event = (kind: Event['kind'], at: number, more: Partial<Event> = {}): Event => ({
  at,
  kind,
  workspace: null,
  machine: NAME,
  said: `${NAME} ${kind}`,
  commands: [],
  ...more,
})

/** Y-399's fields on a `joined` event. */
const reply = (more: Partial<Event> = {}): Partial<Event> => ({ user: 'biswa', kept: false, logs_in_as: 'biswa', ...more })

const report = (checks: [string, Check['state'], string?][]): Readiness => ({
  machine: NAME,
  checks: checks.map(([check, state, detail]) => ({ check, state, detail: detail ?? '' })),
})

/** The seven checks a session needs (`lib/ready`). */
const tools = (
  tmux: Check['state'],
  agent: Check['state'] = 'present',
  terminfo: Check['state'] = 'present',
): [string, Check['state']][] => [
  ['reachable', 'present'],
  ['sshd', 'present'],
  ['tmux', tmux],
  ['git', 'present'],
  ['agent-cli', agent],
  ['terminfo', terminfo],
  ['login-session', 'present'],
]

const reached = report([...tools('absent', 'unknown')])
const whole = report(tools('present'))

describe('the platform', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/140', 0, 'linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Safari/605', 0, 'macos'],
    // iPadOS asks for the desktop site and says Macintosh; touch gives it away.
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Safari/605', 5, 'mobile'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', 5, 'mobile'],
    ['Mozilla/5.0 (Linux; Android 16; Pixel 9)', 5, 'mobile'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, 'windows'],
  ])('guesses %s as %s', (userAgent, maxTouchPoints, platform) => {
    expect(guessPlatform({ userAgent, maxTouchPoints })).toBe(platform)
  })

  it('files each Tailscale os under its flow', () => {
    expect(platformOf({ os: 'iOS' })).toBe('mobile')
    expect(platformOf({ os: 'android' })).toBe('mobile')
    expect(platformOf({ os: 'macOS' })).toBe('macos')
    expect(platformOf({ os: 'linux' })).toBe('linux')
    expect(platformOf({ os: 'freebsd' })).toBeNull()
  })
})

describe('beat 1, on the tailnet', () => {
  it('waits while the tailnet is read, and watches it for a new node', () => {
    expect(onTailnet({ looked: 'pending' }, undefined, 'linux', false).state).toBe('waiting')
    expect(onTailnet(looked.ok([aMachine()]), undefined, 'macos', false)).toMatchObject({
      state: 'waiting',
      words: 'watching the tailnet for a new Mac',
    })
  })

  /** D7 §4.2: after three minutes the beat is stuck and says what to check. */
  it('is stuck when nothing has come after three minutes', () => {
    expect(onTailnet(looked.ok([aMachine()]), undefined, 'linux', true)).toMatchObject({
      state: 'stuck',
      words: expect.stringMatching(/^Not seen yet\. Check that the Linux machine logged in to Tailscale with the same account/),
    })
  })

  it('is done when the named node is listed and online', () => {
    const one = onTailnet(looked.ok([aMachine({ name: NAME })]), NAME, 'linux', false)
    expect(one).toMatchObject({ state: 'done', words: 'laptop is on the tailnet' })
    expect(one.machine?.name).toBe(NAME)
  })

  it('is stuck when the list failed, the name is not on it, or the node is offline or expired', () => {
    expect(onTailnet(looked.failed('tailscaled is down'), NAME, 'linux', false)).toMatchObject({
      state: 'stuck',
      words: 'the tailnet list could not be read',
    })
    expect(onTailnet(looked.ok([]), NAME, 'linux', false).words).toMatch(/lists no device called laptop/)
    expect(onTailnet(looked.ok([aMachine({ name: NAME, online: false })]), NAME, 'linux', false).words).toMatch(/offline now/)
    expect(onTailnet(looked.ok([aMachine({ name: NAME, expired: true })]), NAME, 'linux', false).words).toMatch(/key has expired/)
  })

  it('takes the first node of the platform that was not there when the flow opened', () => {
    const list = [aMachine({ name: 'old' }), aMachine({ name: 'phone', os: 'iOS' }), aMachine({ name: 'new' })]
    expect(newDevice(list, null, 'linux')).toBeUndefined()
    expect(newDevice(list, ['old'], 'linux')).toBe('new')
    expect(newDevice(list, ['old'], 'mobile')).toBe('phone')
    expect(newDevice(list, ['old', 'new', 'phone'], 'linux')).toBeUndefined()
  })
})

/** Y-404, owner 2026-09-13: only a node the appliance's account owns counts. */
describe('beat 1, and whose node it is', () => {
  const shared = aMachine({ name: 'friend', ownership: 'shared' })
  const tagged = aMachine({ name: 'ci', ownership: 'tagged' })

  it('never takes a node another owner holds as the device, and names it apart', () => {
    const list = [aMachine({ name: 'old' }), shared, aMachine({ name: 'mine' })]
    expect(newDevice(list, ['old'], 'linux')).toBe('mine')
    expect(newDevice([aMachine({ name: 'old' }), shared], ['old'], 'linux')).toBeUndefined()
    expect(newStranger(list, ['old'], 'linux')?.name).toBe('friend')
    expect(newStranger(list, null, 'linux')).toBeUndefined()
    expect(newStranger([tagged], [], 'mobile')).toBeUndefined()
  })

  it('is stuck with the reason when only a stranger arrived', () => {
    expect(onTailnet(looked.ok([shared]), undefined, 'linux', false, shared)).toMatchObject({
      state: 'stuck',
      words: "friend is on the tailnet and shared from another account · not supported yet · log in to Tailscale there with the appliance's account",
      machine: null,
    })
    expect(onTailnet(looked.ok([tagged]), undefined, 'linux', false, tagged).words).toMatch(
      /^ci is on the tailnet and tagged, so the tailnet owns it and not your account/,
    )
  })

  it('never ticks for a named node you do not own, even online', () => {
    expect(onTailnet(looked.ok([shared]), 'friend', 'linux', false)).toMatchObject({ state: 'stuck' })
    expect(onTailnet(looked.ok([tagged]), 'ci', 'linux', false).words).toMatch(/not supported yet/)
  })
})

describe('beat 2, joined', () => {
  it('waits for the join command, and is stuck after three minutes', () => {
    expect(joined(NAME, [], null, null, false)).toEqual({ state: 'waiting', words: 'run this in a terminal on laptop' })
    expect(joined(NAME, [], null, null, true)).toEqual({
      state: 'stuck',
      words: 'No join yet. Is curl there? The command must run on laptop itself.',
    })
  })

  it('is done on a clean join', () => {
    expect(joined(NAME, [event('joined', 5, reply())], null, null, false)).toEqual({
      state: 'done',
      words: 'joined as biswa',
    })
  })

  /** The owner's ruling (ADR-0029): the page says a kept block. */
  it('says a kept block with the same account, and goes on', () => {
    expect(joined(NAME, [event('joined', 5, reply({ kept: true }))], null, null, false)).toMatchObject({
      state: 'done',
      words: expect.stringMatching(/so it was kept$/),
    })
  })

  /** The owner's ruling: the page says when the account differs, and what
   *  fixes it. */
  it('is stuck when ssh logs in as another account, or the config could not be read, and names the remedy', () => {
    const other = event('joined', 5, reply({ kept: true, logs_in_as: 'yantra' }))
    expect(joined(NAME, [other], null, null, false)).toEqual({
      state: 'stuck',
      words:
        "joined as biswa, and ssh logs in as yantra; a config you wrote was kept · edit the Host block for laptop in the appliance's ~/.ssh/config",
    })
    // The daemon omits `logs_in_as` when ssh could not be read.
    const unread = event('joined', 5, { user: 'biswa', kept: false })
    expect(joined(NAME, [unread], null, null, false).words).toMatch(/an account Yantra could not read/)
  })

  it('reads the newest join, and takes the sentence of an event with no fields', () => {
    const events = [event('joined', 9, reply()), event('joined', 5, reply({ logs_in_as: 'yantra' }))]
    expect(joined(NAME, events, null, null, false).state).toBe('done')
    expect(joined(NAME, [event('joined', 5, { said: 'laptop joined' })], null, null, false).words).toBe('laptop joined')
  })

  it('is done when ssh already gets in, though the event is gone with a restart', () => {
    expect(joined(NAME, [], null, reached, false).words).toBe('joined earlier · Yantra already reaches it over ssh')
  })

  it('is stuck, with the error, when the events could not be read', () => {
    const error = new ApiError('network', 'the dashboard could not reach yantrad')
    expect(joined(NAME, [], error, null, false)).toMatchObject({ state: 'stuck', error })
  })
})

describe('beat 3, reachable', () => {
  it('is not yet its turn before the join, then waits for an ask', () => {
    expect(reachable({ state: 'waiting', words: '' }, NAME, null, [], idle, 'linux')).toEqual({
      state: 'ahead',
      words: 'waits for the join',
    })
    expect(reachable(done, NAME, null, [], idle, 'linux').words).toMatch(/Check asks now$/)
    expect(reachable(done, NAME, null, [], { pending: true, error: null }, 'linux').words).toBe('Yantra is checking laptop over ssh')
  })

  it('is done when readiness answers reachable', () => {
    expect(reachable(done, NAME, reached, [], idle, 'linux')).toEqual({ state: 'done', words: 'reachable over ssh' })
  })

  it("is stuck with the check's own detail, and on a Mac names Remote Login", () => {
    const refused = report([['reachable', 'absent', 'Permission denied (publickey)']])
    expect(reachable(done, NAME, refused, [], idle, 'linux').words).toBe('Permission denied (publickey)')
    expect(reachable(done, NAME, refused, [], idle, 'macos').words).toMatch(/check that Remote Login is on$/)
  })

  it("is stuck on the daemon's own re-check after the join", () => {
    const events = [event('unreachable', 6, { said: 'laptop joined, and Yantra could not reach it: timed out' }), event('joined', 5, reply())]
    expect(reachable(done, NAME, null, events, idle, 'linux')).toMatchObject({ state: 'stuck', words: expect.stringMatching(/could not reach it/) })
  })

  it('is stuck, with the error, when the ask failed', () => {
    const error = new ApiError('refused', 'tailscale did not answer', { status: 503 })
    expect(reachable(done, NAME, null, [], { pending: false, error }, 'linux')).toMatchObject({ state: 'stuck', error })
  })
})

describe('beat 4, ready', () => {
  it('is not yet its turn before ssh, and names what Install adds', () => {
    expect(ready({ state: 'stuck', words: '' }, NAME, reached, [], idle, idle)).toEqual({ state: 'ahead', words: 'waits for ssh' })
    expect(ready(done, NAME, reached, [], idle, idle).words).toBe(
      'missing tmux · could not ask about claude · Install adds tmux, git and claude',
    )
  })

  /** `lib/ready`, the home gate's own test: GitHub and a heartbeat are optional. */
  it('is done when the seven checks a session needs are present, gh or not', () => {
    expect(ready(done, NAME, whole, [], idle, idle)).toEqual({ state: 'done', words: 'ready · open a session on laptop' })
    const gh = report([...tools('present'), ['provider-auth', 'absent'], ['heartbeat', 'absent']])
    expect(ready(done, NAME, gh, [], idle, idle).state).toBe('done')
  })

  /** The gate asks the same function, so an installed event alone would let
   *  the two disagree. */
  it('is not done on an installed event while a check a session needs is missing', () => {
    expect(ready(done, NAME, reached, [event('installed', 9)], idle, idle).state).toBe('waiting')
    const noTerminfo = report(tools('present', 'present', 'absent'))
    expect(ready(done, NAME, noTerminfo, [event('installed', 9)], idle, idle)).toEqual({
      state: 'waiting',
      words: 'missing terminfo · the machine page shows how to fix these',
    })
  })

  it('waits while an install runs, or an ask after it', () => {
    expect(ready(done, NAME, reached, [], idle, { pending: true, error: null }).words).toMatch(/^installing…/)
    expect(ready(done, NAME, reached, [], { pending: true, error: null }, idle).words).toBe('asking laptop again…')
  })

  /** Y-386 and D7 §4.1: a step that needs sudo says what needs the password,
   *  and carries each command for the page to show. */
  it('is stuck on a sudo-blocked install, saying what needs the password', () => {
    const stopped = event('install_stopped', 9, { said: 'laptop: tmux left for you', commands: ['sudo apt-get install -y tmux'] })
    const tmux = report(tools('absent'))
    expect(ready(done, NAME, tmux, [stopped], idle, idle)).toEqual({
      state: 'stuck',
      words: 'tmux needs your password',
      commands: ['sudo apt-get install -y tmux'],
    })
  })

  it('keeps the sentence of a stop that left no command, such as Homebrew missing', () => {
    const stopped = event('install_stopped', 9, { said: 'laptop: tmux left for you: Homebrew is not installed there' })
    expect(ready(done, NAME, reached, [stopped], idle, idle).words).toBe('laptop: tmux left for you: Homebrew is not installed there')
  })

  it('names each tool that needs the password', () => {
    expect(password(report(tools('absent', 'absent')))).toBe('tmux and claude need your password')
    expect(password(whole)).toBe('the install needs your password')
  })

  it('is stuck, with the error, when the install did not start or the ask failed', () => {
    const busy = new ApiError('refused', 'an install is already running on laptop', { status: 409 })
    expect(ready(done, NAME, reached, [], idle, { pending: false, error: busy })).toMatchObject({ state: 'stuck', error: busy })
    expect(ready(done, NAME, reached, [], { pending: false, error: busy }, idle)).toMatchObject({ state: 'stuck', error: busy })
  })

  it('marks where the next ask and the next install land', () => {
    const events = [event('install_stopped', 9), event('joined', 7), event('relay-test', 11, { machine: null })]
    expect(lastAsk(events, NAME)).toBe(9)
    expect(lastInstall(events, NAME)).toBe(9)
    expect(lastInstall([], NAME)).toBe(0)
  })
})
