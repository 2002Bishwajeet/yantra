import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PushKey } from '@/api'
import { fetchJson, fields, json } from './client'
import { ApiError } from './errors'
import { keys } from './keys'

/** ADR-0047: what this browser can do about notifications from Yantra.
 *  `install` is an iPhone or iPad where Yantra is open in a browser tab: iOS
 *  gives Web Push only to the app on the Home Screen. */
export type PushState =
  | { kind: 'unsupported'; why: 'insecure' | 'install' | 'browser' }
  | { kind: 'blocked' }
  | { kind: 'off' }
  | { kind: 'on'; endpoint: string }

type Standalone = Navigator & { standalone?: boolean }

function unsupported(): PushState | null {
  if (!window.isSecureContext) return { kind: 'unsupported', why: 'insecure' }
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return null
  // Only iOS has `navigator.standalone`, and `false` there is a browser tab.
  const tab = (navigator as Standalone).standalone === false
  return { kind: 'unsupported', why: tab ? 'install' : 'browser' }
}

/** What this device is now. It asks the browser only, and it never prompts. */
export async function pushState(): Promise<PushState> {
  const cannot = unsupported()
  if (cannot) return cannot
  if (Notification.permission === 'denied') return { kind: 'blocked' }
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (subscription && Notification.permission === 'granted') return { kind: 'on', endpoint: subscription.endpoint }
  return { kind: 'off' }
}

/** The browser's prompt. Call it in the tap itself: iOS refuses a prompt that
 *  a tap did not start, so nothing may be awaited before it. */
export const askPermission = (): Promise<NotificationPermission> => Notification.requestPermission()

function bytes(key: string): Uint8Array<ArrayBuffer> {
  const text = atob(key.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(text, (char) => char.charCodeAt(0))
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const held = subscription.options.applicationServerKey
  if (!held) return false
  const theirs = new Uint8Array(held)
  return theirs.length === key.length && theirs.every((byte, at) => byte === key[at])
}

const failed = (cause: unknown) => new ApiError('push', cause instanceof Error ? cause.message : String(cause))

/** Subscribes this browser with the daemon's key and gives the daemon the
 *  subscription. `asked` is `askPermission()`, started by the tap. */
export async function turnOn(asked: Promise<NotificationPermission>): Promise<PushState> {
  const permission = await asked
  if (permission === 'denied') return { kind: 'blocked' }
  if (permission !== 'granted') return { kind: 'off' }
  const { key } = await fetchJson<PushKey>('/api/push/key', {}, fields('key'))
  const serverKey = bytes(key)
  let subscription: PushSubscription
  try {
    // A dev build registers no worker at load.
    if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('/sw.js')
    const registration = await navigator.serviceWorker.ready
    const held = await registration.pushManager.getSubscription()
    // A subscription made for an older key gets no push from this daemon.
    if (held && !sameKey(held, serverKey)) await held.unsubscribe()
    subscription =
      held && sameKey(held, serverKey)
        ? held
        : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey })
  } catch (cause) {
    throw failed(cause)
  }
  const { endpoint, keys } = subscription.toJSON()
  try {
    await fetchJson<void>('/api/push/subscriptions', { method: 'POST', ...json({ endpoint, keys }) })
  } catch (error) {
    // The daemon did not take it, so this browser must not look subscribed.
    await subscription.unsubscribe().catch(() => {})
    throw error
  }
  return { kind: 'on', endpoint: subscription.endpoint }
}

/** The daemon forgets the device first, so a failure leaves both sides on. */
export async function turnOff(endpoint: string): Promise<PushState> {
  await fetchJson<void>('/api/push/subscriptions', { method: 'DELETE', ...json({ endpoint }) })
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  } catch (cause) {
    throw failed(cause)
  }
  return { kind: 'off' }
}

/** One push to this device. A 404 is a device the daemon no longer lists. */
export const sendTest = (endpoint: string) =>
  fetchJson<void>('/api/push/test', { method: 'POST', ...json({ endpoint }) })

/** The browser is the source, so nothing goes stale and nothing is asked twice. */
export function usePush() {
  return useQuery<PushState, ApiError>({
    queryKey: keys.push(),
    queryFn: pushState,
    staleTime: Infinity,
    retry: false,
  })
}

export function useTurnOnPush() {
  const client = useQueryClient()
  return useMutation<PushState, ApiError, Promise<NotificationPermission>>({
    mutationFn: turnOn,
    onSuccess: (state) => client.setQueryData(keys.push(), state),
  })
}

export function useTurnOffPush() {
  const client = useQueryClient()
  return useMutation<PushState, ApiError, string>({
    mutationFn: turnOff,
    onSuccess: (state) => client.setQueryData(keys.push(), state),
  })
}

export function useTestPush() {
  return useMutation<void, ApiError, string>({ mutationFn: sendTest })
}
