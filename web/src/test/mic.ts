import { vi } from 'vitest'

/** The browser's half of push-to-talk, faked: a microphone whose permission
 *  the test resolves, an audio graph whose blocks the test pushes, and a
 *  socket the test opens, answers and hangs up. */
export class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static made: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  binaryType = 'blob'
  sent: Uint8Array[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((frame: { data: string | ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.made.push(this)
  }

  send(frame: Uint8Array) {
    this.sent.push(frame)
  }

  close() {
    this.closed = true
    this.readyState = FakeSocket.CLOSED
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  say(text: string) {
    this.onmessage?.({ data: text })
  }

  hangUp() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
}

export class FakeContext {
  static made: FakeContext[] = []
  sampleRate = 48_000
  closed = false
  modules: string[] = []
  audioWorklet = { addModule: async (url: string) => void this.modules.push(url) }

  constructor() {
    FakeContext.made.push(this)
  }

  resume = async () => {}
  close = async () => {
    this.closed = true
  }
  createMediaStreamSource = () => ({ connect: () => {} })
}

export class FakeNode {
  static made: FakeNode[] = []
  port: { onmessage: ((block: { data: Float32Array }) => void) | null } = { onmessage: null }

  constructor() {
    FakeNode.made.push(this)
  }

  push(block: Float32Array) {
    this.port.onmessage?.({ data: block })
  }
}

export type FakeTrack = {
  label: string
  stop: ReturnType<typeof vi.fn>
  addEventListener: (type: string, listener: () => void) => void
  end: () => void
}

export function track(): FakeTrack {
  const ended: (() => void)[] = []
  return {
    label: 'Built-in Microphone',
    stop: vi.fn(),
    addEventListener: (type, listener) => {
      if (type === 'ended') ended.push(listener)
    },
    end: () => ended.forEach((listener) => listener()),
  }
}

/** Installs the fakes. The microphone's request settles when the test says
 *  so; `permission` is what the Permissions API reports, and none by default. */
export function browser({ secure = true, permission }: { secure?: boolean; permission?: PermissionState } = {}) {
  FakeSocket.made = []
  FakeContext.made = []
  FakeNode.made = []
  const one = track()
  let grant: (stream: unknown) => void = () => {}
  let refuse: (error: unknown) => void = () => {}
  const asked = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        grant = resolve
        refuse = reject
      }),
  )
  vi.stubGlobal('isSecureContext', secure)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeNode)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: asked },
    ...(permission ? { permissions: { query: () => Promise.resolve({ state: permission }) } } : {}),
  })
  return {
    track: one,
    asked,
    allow: () => grant({ getTracks: () => [one] }),
    refuse: (name: string, message = 'refused') =>
      refuse(Object.assign(new Error(message), { name })),
    socket: () => FakeSocket.made[0],
    context: () => FakeContext.made[0],
    node: () => FakeNode.made[0],
  }
}

/** A block of `length` samples of a sine at `hz`, at `rate`, from sample `from`. */
export function sine(length: number, rate: number, from = 0, hz = 440, peak = 0.5) {
  return Float32Array.from({ length }, (_, i) => peak * Math.sin((2 * Math.PI * hz * (from + i)) / rate))
}
