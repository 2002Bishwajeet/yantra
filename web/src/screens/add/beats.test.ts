import { describe, expect, it } from 'vitest'
import type { Check, Event, Joined, Readiness } from '@/api'
import { aMachine, looked } from '@/api/fixtures'
import { ApiError } from '@/api/errors'
import { guessPlatform, platformOf } from '@/lib/platform'
import { joined, lastAsk, lastInstall, newDevice, onTailnet, reachable, ready, type Beat } from './beats'

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
  joined: null,
  ...more,
})

const reply = (more: Partial<Joined> = {}): Joined => ({ machine: NAME, user: 'biswa', kept: false, logs_in_as: 'biswa', ...more })

const report = (checks: [string, Check['state'], string?][]): Readiness => ({
  machine: NAME,
  checks: checks.map(([check, state, detail]) => ({ check, state, detail: detail ?? '' })),
})

const reached = report([
  ['reachable', 'present'],
  ['sshd', 'present', 'OpenSSH_10.0 answered'],
  ['tmux', 'absent'],
  ['git', 'present'],
  ['agent-cli', 'unknown'],
])

const whole = report([
  ['reachable', 'present'],
  ['sshd', 'present'],
  ['tmux', 'present'],
  ['git', 'present'],
  ['agent-cli', 'present'],
])

describe('the platform', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/140', 0, 'linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Safari/605', 0, 'macOS'],
    // iPadOS asks for the desktop site and says Macintosh; touch gives it away.
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Safari/605', 5, 'phone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', 5, 'phone'],
    ['Mozilla/5.0 (Linux; Android 16; Pixel 9)', 5, 'phone'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, 'windows'],
  ])('guesses %s as %s', (userAgent, maxTouchPoints, platform) => {
    expect(guessPlatform({ userAgent, maxTouchPoints })).toBe(platform)
  })

  it('files each Tailscale os under its flow', () => {
    expect(platformOf({ os: 'iOS' })).toBe('phone')
    expect(platformOf({ os: 'android' })).toBe('phone')
    expect(platformOf({ os: 'macOS' })).toBe('macOS')
    expect(platformOf({ os: 'freebsd' })).toBeNull()
  })
})

describe('beat 1, on the tailnet', () => {
  it('waits while the tailnet is read, and for a new node', () => {
    expect(onTailnet({ looked: 'pending' }, undefined, 'linux').state).toBe('waiting')
    const waiting = onTailnet(looked.ok([aMachine()]), undefined, 'macOS')
    expect(waiting.state).toBe('waiting')
    expect(waiting.words).toMatch(/a new Mac on the tailnet · log in to Tailscale there with the same account/)
  })

  it('is done when the named node is listed and online', () => {
    const one = onTailnet(looked.ok([aMachine({ name: NAME })]), NAME, 'linux')
    expect(one).toMatchObject({ state: 'done', words: 'laptop is on the tailnet as linux' })
    expect(one.machine?.name).toBe(NAME)
  })

  it('is stuck when the list failed, the name is not on it, or the node is offline or expired', () => {
    expect(onTailnet(looked.failed('tailscaled is down'), NAME, 'linux')).toMatchObject({
      state: 'stuck',
      words: 'the tailnet list could not be read · tailscaled is down',
    })
    expect(onTailnet(looked.ok([]), NAME, 'linux').words).toMatch(/lists no device called laptop/)
    expect(onTailnet(looked.ok([aMachine({ name: NAME, online: false })]), NAME, 'linux').words).toMatch(/offline now/)
    expect(onTailnet(looked.ok([aMachine({ name: NAME, expired: true })]), NAME, 'linux').words).toMatch(/key has expired/)
  })

  it('takes the first node of the platform that was not there when the flow opened', () => {
    const list = [aMachine({ name: 'old' }), aMachine({ name: 'phone', os: 'iOS' }), aMachine({ name: 'new' })]
    expect(newDevice(list, null, 'linux')).toBeUndefined()
    expect(newDevice(list, ['old'], 'linux')).toBe('new')
    expect(newDevice(list, ['old'], 'phone')).toBe('phone')
    expect(newDevice(list, ['old', 'new', 'phone'], 'linux')).toBeUndefined()
  })
})

