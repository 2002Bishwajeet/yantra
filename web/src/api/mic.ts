import { type ApiError, micError, type MicKind } from '@/api/errors'
import tap from './mic.worklet.ts?worker&url'

/** ADR-0031 §4: what the daemon's `pw-cat` plays. 16 kHz mono s16le. */
export const RATE = 16_000
/** 20 ms of audio per binary frame. */
export const FRAME_BYTES = 640

export function micAddress(machine: string): string {
  return `${location.origin.replace(/^http/, 'ws')}/api/machines/${encodeURIComponent(machine)}/mic`
}

/** Where the next output sample falls, in input samples from the start of the
 *  next block, and the last sample of the block before it. `at` is in [-1, …):
 *  at -0.5 the sample is between `last` and the next block's first. */
export type Carry = { at: number; last: number }
export const START: Carry = { at: 0, last: 0 }

/** One block at `fromRate` as 16 kHz s16le bytes, by linear interpolation.
 *  The carry spans blocks, so the output never drifts from the input's clock. */
export function toPcm16(
  block: Float32Array,
  fromRate: number,
  carry: Carry,
): { bytes: Uint8Array<ArrayBuffer>; carry: Carry } {
  const step = fromRate / RATE
  const end = block.length - 1
  const count = carry.at > end ? 0 : Math.floor((end - carry.at) / step) + 1
  const out = new DataView(new ArrayBuffer(count * 2))
  let at = carry.at
  for (let i = 0; i < count; i += 1, at += step) {
    const below = Math.floor(at)
    const from = below < 0 ? carry.last : block[below]
    const to = block[below + 1] ?? from
    const value = Math.max(-1, Math.min(1, from + (to - from) * (at - below)))
    out.setInt16(i * 2, Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), true)
  }
  return {
    bytes: new Uint8Array(out.buffer),
    carry: { at: at - block.length, last: block[end] ?? carry.last },
  }
}

const nameOf = (cause: unknown) =>
  typeof cause === 'object' && cause !== null && 'name' in cause ? String(cause.name) : ''
const wordsOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const captured: Record<string, MicKind> = {
  NotAllowedError: 'denied',
  SecurityError: 'denied',
  NotFoundError: 'no-device',
  OverconstrainedError: 'no-device',
  NotReadableError: 'busy',
}

function fromCapture(cause: unknown): ApiError {
  return micError(captured[nameOf(cause)] ?? 'capture', wordsOf(cause))
}

/** The context first, so a socket that cannot be made leaves no context open. */
function connect(machine: string): { context: AudioContext; socket: WebSocket } {
  const context = new AudioContext()
  try {
    return { context, socket: new WebSocket(micAddress(machine)) }
  } catch (cause) {
    void context.close().catch(() => {})
    throw cause
  }
}

export type MicState = 'opening' | 'listening'

/** One press: the microphone, the audio graph and the socket. */
export type Mic = { close: () => void }

/** Opens the microphone and the socket together, from inside the press so iOS
 *  lets the `AudioContext` start. `close` is the release: it stops every
 *  track and closes the context at once, so the microphone is never open
 *  while the button is up (§6). The socket closes once it has sent what was
 *  heard. `onEnd` runs once — `null` for a release, the reason for anything
 *  else, including a permission that a prompt granted after the release. */
