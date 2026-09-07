import { vi } from 'vitest'
import { configure, render } from '@testing-library/react'
import App from '@/App'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import type { FormFactor } from '@/shell/formFactor'

// The `/new` chunk is lazy, and the first test in a file pays its transform.
configure({ asyncUtilTimeout: 5_000 })

// The one eager route, which these tests never open.
vi.mock('@/screens/dashboard/Dashboard', () => ({ Dashboard: () => null }))

const WIDTH: Record<FormFactor, number> = { phone: 390, tablet: 834, desktop: 1440 }

export type Answer = [status: number, body?: unknown]
export type Answers = Record<string, Answer | ((sent: Record<string, unknown>) => Answer)>

export const HOME = '/home/biswa'

const dir = (name: string, origin: string | null) => ({
  path: `${HOME}/Github/${name}`,
  name,
  repo: origin !== null,
  origin,
})

/** `$HOME` and the clone home under it, as `dirs` answers them: the machine
 *  already holds `2002Bishwajeet/yantra`, and nothing else the sweep lists. */
export const listing = (path: string) =>
  path === `${HOME}/Github`
    ? {
        machine: 'cachyos-g14',
        path,
        entries: [
          dir('yantra', 'git@github.com:2002Bishwajeet/yantra.git'),
          dir('notes', null),
        ],
      }
    : {
        machine: 'cachyos-g14',
        path: HOME,
        entries: [{ path: `${HOME}/Github`, name: 'Github', repo: false, origin: null }],
      }

/** The fleet every screen reads around its own facts, and the two reads step
 *  2 is about. */
const fleet: Answers = {
  'GET /api/workspaces': [200, contract.workspaces],
  'GET /api/machines': [200, contract.machines],
  'GET /api/sessions': [200, contract.sessions],
  'GET /api/attention': [200, contract.attention],
  'GET /api/notifications': [200, contract.notifications],
  'GET /api/readiness': [200, contract.readiness],
  'GET /api/github': [200, contract.github],
  'GET /api/repos': [200, contract.repos],
  'POST /api/machines/cachyos-g14/dirs': (sent) => [200, listing(String(sent.path ?? HOME))],
  'POST /api/viewing': [204],
}

/** `<App/>` at `/new`, one width, over the contract fixtures with `answers`
 *  laid on top. Returns every request as `METHOD path`. */
export function mountNew(size: FormFactor, path: string, answers: Answers = {}) {
  const asked: string[] = []
  const width = WIDTH[size]
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
      asked.push(key)
      const found = { ...fleet, ...answers }[key]
      const [status, body] =
        typeof found === 'function'
          ? found(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {})
          : (found ?? [404, { error: `no fixture for ${key}` }])
      return Promise.resolve(answer(status, body))
    }),
  )
  history.pushState(null, '', path)
  render(<App />)
  return asked
}

export function unmountNew() {
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
  localStorage.clear()
}