describe('beat 2, joined', () => {
  it('waits for the join command', () => {
    expect(joined(NAME, [], null, null)).toEqual({ state: 'waiting', words: 'run the join command once in a terminal on laptop' })
  })

  it("is done on a clean join, in the daemon's words", () => {
    expect(joined(NAME, [event('joined', 5, { joined: reply(), said: 'laptop joined, and Yantra logs in there as biswa' })], null, null)).toEqual({
      state: 'done',
      words: 'laptop joined, and Yantra logs in there as biswa',
    })
  })

  /** The owner's ruling (ADR-0029): the page says a kept block. */
  it('says a kept block with the same account, and goes on', () => {
    const kept = event('joined', 5, { joined: reply({ kept: true }), said: 'laptop joined as biswa, and the ssh config already named it with that account, so it was kept' })
    expect(joined(NAME, [kept], null, null)).toMatchObject({ state: 'done', words: expect.stringMatching(/so it was kept/) })
  })

  /** The owner's ruling: the page says when the account differs. */
  it('is stuck when ssh logs in as another account, or the config could not be read', () => {
    const other = event('joined', 5, { joined: reply({ kept: true, logs_in_as: 'yantra' }), said: 'laptop joined as biswa, but the ssh config logs in there as yantra' })
    expect(joined(NAME, [other], null, null)).toMatchObject({ state: 'stuck', words: expect.stringMatching(/logs in there as yantra/) })
    const unread = event('joined', 5, { joined: reply({ logs_in_as: null }) })
    expect(joined(NAME, [unread], null, null).state).toBe('stuck')
  })

  it('reads the newest join and ignores other machines', () => {
    const events = [event('joined', 9, { joined: reply() }), event('joined', 5, { joined: reply({ logs_in_as: 'yantra' }) }), event('joined', 7, { machine: 'other' })]
    expect(joined(NAME, events, null, null).state).toBe('done')
    expect(joined('nowhere', events, null, null).state).toBe('waiting')
  })

  it('is done when ssh already gets in, though the event is gone with a restart', () => {
    expect(joined(NAME, [], null, reached).words).toMatch(/answers ssh, so it joined before/)
  })

  it('is stuck, with the error, when the events could not be read', () => {
    const error = new ApiError('network', 'the dashboard could not reach yantrad')
    expect(joined(NAME, [], error, null)).toMatchObject({ state: 'stuck', error })
  })
})

describe('beat 3, reachable', () => {
  it('waits for the join, then for an ask', () => {
    expect(reachable({ state: 'waiting', words: '' }, NAME, null, [], idle, 'linux').words).toBe('waits for the join')
    expect(reachable(done, NAME, null, [], idle, 'linux').words).toMatch(/Check asks now/)
    expect(reachable(done, NAME, null, [], { pending: true, error: null }, 'linux').words).toBe('asking laptop over ssh…')
  })

  it('is done when readiness answers reachable, naming sshd', () => {
    expect(reachable(done, NAME, reached, [], idle, 'linux')).toEqual({
      state: 'done',
      words: 'Yantra reached laptop over ssh · OpenSSH_10.0 answered',
    })
  })

  it('is stuck on a refused reach, and on a Mac names Remote Login', () => {
    const refused = report([['reachable', 'absent', 'Permission denied (publickey)']])
    expect(reachable(done, NAME, refused, [], idle, 'linux').words).toBe('ssh did not get into laptop · Permission denied (publickey)')
    expect(reachable(done, NAME, refused, [], idle, 'macOS').words).toMatch(/check that Remote Login is on$/)
  })

  it("is stuck on the daemon's own re-check after the join", () => {
    const events = [event('unreachable', 6, { said: 'laptop joined, and Yantra could not reach it: timed out' }), event('joined', 5, { joined: reply() })]
    expect(reachable(done, NAME, null, events, idle, 'linux')).toMatchObject({ state: 'stuck', words: expect.stringMatching(/could not reach it/) })
  })

  it('is stuck, with the error, when the ask failed', () => {
    const error = new ApiError('refused', 'tailscale did not answer', { status: 503 })
    expect(reachable(done, NAME, null, [], { pending: false, error }, 'linux')).toMatchObject({ state: 'stuck', error })
  })
})

describe('beat 4, ready', () => {
  it('waits for ssh, and names what Install adds', () => {
    expect(ready({ state: 'stuck', words: '' }, NAME, reached, [], idle, idle).words).toBe('waits for ssh')
    expect(ready(done, NAME, reached, [], idle, idle).words).toBe('missing tmux · could not ask about claude · Install adds what is missing')
  })

  it('is done when tmux, git and claude are there', () => {
    expect(ready(done, NAME, whole, [], idle, idle)).toEqual({ state: 'done', words: 'laptop is ready · tmux, git and claude are there' })
  })

  it('waits while an install runs, or an ask after it', () => {
    expect(ready(done, NAME, reached, [], idle, { pending: true, error: null }).words).toMatch(/^installing on laptop/)
    expect(ready(done, NAME, reached, [event('installed', 9)], idle, idle).words).toMatch(/Check asks laptop again/)
    expect(ready(done, NAME, reached, [], { pending: true, error: null }, idle).words).toBe('asking laptop again…')
  })

  /** Y-386: a step that needs sudo names its command, and the page shows each. */
  it('is stuck on a sudo-blocked install, carrying its commands', () => {
    const stopped = event('install_stopped', 9, { said: 'laptop: tmux left for you', commands: ['sudo apt-get install -y tmux'] })
    expect(ready(done, NAME, reached, [stopped], idle, idle)).toEqual({
      state: 'stuck',
      words: 'laptop: tmux left for you',
      commands: ['sudo apt-get install -y tmux'],
    })
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
