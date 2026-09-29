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
  kind: 'dir' as const,
  access: true,
  repo: origin !== null,
  origin,
})

const entry = (at: string, name: string, kind: 'dir' | 'file' = 'dir', access = true) => ({
  path: `${at === '/' ? '' : at}/${name}`,
  name,
  kind,
  access,
  repo: false,
  origin: null,
})

/** `/`, `/home`, `$HOME` and the clone home under it, as `dirs` answers them:
 *  the machine already holds `2002Bishwajeet/yantra`, and nothing else the
 *  sweep lists. `$HOME` holds a dotfile, a file and a closed folder (Y-414). */
export const listing = (path: string) => {
  const of = (at: string, entries: unknown[]) => ({
    machine: 'cachyos-g14',
    path: at,
    access: true,
    entries,
    truncated: false,
  })
  if (path === `${HOME}/Github`) {
    return of(path, [dir('yantra', 'git@github.com:2002Bishwajeet/yantra.git'), dir('notes', null)])
  }
  if (path === '/') return of('/', [entry('/', 'home'), entry('/', 'srv'), entry('/', 'root', 'dir', false)])
  if (path === '/home') return of('/home', [entry('/home', 'biswa')])
  return of(HOME, [
    entry(HOME, 'Github'),
    entry(HOME, 'private', 'dir', false),
    entry(HOME, '.config'),
    entry(HOME, 'todo.txt', 'file'),
  ])
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
    // xterm.js still asks for the legacy pair on the device-pixel-ratio query.
    addListener: () => {},
    removeListener: () => {},
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
