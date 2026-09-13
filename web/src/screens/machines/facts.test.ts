import { describe, expect, it } from 'vitest'
import type { Check, MachineSessions } from '@/api'
import { aMachine, aWorkspace } from '@/api/fixtures'
import { verdictOf } from '@/screens/machine/verdict'
import { cardChip, cardVerdict, machineState, markOf, summary, tally, unclaimed, wordOf } from './facts'

const check = (name: string, state: Check['state']): Check => ({
  check: name,
  state,
  detail: `${name} is ${state}`,
})

describe('a check', () => {
  it('tells absent and unknown apart, in the mark and in the word', () => {
    expect(markOf('present')).toBe('done')
    expect(markOf('absent')).toBe('failed')
    expect(markOf('unknown')).toBe('unknown')
    expect(wordOf('absent')).toBe('missing')
    expect(wordOf('unknown')).toBe('unknown')
  })
})

describe('the card summary', () => {
  it('counts a machine that passes', () => {
    const checks = [check('reachable', 'present'), check('tmux', 'present')]
    expect(summary(tally(checks))).toBe('2 of 2 checks')
  })

  it('names the failures and the questions that could not be asked', () => {
    const checks = [
      check('reachable', 'absent'),
      check('tmux', 'unknown'),
      check('terminfo', 'unknown'),
    ]
    expect(summary(tally(checks))).toBe('1 failing · 2 unknown')
  })

  it('says so when nothing has been asked', () => {
    expect(summary(tally([]))).toBe('not asked yet')
  })
})

describe('a machine', () => {
  it('is a mark plus a word, and an expired key is why rather than a fourth state', () => {
    expect(machineState(aMachine())).toEqual({ state: 'running', word: 'online' })
    expect(machineState(aMachine({ online: false }))).toEqual({
      state: 'failed',
      word: 'unreachable',
    })
    expect(machineState(aMachine({ expired: true }))).toEqual({
      state: 'failed',
      word: 'key expired',
    })
  })
})

const ready = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session']
const allPresent = (): Check[] => ready.map((name) => check(name, 'present'))

describe('the card verdict (D7 §3.3)', () => {
  it('is asleep, not failed, for a machine the tailnet says is off', () => {
    expect(cardVerdict(aMachine({ online: false }), allPresent())).toEqual({ kind: 'asleep' })
    expect(cardChip({ kind: 'asleep' }, '3h')).toEqual({ state: 'unknown', word: 'asleep · 3h', error: false })
    expect(cardChip({ kind: 'asleep' }, null)).toEqual({ state: 'unknown', word: 'asleep', error: false })
  })

  it('is a key expired, and that stays an error', () => {
    expect(cardVerdict(aMachine({ expired: true }), [])).toEqual({ kind: 'expired' })
    expect(cardChip({ kind: 'expired' }, null).error).toBe(true)
  })

  it('is unchecked when online and nothing has been asked', () => {
    expect(cardVerdict(aMachine(), [])).toEqual({ kind: 'unchecked' })
  })

  /** The machine page tells these two apart (`reachableFailure`, Y-402
   *  review): a changed host key is not the join command's to fix. */
  it('is refused when the key is refused, and unreachable for any other ssh failure', () => {
    const refused = [{ check: 'reachable', state: 'absent' as const, detail: 'Permission denied (publickey).' }]
    expect(cardVerdict(aMachine(), refused)).toEqual({ kind: 'refused' })
    expect(cardChip({ kind: 'refused' }, null)).toEqual({ state: 'failed', word: 'key refused', error: true })

    const changedKey = [{ check: 'reachable', state: 'absent' as const, detail: 'No route to host' }]
    expect(cardVerdict(aMachine(), changedKey)).toEqual({ kind: 'unreachable' })
    expect(cardChip({ kind: 'unreachable' }, null)).toEqual({ state: 'failed', word: 'ssh failing', error: true })
  })

  it('is needs when a basic is missing, and counts them', () => {
    const checks = allPresent().map((one) => (one.check === 'tmux' ? check('tmux', 'absent') : one))
    expect(cardVerdict(aMachine(), checks)).toEqual({ kind: 'needs', missing: 1 })
    expect(cardChip({ kind: 'needs', missing: 2 }, null)).toEqual({ state: 'needs', word: '2 missing', error: false })
  })

  it('is needs for a basic the report never asked about, same as blocking treats it', () => {
    const noGit = allPresent().filter((one) => one.check !== 'git')
    expect(cardVerdict(aMachine(), noGit)).toEqual({ kind: 'needs', missing: 1 })
  })

  it('is ready when every basic is present, gh and heartbeat aside', () => {
    expect(cardVerdict(aMachine(), allPresent())).toEqual({ kind: 'ready' })
    expect(cardChip({ kind: 'ready' }, null)).toEqual({ state: 'done', word: 'ready', error: false })
  })
})

