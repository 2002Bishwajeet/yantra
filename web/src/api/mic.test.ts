/**
 * Push-to-talk's browser half (ADR-0031 §4, §6) against faked browser APIs:
 * the resampler on its own, then one press from open to release, and every
 * way a press ends that is not a release.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { ApiError } from './errors'
import { FRAME_BYTES, micAddress, openMic, START, toPcm16, type MicState } from './mic'
import { browser, sine } from '@/test/mic'

afterEach(() => {
  vi.unstubAllGlobals()
})

const samples = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true))
}

describe('toPcm16', () => {
  it('turns one second at 48 kHz into one second at 16 kHz, across 128-sample blocks', () => {
    let carry = START
    let total = 0
    for (let from = 0; from < 48_000; from += 128) {
      const made = toPcm16(sine(128, 48_000, from), 48_000, carry)
      carry = made.carry
      total += made.bytes.byteLength
    }
    expect(total).toBe(16_000 * 2)
  })

  it('keeps the peak and writes little-endian', () => {
    const { bytes } = toPcm16(Float32Array.from([1, 0, 0, -1, 0, 0, 0.5, 0, 0]), 48_000, START)
    expect(samples(bytes)).toEqual([0x7fff, -0x8000, Math.round(0.5 * 0x7fff)])
    // 0x7fff, low byte first.
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0x7f])
  })

  it('carries a fractional position from one block into the next', () => {
    // 44.1 kHz is 2.75625 input samples per output sample, so no block ends on one.
    const whole = sine(4410, 44_100)
    const once = samples(toPcm16(whole, 44_100, START).bytes)
    let carry = START
    const split: number[] = []
    for (let from = 0; from < whole.length; from += 128) {
      const made = toPcm16(whole.subarray(from, from + 128), 44_100, carry)
      carry = made.carry
      split.push(...samples(made.bytes))
    }
    expect(split).toEqual(once)
    expect(split).toHaveLength(1600)
  })
})

describe('one press', () => {
  it('addresses the machine on the page’s own host', () => {
    vi.stubGlobal('location', new URL('https://yantra.example.ts.net:8443/w/landing'))
    expect(micAddress('pi 5')).toBe('wss://yantra.example.ts.net:8443/api/machines/pi%205/mic')
  })

  it('opens the microphone and the socket, then sends 20 ms binary frames', async () => {
    const fake = browser()
    const states: MicState[] = []
    const onEnd = vi.fn()
    const mic = openMic('pi', { onEnd, onState: (state) => states.push(state) })

    expect(fake.asked).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    expect(fake.socket().url).toMatch(/\/api\/machines\/pi\/mic$/)
    expect(fake.socket().binaryType).toBe('arraybuffer')
    fake.allow()
    await waitFor(() => expect(fake.node()).toBeDefined())
    expect(fake.context().modules).toHaveLength(1)

    // Before the socket opens, frames wait for it.
    for (let from = 0; from < 48_000 * 0.1; from += 128) fake.node().push(sine(128, 48_000, from))
    expect(fake.socket().sent).toEqual([])
    fake.socket().open()
    expect(states).toEqual(['opening', 'listening'])
    const sent = fake.socket().sent
    expect(sent.length).toBeGreaterThanOrEqual(4)
    expect(sent.every((frame) => frame.byteLength === FRAME_BYTES)).toBe(true)
    expect(onEnd).not.toHaveBeenCalled()

    mic.close()
    expect(onEnd).toHaveBeenCalledWith(null)
  })

  it('stops every track and closes the socket and the context on release', async () => {
    const fake = browser()
    const mic = openMic('pi', { onEnd: () => {}, onState: () => {} })
    fake.allow()
    fake.socket().open()
    await waitFor(() => expect(fake.node()).toBeDefined())
    fake.node().push(sine(128, 48_000))

    mic.close()
    expect(fake.track.stop).toHaveBeenCalled()
    expect(fake.socket().closed).toBe(true)
    expect(fake.context().closed).toBe(true)
    // The part of a frame that was made goes before the close.
    expect(fake.socket().sent.at(-1)?.byteLength).toBe(86)
  })

  it('says a permission granted after the release was granted, and leaves nothing open', async () => {
    // Safari's prompt takes the focus, which ends the first hold.
    const fake = browser()
    const onEnd = vi.fn<(error: ApiError | null) => void>()
    const mic = openMic('pi', { onEnd, onState: () => {} })
    mic.close()
    expect(fake.socket().closed).toBe(true)
    expect(fake.context().closed).toBe(true)
    expect(onEnd).not.toHaveBeenCalled()

    fake.allow()
    await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1))
    expect(fake.track.stop).toHaveBeenCalled()
    expect(fake.node()).toBeUndefined()
    const error = onEnd.mock.calls[0][0]
    expect(error?.kind).toBe('allowed')
    expect(error?.describe()).toBe('The browser now allows the microphone. Hold the button again to talk.')
  })

  it('says why when a prompt answered after the release refuses', async () => {
    const fake = browser()
    const onEnd = vi.fn<(error: ApiError | null) => void>()
    openMic('pi', { onEnd, onState: () => {} }).close()
    fake.refuse('NotAllowedError', 'Permission denied')
    await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1))
    expect(onEnd.mock.calls[0][0]?.kind).toBe('denied')
  })

  it('is a silent release before the request resolves when the permission was already granted', async () => {
    const fake = browser({ permission: 'granted' })
    const onEnd = vi.fn()
    const mic = openMic('pi', { onEnd, onState: () => {} })
    // The Permissions API answers on a later turn.
    await Promise.resolve()
    await Promise.resolve()
    mic.close()
    expect(onEnd).toHaveBeenCalledWith(null)
    expect(fake.socket().closed).toBe(true)
    expect(fake.context().closed).toBe(true)

    fake.allow()
    await waitFor(() => expect(fake.track.stop).toHaveBeenCalled())
    expect(fake.node()).toBeUndefined()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('sends what was heard before the socket opened, then closes it', async () => {
    const fake = browser()
    const onEnd = vi.fn()
    const mic = openMic('pi', { onEnd, onState: () => {} })
    fake.allow()
    await waitFor(() => expect(fake.node()).toBeDefined())
    let carry = START
    let made = 0
    for (let from = 0; from < 48_000 * 0.05; from += 128) {
      fake.node().push(sine(128, 48_000, from))
      const block = toPcm16(sine(128, 48_000, from), 48_000, carry)
      carry = block.carry
      made += block.bytes.byteLength
    }

    mic.close()
    // The microphone is off at once (§6); the socket is not, because it holds the audio.
    expect(fake.track.stop).toHaveBeenCalled()
    expect(fake.context().closed).toBe(true)
    expect(fake.socket().closed).toBe(false)
    expect(onEnd).not.toHaveBeenCalled()

    fake.socket().open()
    const sent = fake.socket().sent
    expect(sent.reduce((total, frame) => total + frame.byteLength, 0)).toBe(made)
    expect(fake.socket().closed).toBe(true)
    expect(onEnd).toHaveBeenCalledWith(null)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('is refused when a socket released while connecting never opens', async () => {
    const fake = browser()
    const onEnd = vi.fn<(error: ApiError | null) => void>()
    const mic = openMic('pi', { onEnd, onState: () => {} })
    fake.allow()
    await waitFor(() => expect(fake.node()).toBeDefined())
    fake.node().push(sine(1024, 48_000))
    mic.close()
    fake.socket().hangUp()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd.mock.calls[0][0]?.kind).toBe('refused')
  })
})

describe('a press whose setup throws', () => {
  it.each([
    ['AudioContext', () => vi.stubGlobal('AudioContext', class { constructor() { throw new DOMException('no audio', 'NotSupportedError') } })],
    ['WebSocket', () => vi.stubGlobal('WebSocket', class { constructor() { throw new DOMException('bad address', 'SyntaxError') } })],
  ])('ends with a capture error when the %s constructor throws', (_, broken) => {
    const fake = browser()
    broken()
    const onEnd = vi.fn<(error: ApiError | null) => void>()
    const mic = openMic('pi', { onEnd, onState: () => {} })
    expect(onEnd).toHaveBeenCalledTimes(1)
    const error = onEnd.mock.calls[0][0]
    expect(error?.kind).toBe('capture')
    expect(error?.describe()).toBe('The browser could not open the microphone.')
    expect(fake.asked).not.toHaveBeenCalled()
    expect(fake.context()?.closed ?? true).toBe(true)
    mic.close()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})

describe('a press that ends on its own', () => {
  const ended = async (act: (fake: ReturnType<typeof browser>) => void | Promise<void>, secure = true) => {
    const fake = browser({ secure })
    const onEnd = vi.fn<(error: ApiError | null) => void>()
    openMic('pi', { onEnd, onState: () => {} })
    await act(fake)
    await waitFor(() => expect(onEnd).toHaveBeenCalled())
    expect(onEnd).toHaveBeenCalledTimes(1)
    const error = onEnd.mock.calls[0][0]
    expect(error).toBeInstanceOf(ApiError)
    return { error: error as ApiError, fake }
  }

  it('is insecure on :7717 and asks for nothing', async () => {
    const { error, fake } = await ended(() => {}, false)
    expect(error.kind).toBe('insecure')
    expect(error.describe()).toBe('The microphone works only on the HTTPS address, on port 8443.')
    expect(fake.asked).not.toHaveBeenCalled()
    expect(fake.socket()).toBeUndefined()
  })

  it('is denied when the permission is refused', async () => {
    const { error, fake } = await ended((fake) => fake.refuse('NotAllowedError', 'Permission denied'))
    expect(error.kind).toBe('denied')
    expect(error.said).toBe('Permission denied')
    expect(fake.socket().closed).toBe(true)
  })

  it('is no-device when there is no microphone', async () => {
    const { error } = await ended((fake) => fake.refuse('NotFoundError', 'Requested device not found'))
    expect(error.kind).toBe('no-device')
    expect(error.describe()).toBe('This browser found no microphone to use.')
  })

  it.each([
    ['NotAllowedError', 'denied', 'This browser was not allowed to use the microphone.'],
    ['SecurityError', 'denied', 'This browser was not allowed to use the microphone.'],
    ['NotFoundError', 'no-device', 'This browser found no microphone to use.'],
    ['OverconstrainedError', 'no-device', 'This browser found no microphone to use.'],
    ['NotReadableError', 'busy', 'Another app is using the microphone.'],
    ['AbortError', 'capture', 'The browser could not open the microphone.'],
    ['TypeError', 'capture', 'The browser could not open the microphone.'],
  ])('reads %s as %s', async (name, kind, sentence) => {
    const { error } = await ended((fake) => fake.refuse(name, 'the browser said so'))
    expect(error.kind).toBe(kind)
    expect(error.describe()).toBe(sentence)
    expect(error.said).toBe('the browser said so')
  })

  it('is stopped when the browser takes the track away', async () => {
    const { error, fake } = await ended(async (fake) => {
      fake.allow()
      fake.socket().open()
      await waitFor(() => expect(fake.node()).toBeDefined())
      fake.track.end()
    })
    expect(error.kind).toBe('stopped')
    expect(fake.socket().closed).toBe(true)
    expect(fake.context().closed).toBe(true)
  })

  it('is refused when the socket never opened', async () => {
    const { error, fake } = await ended((fake) => {
      fake.allow()
      fake.socket().hangUp()
    })
    expect(error.kind).toBe('refused')
    await waitFor(() => expect(fake.track.stop).toHaveBeenCalled())
  })

  it('carries the daemon’s text frame as its words', async () => {
    const said = 'the microphone’s writer exited with status 1: target not found'
    const { error, fake } = await ended((fake) => {
      fake.socket().open()
      fake.socket().say(said)
    })
    expect(error.kind).toBe('socket')
    expect(error.said).toBe(said)
    expect(error.describe()).toBe('The microphone on the machine stopped.')
    expect(fake.socket().closed).toBe(true)
  })
})
