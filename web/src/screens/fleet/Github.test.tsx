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

  const grant = 'no GitHub grant — run `yantra github login`'
  const kinds: [number, string, string][] = [
    [400, 'o/r#1 is a pull request, not an issue', 'The daemon refused the request.'],
    [404, 'workspace `site` not found', 'The daemon does not know that workspace.'],
    [404, 'GitHub answered 404 to the issue', 'GitHub has no such issue, or the sign-in cannot see it.'],
    [409, grant, 'The daemon holds no GitHub sign-in, so it cannot read the issue.'],
    [409, 'git worktree add failed: branch already exists', 'The workspace already has a worktree or branch for this issue.'],
    [502, 'GitHub returned 500', 'GitHub did not answer.'],
    [503, 'ssh timed out', 'The workspace machine did not answer.'],
  ]
  it.each(kinds)('draws a %i inside the picker with the daemon words (%s)', async (status, said, sentence) => {
    daemon({ 'POST /api/workspaces/*/threads/new': [status, said] })
    const dialog = await open()
    const list = await within(dialog).findByRole('list', { name: 'Workspaces that hold this repository' })
    fireEvent.click(within(list).getAllByRole('button')[0]!)
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('The session could not be started')
    expect(alert.textContent).toContain(sentence)
    expect(alert.textContent).toContain(said)
    const sign = within(alert).queryByRole('link', { name: 'Sign in' })
    if (said === grant) expect(sign?.getAttribute('href')).toBe('/settings/providers')
    else expect(sign).toBeNull()
  })

  it('says the match is by folder name when the path does not end in owner/repo', async () => {
    daemon()
    const dialog = await open()
    const list = await within(dialog).findByRole('list', { name: 'Workspaces that hold this repository' })
    expect(within(list).getAllByText(/Matched by folder name only/)).toHaveLength(2)
  })

  it('asks the daemon to open the issue on the workspace picked', async () => {
    const asked = daemon({ 'POST /api/workspaces/*/threads/new': [503, 'stop here'] })
    const dialog = await open()
    const list = await within(dialog).findByRole('list', { name: 'Workspaces that hold this repository' })
    fireEvent.click(within(list).getAllByRole('button')[0]!)
    await waitFor(() => expect(asked.some((one) => /^POST \/api\/workspaces\/[^/]+\/threads\/new$/.test(one))).toBe(true))
  })
})

describe('the GitHub queue', () => {
  const items = (heading: string) =>
    within(screen.getByRole('heading', { name: heading }).closest('.github__group') as HTMLElement).getAllByRole('listitem')

  it('lists reviews before issues, each row with the reason it needs you', async () => {
    daemon()
    await renderInApp(<Github attention={attention} />)
    const headings = screen.getAllByRole('heading', { level: 4 }).map((one) => one.textContent)
    expect(headings).toEqual(['Reviews', 'Issues'])
    for (const row of items('Reviews')) expect(within(row).getByText('review requested')).toBeTruthy()
    for (const row of items('Issues')) expect(within(row).getByText('assigned issue')).toBeTruthy()
  })

  it('gives every row one actions slot, the primary action first', async () => {
    daemon()
    await renderInApp(<Github attention={attention} />)
    for (const row of [...items('Reviews'), ...items('Issues')]) {
      expect(row.querySelectorAll('.github__actions')).toHaveLength(1)
    }
    const review = within(items('Reviews')[0]!.querySelector('.github__actions') as HTMLElement)
    expect(review.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(contract.attention.data.reviews[0]!.url)
    expect(review.queryByRole('button', { name: /^Start session/ })).toBeNull()
    const issue = items('Issues')[0]!.querySelector('.github__actions') as HTMLElement
    const [open, start] = Array.from(issue.querySelectorAll('a, button'))
    expect(open!.textContent).toBe('Open')
    expect(start!.textContent).toBe('Start session')
  })

  it('links the count as plain text, "Open N on GitHub"', async () => {
    daemon()
    await renderInApp(<Github attention={attention} />)
    const link = screen.getByRole('link', { name: `Open ${contract.attention.data.notifications} on GitHub` })
    expect(link.getAttribute('href')).toBe('https://github.com/notifications')
  })

  it('draws a skeleton while pending', async () => {
    daemon()
    await renderInApp(<Github attention={{ looked: 'pending' }} />)
    expect(document.querySelector('.github__pending[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Reviews' })).toBeNull()
  })

  it('says GitHub was never looked at', async () => {
    daemon()
    await renderInApp(<Github attention={{ looked: 'never' } as never} />)
    expect(screen.getByText('GitHub not looked at yet')).toBeTruthy()
  })

  it('names the failure and links a missing sign-in to Providers', async () => {
    daemon()
    await renderInApp(
      <Github attention={{ looked: 'failed', age_seconds: 0, error: 'no GitHub grant — run `yantra github login`' }} />,
    )
    expect(screen.getByText('GitHub is not signed in')).toBeTruthy()
    expect(screen.getByText('Sign in to see the reviews and issues that wait on you.')).toBeTruthy()
    // Y-743: the daemon's CLI hint is for a shell, not for this card.
    expect(screen.queryByText(/yantra github login/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/settings/providers')
  })

  it('shows any other reason as said, with its commands drawn as code and no backticks', async () => {
    daemon()
    await renderInApp(
      <Github attention={{ looked: 'failed', age_seconds: 0, error: 'GitHub answered 502 — run `yantra doctor`' }} />,
    )
    expect(screen.getByText('GitHub could not be read')).toBeTruthy()
    const code = screen.getByText('yantra doctor')
    expect(code.tagName).toBe('CODE')
    expect(code.closest('p')?.textContent).toBe('GitHub answered 502 — run yantra doctor')
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByText('The last GitHub read failed')).toBeNull()
  })

  /** Y-745: the daemon kept the reading through one failed read, so the items stay. */
  it('keeps the items of a reading whose last read failed, and says how old it is and why', async () => {
    daemon()
    await renderInApp(<Github attention={{ ...contract.attentionRetrying, age_seconds: 372 }} />)
    expect(items('Reviews')).toHaveLength(contract.attentionRetrying.data.reviews.length)
    expect(items('Issues')).toHaveLength(contract.attentionRetrying.data.issues.length)
    // Only the first line is announced: the age under it changes on every poll.
    expect(screen.getByRole('status').textContent).toBe('The last GitHub read failed')
    expect(screen.getByText(/^Showing what it said/).textContent).toBe(
      `Showing what it said 6m ago · ${contract.attentionRetrying.retrying}`,
    )
    expect(screen.queryByText('GitHub could not be read')).toBeNull()
  })

  it('draws no such note on a fresh reading', async () => {
    daemon()
    await renderInApp(<Github attention={attention} />)
    expect(items('Reviews').length).toBeGreaterThan(0)
    expect(screen.queryByText('The last GitHub read failed')).toBeNull()
    expect(screen.queryByText(/^Showing what it said/)).toBeNull()
  })
})
