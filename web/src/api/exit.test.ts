import { afterEach, describe, expect, it, vi } from 'vitest'
import { exitOf, terminalAddress } from '@/api/socket'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** ADR-0030 §5, the browser's half: the one text frame from the daemon that
 *  is not a refusal. */
describe('a one-off terminal’s frames', () => {
  it('reads the exit frame the daemon ends on, a number or null', () => {
    expect(exitOf('{"exit":0}')).toEqual({ exit: 0 })
    expect(exitOf('{"exit":255}')).toEqual({ exit: 255 })
    expect(exitOf('{"exit":null}')).toEqual({ exit: null })
  })

  it('reads every other text frame as a refusal', () => {
    expect(exitOf('no install on pi left a step 3; press Install again')).toBeNull()
    expect(exitOf('ssh: connect to host pi port 22: No route to host')).toBeNull()
    expect(exitOf('{"rows":24}')).toBeNull()
    expect(exitOf('{"exit":"0"}')).toBeNull()
  })

  it('addresses a step by its place in what the install left, never by its command', () => {
    vi.stubGlobal('location', new URL('https://yantra.tail3a1b.ts.net/'))
    expect(terminalAddress({ machine: 'pi 5', step: 2, at: 1788696000 })).toBe(
      'wss://yantra.tail3a1b.ts.net/api/machines/pi%205/install/2/terminal?at=1788696000',
    )
  })
})
