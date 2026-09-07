import { vi } from 'vitest'
import { configure, render } from '@testing-library/react'
import App from '@/App'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import type { FormFactor } from '@/shell/formFactor'
import { writePrefs } from '@/shell/prefs'

// The settings chunk is lazy, and the first test in a file pays its transform.
configure({ asyncUtilTimeout: 5_000 })

// The one eager route. These tests never open it, and its own row is still
// landing beside this one.
vi.mock('@/screens/dashboard/Dashboard', () => ({ Dashboard: () => null }))

const WIDTH: Record<FormFactor, number> = { phone: 390, tablet: 834, desktop: 1440 }

export type Answer = [status: number, body?: unknown]
export type Answers = Record<string, Answer | ((init?: RequestInit) => Answer)>

/** The fleet a settings page reads around its own facts, so the shell draws
 *  and every category has a real list to count. */
const fleet: Answers = {
  'GET /api/workspaces': [200, contract.workspaces],
  'GET /api/machines': [200, contract.machines],
  'GET /api/sessions': [200, contract.sessions],
  'GET /api/attention': [200, contract.attention],
  'GET /api/notifications': [200, contract.notifications],
  'GET /api/readiness': [200, contract.readiness],
  'GET /api/about': [200, contract.about],
  'GET /api/ssh-identity': [200, contract.sshIdentity],
  'GET /api/github': [200, contract.github],
  'POST /api/viewing': [204],
}

/** The app at one width and one settings path, over the contract fixtures
 *  with `answers` laid on top. Returns every request as `METHOD path`. */
export function mountSettings(size: FormFactor, path: string, answers: Answers = {}) {
  const asked: string[] = []
  const width = WIDTH[size]
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // xterm.js still asks for the legacy pair on the device-pixel-ratio query.
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path}`
      asked.push(key)
      const found = { ...fleet, ...answers }[key]
      const [status, body] = typeof found === 'function' ? found(init) : (found ?? [404, { error: `no fixture for ${key}` }])
      return Promise.resolve(answer(status, body))
    }),
  )
  history.pushState(null, '', path)
  render(<App />)
  return asked
}

export function unmountSettings() {
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
  writePrefs({ seenAt: null, theme: 'system', density: 'clean', seed: null, general: {} })
  localStorage.clear()
}

export const sent = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>