export function openMic(
  machine: string,
  { onEnd, onState }: { onEnd: (error: ApiError | null) => void; onState: (state: MicState) => void },
): Mic {
  if (!window.isSecureContext) {
    onEnd(micError('insecure', location.origin))
    return { close: () => {} }
  }

  let made: ReturnType<typeof connect>
  try {
    made = connect(machine)
  } catch (cause) {
    onEnd(micError('capture', wordsOf(cause)))
    return { close: () => {} }
  }
  const { context, socket } = made

  let ended = false
  let released = false
  let asking = true
  let hungUp = false
  // Unknown counts as a prompt: Safari's prompt is what ends the first hold.
  let prompted = true
  let stream: MediaStream | undefined
  let heard = false
  let opened = false
  let batch = new Uint8Array(0)
  let carry = START
  // Frames made while the socket connects; the daemon's pipe takes it from there.
  const waiting: Uint8Array<ArrayBuffer>[] = []
  socket.binaryType = 'arraybuffer'
  // Inside the gesture, which is the only place iOS lets a context start.
  void context.resume().catch(() => {})
  void navigator.permissions
    ?.query({ name: 'microphone' as PermissionName })
    .then((status) => (prompted = status.state !== 'granted'))
    .catch(() => {})

  const send = (frame: Uint8Array<ArrayBuffer>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(frame)
    else if (socket.readyState === WebSocket.CONNECTING) waiting.push(frame)
  }

  const finish = (error: ApiError | null) => {
    if (ended) return
    ended = true
    onEnd(error)
  }

  const stopAudio = () => {
    for (const track of stream?.getTracks() ?? []) track.stop()
    void context.close().catch(() => {})
    if (batch.length > 0) send(new Uint8Array(batch))
    batch = new Uint8Array(0)
  }

  const hangUp = () => {
    hungUp = true
    socket.close()
  }

  const fail = (error: ApiError) => {
    if (ended) return
    stopAudio()
    hangUp()
    finish(error)
  }

  const release = () => {
    if (ended || released) return
    released = true
    stopAudio()
    if (asking) {
      hangUp()
      // A prompt that is still open ends this press when it is answered.
      if (!prompted) finish(null)
      return
    }
    // `onopen` sends what is waiting, then closes.
    if (socket.readyState === WebSocket.CONNECTING && waiting.length > 0) return
    hangUp()
    finish(null)
  }

  const ready = () => {
    if (!ended && !released && heard && socket.readyState === WebSocket.OPEN) onState('listening')
  }

  const take = (block: Float32Array) => {
    if (ended || released) return
    const made = toPcm16(block, context.sampleRate, carry)
    carry = made.carry
    const joined = new Uint8Array(batch.length + made.bytes.length)
    joined.set(batch)
    joined.set(made.bytes, batch.length)
    let at = 0
    for (; at + FRAME_BYTES <= joined.length; at += FRAME_BYTES) send(joined.slice(at, at + FRAME_BYTES))
    batch = joined.slice(at)
  }

  socket.onopen = () => {
    opened = true
    for (const frame of waiting.splice(0)) socket.send(frame)
    if (released && !ended) {
      hangUp()
      finish(null)
      return
    }
    ready()
  }
  socket.onmessage = (frame: MessageEvent<string | ArrayBuffer>) => {
    if (typeof frame.data === 'string') fail(micError('socket', frame.data))
  }
  // A refused upgrade is an error event and then the close that ends it.
  socket.onerror = () => {}
  socket.onclose = () => {
    if (ended || hungUp) return
    fail(
      opened
        ? micError('socket', 'the daemon closed the microphone')
        : micError('refused', 'the daemon refused the microphone'),
    )
  }
  onState('opening')

  void (async () => {
    try {
      const got = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      asking = false
      stream = got
      if (ended || released) {
        for (const track of got.getTracks()) track.stop()
        finish(micError('allowed', ''))
        return
      }
      for (const track of got.getTracks()) {
        track.addEventListener('ended', () => fail(micError('stopped', `${track.label || 'the microphone'} ended`)))
      }
      await context.audioWorklet.addModule(tap)
      if (ended || released) return
      const node = new AudioWorkletNode(context, 'yantra-tap', { numberOfOutputs: 0 })
      node.port.onmessage = (block: MessageEvent<Float32Array>) => take(block.data)
      context.createMediaStreamSource(got).connect(node)
      heard = true
      ready()
    } catch (cause) {
      asking = false
      fail(fromCapture(cause))
    }
  })()

  return { close: release }
}
