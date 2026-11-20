import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { type Answers, mountSettings, sent, unmountSettings } from './harness'

const ENDPOINT = 'https://web.push.apple.com/QGk3'
const KEYS = { p256dh: 'BCVxsr7N', auth: 'BTBZMqHH6r4Tts7J_aSIgg' }

type Sub = {
  endpoint: string
  options: { applicationServerKey: ArrayBuffer }
  toJSON: () => unknown
  unsubscribe: ReturnType<typeof vi.fn>
}

type Browser = {
  /** What the prompt answers; `permission` is what the browser holds before it. */
  permission: NotificationPermission
  answers?: NotificationPermission
  /** A subscription the browser already holds, made for this key. */
  held?: Uint8Array
  subscribe?: () => Promise<never>
}

let current: Sub | null

function subscription(key: ArrayBuffer): Sub {
  const made: Sub = {
    endpoint: ENDPOINT,
    options: { applicationServerKey: key },
    // `expirationTime` is in a real `toJSON()`, and the daemon refuses an unknown field.
    toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: KEYS }),
    unsubscribe: vi.fn(async () => {
      if (current === made) current = null
      return true
    }),
  }
  return made
}

const serverKey = () =>
  Uint8Array.from(atob(contract.pushKey.key.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0))

/** A browser that has Web Push, in the state `browser` names. */
function browser(given: Browser) {
  current = given.held ? subscription(given.held.buffer as ArrayBuffer) : null
  const subscribe = vi.fn(async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
    if (given.subscribe) return given.subscribe()
    current = subscription(options.applicationServerKey.buffer as ArrayBuffer)
    return current
  })
  const registration = { pushManager: { getSubscription: async () => current, subscribe } }
  const requestPermission = vi.fn(async () => {
    notification.permission = given.answers ?? given.permission
    return notification.permission
  })
  const notification = { permission: given.permission, requestPermission }
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('Notification', notification)
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => registration, ready: Promise.resolve(registration), register: vi.fn() },
  })
  return { subscribe, requestPermission }
}

afterEach(() => {
  cleanup()
  unmountSettings()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  Reflect.deleteProperty(navigator, 'standalone')
})

const mount = (answers: Answers = {}) =>
  mountSettings('phone', '/settings/notifications', {
    'GET /api/push/key': [200, contract.pushKey],
    'POST /api/push/subscriptions': [204],
    'DELETE /api/push/subscriptions': [204],
    'POST /api/push/test': [204],
    ...answers,
  })

const device = async () => within(await screen.findByRole('region', { name: 'This device' }))

describe('a browser that cannot get Web Push', () => {
  it('on an iPhone in a browser tab, says to add Yantra to the Home Screen and offers no button', async () => {
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: false })
    mount()
    const group = await device()

    expect(
      await group.findByText(
        'Add Yantra to the Home Screen first: tap Share, then Add to Home Screen. Turn notifications on there.',
      ),
    ).toBeTruthy()
    expect(group.queryByRole('button')).toBeNull()
  })

  it('on the plain http address, names the https address', async () => {
    mount()
    const group = await device()

    expect(await group.findByText('Open Yantra at its https address to get notifications on this device.')).toBeTruthy()
    expect(group.queryByRole('button')).toBeNull()
  })

  it('with no push manager anywhere else, says this browser cannot', async () => {
    vi.stubGlobal('isSecureContext', true)
    mount()

    expect(await (await device()).findByText('This browser cannot get notifications from Yantra.')).toBeTruthy()
  })

  it('says blocked when the browser already refused, and never prompts', async () => {
    const { requestPermission } = browser({ permission: 'denied' })
    mount()
    const group = await device()

    expect(await group.findByText(/^Blocked · allow notifications for Yantra/)).toBeTruthy()
    expect(group.queryByRole('button')).toBeNull()
    expect(requestPermission).not.toHaveBeenCalled()
  })
})

