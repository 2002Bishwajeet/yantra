import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Attention } from '@/api'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { Github } from './Github'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const looked = (data: unknown) => ({ looked: 'ok', age_seconds: 0, data })
const attention = { looked: 'ok', age_seconds: 0, data: contract.attention.data } as const as {
  looked: 'ok'
  age_seconds: number
  data: Attention
}

const workspaces = [
  { loaded: 'yes', name: 'yantra-pi', machine: 'pi', repo: '/home/biswa/Github/Yantra', startup: null },
  { loaded: 'yes', name: 'yantra-web', machine: 'cachyos-g14', repo: '/home/biswa/Github/yantra', startup: null },
  { loaded: 'yes', name: 'landing', machine: 'macbook', repo: '/Users/biswa/Github/yantra-landing', startup: null },
]

type Replies = Partial<Record<string, [number, unknown]>>

function daemon(replies: Replies = {}) {
  const asked: string[] = []
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path}`
      asked.push(key)
      const found: Replies = {
        'GET /api/workspaces': [200, looked(workspaces)],
        'POST /api/placement': [200, contract.placement],
        ...replies,
      }
      const [status, body] = found[key] ?? found[key.replace(/\/workspaces\/[^/]+/, '/workspaces/*')] ?? [404, 'no']
      return Promise.resolve(answer(status, body))
    }),
  )
  return asked
}

const issues = () => within(screen.getByRole('heading', { name: 'Issues' }).closest('.github__group') as HTMLElement)

async function open() {
  await renderInApp(<Github attention={attention} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start session on 2002Bishwajeet/yantra#118' }))
  return screen.findByRole('dialog')
}

describe('Start session', () => {
  it('is on every issue and on no review', async () => {
    daemon()
    await renderInApp(<Github attention={attention} />)
    expect(await issues().findAllByRole('button', { name: /^Start session on / })).toHaveLength(contract.attention.data.issues.length)
    expect(screen.getAllByRole('button', { name: /^Start session on / })).toHaveLength(contract.attention.data.issues.length)
  })

  it('opens a picker of the workspaces that hold the repository, with the machine and its reason', async () => {
    const asked = daemon()
    const dialog = await open()
    expect(within(dialog).getByRole('heading', { name: 'Start a session on 2002Bishwajeet/yantra#118' })).toBeTruthy()
    const list = await within(dialog).findByRole('list', { name: 'Workspaces that hold this repository' })
    const rows = within(list).getAllByRole('listitem')
    // Best score first; the landing workspace's repo is another name and is left out.
    expect(rows.map((one) => within(one).getByRole('button').textContent)).toEqual(['yantra-web', 'yantra-pi'])
    expect(rows[0]!.textContent).toContain('cachyos-g14')
    expect(rows[0]!.textContent).toContain('the repo is there and a workspace ran it there')
    expect(rows[1]!.textContent).toContain('it is on AC power')
    expect(asked).toContain('POST /api/placement')
  })

  it('offers New session when no workspace holds the repository', async () => {
    daemon()
    const other = { ...contract.attention.data.issues[0]!, repo: '2002Bishwajeet/homelab-k8s', number: 31 }
    await renderInApp(<Github attention={{ ...attention, data: { ...attention.data, issues: [other] } }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start session on 2002Bishwajeet/homelab-k8s#31' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('No workspace holds this repository')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'New session' }).getAttribute('href')).toBe('/new')
  })

  it('says the ranking is unknown when placement fails, and still lists by name', async () => {
    daemon({ 'POST /api/placement': [503, 'no machine answered'] })
    const dialog = await open()
    expect(await within(dialog).findByText(/could not be ranked/)).toBeTruthy()
    expect(within(dialog).getAllByRole('listitem').length).toBeGreaterThan(0)
  })

  const kinds: [number, string, string][] = [
    [400, 'not an issue', 'That is not an issue a session can start from.'],
    [404, 'no workspace named `site`', 'The daemon does not know that workspace.'],
    [409, 'no GitHub grant', 'The daemon holds no GitHub sign-in, so it cannot read the issue.'],
    [502, 'GitHub returned 500', 'GitHub did not answer.'],
    [503, 'ssh timed out', 'The workspace machine did not answer.'],
  ]
  it.each(kinds)('draws a %i inside the picker with the daemon words', async (status, said, sentence) => {
    daemon({ 'POST /api/workspaces/*/threads/new': [status, said] })
    const dialog = await open()
    const list = await within(dialog).findByRole('list', { name: 'Workspaces that hold this repository' })
    fireEvent.click(within(list).getAllByRole('button')[0]!)
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('The session could not be started')
    expect(alert.textContent).toContain(sentence)
    expect(alert.textContent).toContain(said)
    const sign = within(alert).queryByRole('link', { name: 'Sign in' })
    if (status === 409) expect(sign?.getAttribute('href')).toBe('/settings/providers')
    else expect(sign).toBeNull()
  })

  it('asks the daemon to open the issue on the workspace picked', async () => {
    const asked = daemon({ 'POST /api/workspaces/*/threads/new': [503, 'stop here'] })
    const dialog = await open()
    const list = await within(dialog).findByRole('list', { name: 'Workspaces that hold this repository' })
    fireEvent.click(within(list).getAllByRole('button')[0]!)
    await waitFor(() => expect(asked.some((one) => /^POST \/api\/workspaces\/[^/]+\/threads\/new$/.test(one))).toBe(true))
  })
})
