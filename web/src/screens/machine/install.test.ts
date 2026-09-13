import { describe, expect, it } from 'vitest'
import type { Event } from '@/api'
import { answer, listed, needsSudo, newestInstall } from './install'

const event = (at: number, kind: Event['kind'], machine: string | null): Event => ({
  at,
  kind,
  workspace: null,
  machine,
  said: `${machine}: ${kind}`,
  commands: [],
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