describe('turning notifications on', () => {
  it('prompts from the tap, subscribes with the daemon key and posts the subscription', async () => {
    const { subscribe, requestPermission } = browser({ permission: 'default', answers: 'granted' })
    let posted: unknown
    const asked = mount({
      'POST /api/push/subscriptions': (init) => {
        posted = sent(init)
        return [204]
      },
    })
    const group = await device()
    expect(await group.findByText('Off')).toBeTruthy()
    expect(requestPermission).not.toHaveBeenCalled()

    fireEvent.click(group.getByRole('button', { name: 'Turn on' }))
    // Before any request: iOS refuses a prompt that a tap did not start.
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(asked).not.toContain('GET /api/push/key')

    expect(await group.findByText('On · alerts arrive on this device')).toBeTruthy()
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: serverKey() })
    expect(posted).toEqual({ endpoint: ENDPOINT, keys: KEYS })
    expect(group.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    expect(group.getByRole('button', { name: 'Send a test' })).toBeTruthy()
  })

  it('says blocked and asks the daemon nothing when the prompt is refused', async () => {
    browser({ permission: 'default', answers: 'denied' })
    const asked = mount()
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn on' }))

    expect(await group.findByText(/^Blocked/)).toBeTruthy()
    expect(asked.filter((one) => one.includes('/api/push'))).toEqual([])
  })

  it('stays off when the prompt is closed with no answer', async () => {
    const { subscribe } = browser({ permission: 'default', answers: 'default' })
    mount()
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn on' }))

    expect(await group.findByRole('button', { name: 'Turn on' })).toBeTruthy()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('replaces a subscription made for an older key', async () => {
    const { subscribe } = browser({ permission: 'granted', held: new Uint8Array([4, 1, 2, 3]) })
    const old = current
    mount()
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn off' }))
    fireEvent.click(await group.findByRole('button', { name: 'Turn on' }))
    await group.findByRole('button', { name: 'Turn off' })
    expect(old?.unsubscribe).toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('says the key was not saved on a 500, with the daemon words, and leaves the browser unsubscribed', async () => {
    browser({ permission: 'default', answers: 'granted' })
    mount({ 'GET /api/push/key': [500, 'the signing key could not be kept: /etc/yantra/daemon.env could not be written'] })
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn on' }))

    const alert = within(await screen.findByRole('alert'))
    expect(alert.getByText('Yantra could not save its notification key, so notifications stay off.')).toBeTruthy()
    expect(alert.getByText(/daemon\.env could not be written/)).toBeTruthy()
    expect(group.getByRole('button', { name: 'Turn on' })).toBeTruthy()
    expect(current).toBeNull()
  })

  it('unsubscribes the browser again when the daemon refuses the device', async () => {
    browser({ permission: 'default', answers: 'granted' })
    mount({ 'POST /api/push/subscriptions': [409, '16 devices get notifications already. Turn one off first.'] })
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn on' }))

    const alert = within(await screen.findByRole('alert'))
    expect(alert.getByText('Yantra could not add this device.')).toBeTruthy()
    expect(alert.getByText('16 devices get notifications already. Turn one off first.')).toBeTruthy()
    expect(current).toBeNull()
    expect(group.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })

  it('says the browser could not when its push manager throws', async () => {
    browser({
      permission: 'default',
      answers: 'granted',
      subscribe: () => Promise.reject(new Error('Registration failed - push service error')),
    })
    mount()
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn on' }))

    const alert = within(await screen.findByRole('alert'))
    expect(alert.getByText('This browser could not change its notifications.')).toBeTruthy()
    expect(alert.getByText('Registration failed - push service error')).toBeTruthy()
  })
})

describe('a device that has notifications on', () => {
  const on = () => browser({ permission: 'granted', held: serverKey() })

  it('sends a test to this device and says so', async () => {
    on()
    let named: unknown
    mount({
      'POST /api/push/test': (init) => {
        named = sent(init)
        return [204]
      },
    })
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Send a test' }))

    expect(await group.findByText('Sent · look for it on this device')).toBeTruthy()
    expect(named).toEqual({ endpoint: ENDPOINT })
  })

  it('says to turn it on again when the daemon no longer lists the device', async () => {
    on()
    mount({ 'POST /api/push/test': [404, 'this device is not on the list'] })
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Send a test' }))

    expect(
      await screen.findByText('Yantra no longer lists this device. Turn notifications off and on again.'),
    ).toBeTruthy()
  })

  it('says the test did not arrive on a 502, with what the push service answered', async () => {
    on()
    mount({ 'POST /api/push/test': [502, 'the push service answered 403'] })
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Send a test' }))

    const alert = within(await screen.findByRole('alert'))
    expect(alert.getByText('The test alert did not reach this device.')).toBeTruthy()
    expect(alert.getByText('the push service answered 403')).toBeTruthy()
  })

  it('turns off at the daemon first, then in the browser', async () => {
    on()
    const held = current
    let named: unknown
    mount({
      'DELETE /api/push/subscriptions': (init) => {
        named = sent(init)
        return [204]
      },
    })
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn off' }))

    expect(await group.findByRole('button', { name: 'Turn on' })).toBeTruthy()
    expect(named).toEqual({ endpoint: ENDPOINT })
    expect(held?.unsubscribe).toHaveBeenCalled()
    expect(group.queryByRole('button', { name: 'Send a test' })).toBeNull()
  })

  it('stays on when the daemon does not answer the turn off', async () => {
    on()
    const held = current
    mount({ 'DELETE /api/push/subscriptions': [500, 'the thread store failed'] })
    const group = await device()

    fireEvent.click(await group.findByRole('button', { name: 'Turn off' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(group.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    expect(held?.unsubscribe).not.toHaveBeenCalled()
  })
})
