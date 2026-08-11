/**
 * D4. Creating a workspace by choosing rather than typing: the directory is
 * walked one level at a time, only a proven absence blocks, and the name
 * follows the directory until you edit it. Y-301, Y-302, Y-303.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Listing, Looked, Machine } from './api'
import App from './App'
import { derive } from './lib/name'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

beforeEach(() => {
  history.pushState(null, '', '/new')
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
})

const laptop: Machine = {
  name: 'cachyos-g14',
  dns_name: 'cachyos-g14.<tailnet>.ts.net.',
  os: 'linux',
  online: true,
  expired: false,
  last_seen: null,
  heartbeat: null,
}

const at = (path: string, entries: Listing['entries']): Listing => ({
  machine: 'cachyos-g14',
  path,
  entries,
})

const code = at('/code', [
  {
    path: '/code/site',
    name: 'site',
    repo: true,
    origin: 'git@github.com:you/my-site.git',
  },
  { path: '/code/scratch', name: 'scratch', repo: false, origin: null },
])

const inside = at('/code/site', [
  { path: '/code/site/docs', name: 'docs', repo: false, origin: null },
])

const empty = at('/code/scratch', [])

/** `dirs` is keyed by the path asked for; `probe` by the path in the body. */
function stub({
  dirs = { '': code, '/code/site': inside, '/code/scratch': empty } as Record<
    string,
    Listing | number
  >,
  probe = {
    '/code/site': { exists: true, origin: 'git@github.com:you/my-site.git' },
    '/code/scratch': { exists: true, origin: null },
  } as Record<string, { exists: boolean; origin: string | null } | number>,
} = {}) {
  const asked: { path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (init?.method === 'POST') asked.push({ path, body })

      if (path.endsWith('/dirs')) {
        const answer = dirs[String(body?.path ?? '')]
        if (typeof answer === 'number' || answer === undefined) {
          return Promise.resolve({
            ok: false,
            status: 503,
            text: () => Promise.resolve('ssh: connect to host: Connection refused'),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(answer),
        })
      }

      if (path.endsWith('/probe')) {
        const answer = probe[String(body?.path)]
        if (typeof answer === 'number' || answer === undefined) {
          return Promise.resolve({
            ok: false,
            status: 503,
            text: () => Promise.resolve('ssh: connect to host: Connection refused'),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ machine: 'cachyos-g14', path: body.path, ...answer }),
        })
      }

      if (path === '/api/workspaces' && init?.method === 'POST') {
        return Promise.resolve({
          status: 201,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        })
      }

      const looks: Record<string, Looked<unknown>> = {
        '/api/machines': { looked: 'ok', age_seconds: 1, data: [laptop] },
        '/api/workspaces': { looked: 'ok', age_seconds: 1, data: [] },
        '/api/sessions': { looked: 'never' },
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(looks[path] ?? { looked: 'never' }),
      })
    }),
  )
  return asked
}

const pick = async () =>
  fireEvent.change(await screen.findByLabelText('Machine'), {
    target: { value: 'cachyos-g14' },
  })

/** Choosing an entry *goes there*; the button *takes where you are*. */
const goTo = async (name: string, path?: string) => {
  const box = await screen.findByLabelText('Directory')
  fireEvent.focus(box)
  fireEvent.change(box, { target: { value: name } })
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }))
  // The listing for the new level has to land before *here* is that level,
  // and the button takes where you are.
  if (path) await screen.findByText(path)
}

const use = async () =>
  fireEvent.click(await screen.findByRole('button', { name: /^Use/ }))

describe('walking to a directory', () => {
  it('asks for nothing until a machine is chosen, then asks once', async () => {
    const asked = stub()
    render(<App />)
    await screen.findByLabelText('Machine')
    expect(asked.filter((one) => one.path.endsWith('/dirs'))).toHaveLength(0)

    await pick()

    expect(await screen.findByText('/code')).toBeTruthy()
    // Distinct levels, not calls: what matters is that it asks about one place
    // rather than fanning out, and a re-render must not turn into a sweep.
    const levels = new Set(
      asked
        .filter((one) => one.path.endsWith('/dirs'))
        .map((one) => JSON.stringify(one.body)),
    )
    expect([...levels]).toEqual(['{}'])
  })

  /** D4 §2: a whole-home sweep measured 8.5 s on this fleet's Mac, so each step
   *  is one level and costs what a probe costs. */
  it('goes one level in, and one request per level', async () => {
    const asked = stub()
    render(<App />)
    await pick()

    await goTo('site')

    expect(await screen.findByText('/code/site')).toBeTruthy()
    const dirs = asked.filter((one) => one.path.endsWith('/dirs'))
    expect(dirs).toHaveLength(2)
    expect(dirs[1]!.body).toEqual({ path: '/code/site' })
  })

  it('filters what is listed rather than asking again', async () => {
    const asked = stub()
    render(<App />)
    await pick()
    await screen.findByText('/code')

    const box = screen.getByLabelText('Directory')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'scr' } })

    expect(await screen.findByRole('option', { name: /scratch/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /site/ })).toBeNull()
    expect(asked.filter((one) => one.path.endsWith('/dirs'))).toHaveLength(1)
  })

  /** A path is a fact about one machine. */
  it('clears the choice when the machine changes', async () => {
    stub()
    render(<App />)
    await pick()
    await goTo('site', '/code/site')
    await use()
    expect(await screen.findByText(/Using \/code\/site\./)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: '' } })

    await waitFor(() =>
      expect(screen.queryByText(/Using \/code\/site\./)).toBeNull(),
    )
  })

  it('says a machine that could not be asked cannot be listed, and still takes a path', async () => {
    stub({ dirs: {}, probe: { '/code/site': { exists: true, origin: null } } })
    render(<App />)
    await pick()

    expect(
      await screen.findByText(/could not be asked what is there/),
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Path'), {
      target: { value: '/code/site' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Use /code/site' }))
    expect(await screen.findByText(/Using \/code\/site\./)).toBeTruthy()
  })
})

