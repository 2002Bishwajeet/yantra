import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import { render } from '@testing-library/react'
import App from '@/App'
import * as contract from '@/contract.gen'
import type { FormFactor } from '@/shell/formFactor'

/* Test only. The screens under `screens/` mounted whole, at one of the
   brief's three widths, over the e2e fixture's scenarios — so a unit test and
   a Playwright test read the same fleet. */

type Envelope = { looked: string; data?: unknown; error?: string }
export type Scenario = Record<string, Envelope> & {
  status: Record<string, Envelope>
  refuse?: { status: number; text: string }
}

// jsdom gives `import.meta.url` an http scheme, so the path is from the cwd,
// which vitest makes `web/`.
const scenarios = resolve(process.cwd(), 'e2e/fixture/scenarios')

/** One scenario file, with its `extends` chain folded in. */
export function scenario(name = 'busy'): Scenario {
  const file = JSON.parse(readFileSync(resolve(scenarios, `${name}.json`), 'utf8')) as Scenario & {
    extends?: string
  }
  const { extends: base, ...overlay } = file
  return { ...(base ? scenario(base) : {}), ...overlay } as Scenario
}

const WIDTH: Record<FormFactor, number> = { phone: 390, tablet: 834, desktop: 1440 }

const ok = (data: unknown) => ({ looked: 'ok', age_seconds: 0, data })

function answer(state: Scenario, method: string, path: string): [number, unknown] {
  if (method !== 'GET' && state.refuse) return [state.refuse.status, state.refuse.text]
  const status = /^\/api\/workspaces\/([^/]+)\/status$/.exec(path)
  if (status) return state.status[status[1]!] ? [200, state.status[status[1]!]] : [404, 'no']
  const readiness = /^\/api\/machines\/([^/]+)\/readiness$/.exec(path)
  if (readiness) {
    const list = state.readiness!
    if (list.looked !== 'ok') return [200, list]
    const one = (list.data as { machine: string }[]).find((r) => r.machine === readiness[1])
    return one ? [200, ok(one)] : [404, 'no']
  }
  const verb = /^\/api\/workspaces\/([^/]+)\/(up|down|resume|tokens)$/.exec(path)
  if (verb) {
    const list = state.workspaces!.data as { name: string; machine: string }[]
    const machine = list.find((w) => w.name === verb[1])?.machine ?? 'nowhere'
    switch (verb[2]) {
      case 'up':
        return [200, { machine, session: 'created', launched: true, term: 'xterm-256color' }]
      case 'down':
        return [200, { machine, stopped: true, ending: null }]
      case 'resume':
        return [200, { machine, resumed: true, term: 'xterm-256color' }]
      default:
        return [200, contract.spend]
    }
  }
  const kill = /^\/api\/machines\/([^/]+)\/sessions\/([^/]+)$/.exec(path)
  if (kill) return [200, { machine: kill[1], session: kill[2], killed: true }]
  if (method === 'DELETE' && /^\/api\/workspaces\/[^/]+$/.test(path)) return [204, undefined]
  const read = path.replace('/api/', '')
  return read in state ? [200, state[read]] : [404, 'no']
}

/** Mount `<App/>` at `path`; returns every request made, as `METHOD path`. */
export function mount(size: FormFactor, path: string, state: Scenario = scenario('busy')) {
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
      const method = init?.method ?? 'GET'
      asked.push(`${method} ${path}`)
      const [status, body] = answer(state, method, path.split('?')[0]!)
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => (typeof body === 'string' ? Promise.reject(new SyntaxError('no')) : Promise.resolve(body)),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body ?? '')),
      })
    }),
  )
  history.pushState(null, '', path)
  render(<App />)
  return asked
}

export function unmount() {
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
  localStorage.clear()
}
