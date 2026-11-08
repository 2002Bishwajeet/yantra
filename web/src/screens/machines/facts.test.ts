import { describe, expect, it } from 'vitest'
import type { Check, MachineSessions } from '@/api'
import { aMachine, aWorkspace } from '@/api/fixtures'
import { counted, machineState, markOf, summary, tally, unclaimed, wordOf } from './facts'

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

describe('the count', () => {
  it('is present of total, the one string the card and the Readiness card print', () => {
    expect(counted(tally([check('tmux', 'present'), check('git', 'absent')]))).toBe('1 of 2')
  })
})

describe('the card summary', () => {
  it('counts a machine that passes', () => {
    const checks = [check('reachable', 'present'), check('tmux', 'present')]
    expect(summary(tally(checks))).toBe('2 of 2')
  })

  it('names the failures and the questions that could not be asked', () => {
    const checks = [
      check('reachable', 'absent'),
      check('tmux', 'unknown'),
      check('terminfo', 'unknown'),
    ]
    expect(summary(tally(checks))).toBe('0 of 3 · 1 failing · 2 unknown')
  })

  it('says so when nothing has been asked', () => {
    expect(summary(tally([]))).toBe('not asked yet')
  })

  /** ADR-0031 §9: the optional microphone is counted only once it is there. */
  it('leaves out a microphone that is not there', () => {
    const ok = check('tmux', 'present')
    expect(tally([ok, check('mic', 'absent')])).toEqual({ present: 1, absent: 0, unknown: 0, total: 1 })
    expect(tally([ok, check('mic', 'unknown')]).total).toBe(1)
    expect(summary(tally([ok, check('mic', 'present')]))).toBe('2 of 2')
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
