import { vi } from 'vitest'
import { render } from '@testing-library/react'
import App from '@/App'
import * as contract from '@/contract.gen'
import { answer as responded } from '@/test/daemon'
import { writePrefs } from './prefs'
import type { FormFactor } from './formFactor'

// The shell loads these after first paint; warm them so a 1 s `findBy` is not
// racing Vite's transform.
await Promise.all([import('./Account'), import('./BellPopover'), import('./NotificationsSheet')])

const WIDTH: Record<FormFactor, number> = { phone: 390, tablet: 834, desktop: 1440 }

/** The shell at one of the brief's three widths, over the contract fixtures —
 *  or, with `down`, over a proxy with no daemon behind it. Returns every
 *  request the page made, method and path. */
export function mount(size: FormFactor, path = '/', options: { down?: boolean } = {}) {
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
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      // Y-358: a 502 with an empty body is what Vite's proxy answers with
      // nothing behind it, and what a dead `yantrad` looks like from here.
      if (options.down) return Promise.resolve(responded(502, ''))
      const status = /^\/api\/workspaces\/([^/]+)\/status$/.exec(path)
      const answer = status
        ? contract.agents.find((one) => one.data.workspace === status[1])
        : {
            '/api/workspaces': contract.workspaces,
            '/api/machines': contract.machines,
            '/api/sessions': contract.sessions,
            '/api/attention': contract.attention,
            '/api/notifications': contract.notifications,
            '/api/about': contract.about,
            '/api/readiness': contract.readiness,
          }[path]
      return Promise.resolve(
        answer
          ? { ok: true, status: 200, json: () => Promise.resolve(answer) }
          : { ok: false, status: 404, text: () => Promise.resolve('no'), json: () => Promise.reject(new Error('no')) },
      )
    }),
  )
  history.pushState(null, '', path)
  render(<App />)
  return asked
}

export function unmount() {
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
  writePrefs({ seenAt: null, theme: 'system', density: 'clean', seed: null, general: {} })
  localStorage.clear()
}