/** D4 §5. *Absent* and *could not ask* are different answers and only one of
 *  them is a reason to stop — refusing both would mean you cannot set up a
 *  workspace for a laptop that is shut, which ADR-0009 says is a real target. */
describe('what blocks the create', () => {
  const create = () => screen.getByRole('button', { name: 'Create workspace' })

  it('blocks a directory the machine says is not there', async () => {
    stub({ probe: { '/code/gone': { exists: false, origin: null } } })
    render(<App />)
    await pick()
    await screen.findByText('/code')

    fireEvent.change(screen.getByLabelText('Path'), {
      target: { value: '/code/gone' },
    })
    await use()

    expect(
      await screen.findByText('cachyos-g14 has no directory at /code/gone.'),
    ).toBeTruthy()
    expect(screen.getByText('Make it there, or choose another.')).toBeTruthy()
    expect(create().hasAttribute('disabled')).toBe(true)
  })

  it('allows a directory it could not ask about, and says it is unchecked', async () => {
    stub({ probe: {} })
    render(<App />)
    await pick()
    await screen.findByText('/code')

    fireEvent.change(screen.getByLabelText('Path'), {
      target: { value: '/code/maybe' },
    })
    await use()

    expect(await screen.findByText(/so this path is unchecked/)).toBeTruthy()
    expect(create().hasAttribute('disabled')).toBe(false)
  })

  it('allows a directory with no git origin, and names it', async () => {
    stub()
    render(<App />)
    await pick()
    await goTo('scratch', '/code/scratch')
    await use()

    expect(
      await screen.findByText(/Not a git repository — fine, if that is what/),
    ).toBeTruthy()
    expect(create().hasAttribute('disabled')).toBe(false)
  })

  it('blocks until a directory is chosen at all', async () => {
    stub()
    render(<App />)
    await pick()
    await screen.findByText('/code')
    expect(create().hasAttribute('disabled')).toBe(true)
  })
})

describe('the name', () => {
  it('comes from the repository rather than the directory where there is one', () => {
    expect(derive('/code/site', 'git@github.com:you/my-site.git')).toBe('my-site')
    expect(derive('/code/site', 'https://github.com/you/my-site.git')).toBe(
      'my-site',
    )
    expect(derive('/code/scratch', null)).toBe('scratch')
    // What `validate_name` would refuse is dropped rather than sent.
    expect(derive('/code/my project.v2', null)).toBe('myprojectv2')
  })

  it('follows the directory until it is edited, then stops', async () => {
    stub()
    render(<App />)
    await pick()
    await goTo('site', '/code/site')
    await use()

    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
        'my-site',
      ),
    )

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mine' } })
    fireEvent.change(screen.getByLabelText('Path'), {
      target: { value: '/code/scratch' },
    })
    await use()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('mine')
  })

  it('says a name the daemon would refuse before the button does', async () => {
    stub()
    render(<App />)
    await pick()
    await goTo('site', '/code/site')
    await use()
    await screen.findByText(/Using \/code\/site\./)

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'not a name' },
    })

    expect(screen.getByText(/would refuse this one/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Create workspace' }).hasAttribute('disabled'),
    ).toBe(true)
  })
})

/** `startup: null` is what the rest of Yantra spells *claude*: the workspace
 *  runs nothing of its own and Start passes `agent: 'claude'`. Writing the
 *  string would make it a workspace that starts its own thing — no Resume
 *  (ADR-0015) and `—` in the agent column. */
describe('what it opens with', () => {
  it('sends no startup for claude, and the command for one', async () => {
    const asked = stub()
    render(<App />)
    await pick()
    await goTo('site', '/code/site')
    await use()
    await screen.findByText(/Using \/code\/site\./)
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))

    await waitFor(() =>
      expect(asked.some((one) => one.path === '/api/workspaces')).toBe(true),
    )
    const sent = asked.find((one) => one.path === '/api/workspaces')!
      .body as Record<string, unknown>
    expect(sent).toEqual({
      name: 'my-site',
      machine: 'cachyos-g14',
      repo: '/code/site',
    })
    expect('startup' in sent).toBe(false)
  })

  it('offers no plain shell, because it is the same file as claude', async () => {
    stub()
    render(<App />)
    await pick()

    expect(screen.getByRole('button', { name: 'claude' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'a command…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /plain shell/ })).toBeNull()
  })
})
