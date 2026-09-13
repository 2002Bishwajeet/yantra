import { describe, expect, it } from 'vitest'
import type { Check, Event } from '@/api'
import { answer, listed, missingBasics, needsSudo, newestInstall } from './install'

const check = (name: string, state: Check['state']): Check => ({ check: name, state, detail: '' })

const event = (at: number, kind: Event['kind'], machine: string | null): Event => ({
  at,
  kind,
  workspace: null,
  machine,
  said: `${machine}: ${kind}`,
  commands: [],
})

describe('missingBasics', () => {
  it('names the tool, not the check, and only for an absent one', () => {
    const checks = [
      check('tmux', 'absent'),
      check('git', 'present'),
      check('agent-cli', 'absent'),
      check('provider-cli', 'absent'),
    ]
    expect(missingBasics(checks)).toEqual(['tmux', 'claude'])
  })

  it('never counts unknown as missing (R-23)', () => {
    expect(missingBasics([check('tmux', 'unknown'), check('git', 'unknown')])).toEqual([])
  })
})

describe('the install result', () => {
  const events = [
    event(50, 'unreachable', 'pi'),
    event(40, 'installed', 'nas'),
    event(30, 'install_stopped', 'pi'),
    event(20, 'installed', 'pi'),
  ]

  it('is the newest install event for this machine and nothing else', () => {
    expect(newestInstall(events, 'pi')?.at).toBe(30)
    expect(newestInstall(events, 'mac')).toBeUndefined()
  })

  it('answers a press only when it is newer than what the page had seen', () => {
    expect(answer(events, 'pi', { since: 30, pressed: 0 })).toBeNull()
    expect(answer(events, 'pi', { since: 20, pressed: 0 })?.at).toBe(30)
  })

  it('needs a password only where install.rs put sudo in front', () => {
    expect(needsSudo('sudo apk add tmux')).toBe(true)
    expect(needsSudo('apk add tmux')).toBe(false)
    expect(needsSudo('xcode-select --install')).toBe(false)
  })
})

describe('listed', () => {
  it('reads as a sentence', () => {
    expect(listed(['tmux'])).toBe('tmux')
    expect(listed(['tmux', 'claude'])).toBe('tmux and claude')
    expect(listed(['tmux', 'git', 'claude'])).toBe('tmux, git and claude')
  })
})