/** Y-402 review: the card and the machine page read the same
 *  `missingBasics` (`lib/ready`) and the same `reachableFailure`
 *  (`lib/checks`), so they cannot count or classify a report differently. */
describe('the card agrees with the machine page, on the same report', () => {
  const asReading = (checks: Check[]) => ({
    looked: 'ok' as const,
    age_seconds: 0,
    data: { machine: 'pi-5', checks },
  })

  it('counts the same basics missing, including one the report never asked about', () => {
    // As pi-5's report in the busy fixture: `git` is not in it at all, and
    // `agent-cli` is explicitly absent.
    const checks = allPresent()
      .filter((one) => one.check !== 'git')
      .map((one) => (one.check === 'agent-cli' ? check('agent-cli', 'absent') : one))

    const card = cardVerdict(aMachine({ name: 'pi-5' }), checks)
    const page = verdictOf({
      name: 'pi-5',
      machine: aMachine({ name: 'pi-5' }),
      readiness: asReading(checks),
      events: [],
      watch: null,
    })

    expect(card).toEqual({ kind: 'needs', missing: 2 })
    expect(page).toMatchObject({ kind: 'missing', missing: ['git', 'claude'] })
    expect(card.kind === 'needs' ? card.missing : null).toBe(page.kind === 'missing' ? page.missing.length : null)
  })

  it('classifies a refused key the same way', () => {
    const checks = [{ check: 'reachable', state: 'absent' as const, detail: 'Permission denied (publickey).' }]
    const card = cardVerdict(aMachine({ name: 'pi-5' }), checks)
    const page = verdictOf({
      name: 'pi-5',
      machine: aMachine({ name: 'pi-5' }),
      readiness: asReading(checks),
      events: [],
      watch: null,
    })
    expect(card).toEqual({ kind: 'refused' })
    expect(page.kind).toBe('refused')
  })
})

describe('the unclaimed sessions', () => {
  const sessions: MachineSessions[] = [
    {
      machine: 'cachyos-g14',
      reached: 'yes',
      sessions: [
        { name: 'yantra', windows: 1, attached: 0, created: 'now', created_at: 1 },
        { name: 'scratch', windows: 2, attached: 0, created: 'now', created_at: 2 },
      ],
    },
    { machine: 'thinkpad', reached: 'no', error: 'no route to host' },
  ]

  it('are the sessions no workspace on that machine names', () => {
    const held = unclaimed(sessions, [aWorkspace()])
    expect(held.map((one) => one.session.name)).toEqual(['scratch'])
  })

  it('never come from a machine that did not answer', () => {
    expect(unclaimed(sessions, []).every((one) => one.machine === 'cachyos-g14')).toBe(true)
  })

  it('are claimed per machine, so the same name elsewhere is still unclaimed', () => {
    const held = unclaimed(sessions, [
      aWorkspace(),
      aWorkspace({ name: 'scratch', machine: 'macbook' }),
    ])
    expect(held.map((one) => one.session.name)).toEqual(['scratch'])
  })
})
