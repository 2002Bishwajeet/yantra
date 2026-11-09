import { describe, expect, it } from 'vitest'
import type { Check, MachineSessions } from '@/api'
import { aBeat, aMachine, aWorkspace } from '@/api/fixtures'
import { counted, factsOf, machineState, markOf, rowMark, rowWord, summary, tally, toFix, unclaimed, wordOf } from './facts'

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
    expect(summary(tally([]))).toBe('not checked')
  })

  /** Y-580: the count is built from the rows drawn, so the microphone is a row too. */
  it('counts every check it is given, the microphone included', () => {
    const ok = check('tmux', 'present')
    expect(tally([ok, check('mic', 'absent')])).toEqual({ present: 1, absent: 1, unknown: 0, total: 2 })
    expect(summary(tally([ok, check('mic', 'present')]))).toBe('2 of 2')
  })
})

describe('a row on the machine page', () => {
  it('draws an absent microphone idle and optional, never as something to fix', () => {
    const mic = check('mic', 'absent')
    expect(rowMark(mic)).toBe('idle')
    expect(rowWord(mic)).toBe('optional')
    expect(toFix(mic)).toBe(false)
  })

  it('marks as needs exactly what the chip counts to fix', () => {
    const rows = [
      check('tmux', 'present'),
      check('provider-cli', 'absent'),
      check('hooks', 'absent'),
      check('heartbeat', 'absent'),
      check('login-session', 'unknown'),
      check('mic', 'absent'),
    ]
    expect(rows.filter((one) => rowMark(one) === 'needs').map((one) => one.check)).toEqual(
      rows.filter(toFix).map((one) => one.check),
    )
    expect(rows.filter(toFix)).toHaveLength(4)
    expect(rowMark(check('tmux', 'present'))).toBe('done')
    expect(rowWord(check('hooks', 'absent'))).toBe('missing')
  })
})

describe('the facts line', () => {
  const sized = aMachine({
    os: 'linux',
    heartbeat: aBeat({ arch: 'x86_64', cpu_busy_pct: 15, free_ram_mb: 19942, free_disk_mb: 214003 }),
  })

  it('names os, arch, cpu, memory, disk and the session count', () => {
    expect(factsOf(sized, 2)).toBe('linux · x86_64 · CPU 15% busy · 19 GB memory free · 209 GB disk free · 2 sessions')
    expect(factsOf(sized, 1)).toContain('1 session')
    expect(factsOf(sized, 0)).toContain('no sessions')
    expect(factsOf(sized, null)).not.toContain('session')
  })

  it('shows the os alone, and no zeros, with no heartbeat (I-47)', () => {
    expect(factsOf(aMachine({ heartbeat: null }), null)).toBe('linux')
    expect(factsOf(aMachine({ heartbeat: null }), 2)).toBe('linux · 2 sessions')
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
