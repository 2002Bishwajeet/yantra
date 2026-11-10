import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { aListed, aMachine, aWorkspace, looked } from '@/api/fixtures'
import type { Readiness } from '@/api'
import { writePrefs } from '@/shell/prefs'
import { READY } from '@/lib/ready'
import { type Answer, type Answers, HOME, listing, mountNew, resize, unmountNew } from './harness'

afterEach(() => {
  cleanup()
  unmountNew()
  writePrefs({ general: {} })
})

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

/** Steps 1 and 2 of the walk: a machine, GitHub, and the repository that is
 *  already on it. */
async function toStepThree(answers: Answers = {}) {
  const asked = mountNew('desktop', '/new', answers)
  await screen.findByRole('dialog', { name: 'New session' })
  type('Name', 'quiet-otter')
  press('cachyos-g14')
  press('Continue')
  await screen.findByText('On this machine')
  press(/2002Bishwajeet\/yantra/)
  press('Continue')
  await screen.findByText('What opens in the session')
  return asked
}

describe('step 1, the name and the machine', () => {
  it('offers a generated pair, another one on request, and refuses what the daemon would', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    const field = screen.getByLabelText('Name') as HTMLInputElement
    expect(field.value).toMatch(/^[a-z]+-[a-z]+$/)

    press('Another name')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toMatch(/^[a-z]+-[a-z]+$/)

    type('Name', 'quiet otter')
    expect(await screen.findByText(/letters, digits/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  it('names three steps, one per screen', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    const steps = () => within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    const states = () => steps().map((one) => one.getAttribute('data-state'))
    expect(steps().map((one) => one.textContent)).toEqual(['1Name', '2Source', '3Start'])
    expect(steps()[0].getAttribute('aria-current')).toBe('step')
    expect(states()).toEqual(['current', 'ahead', 'ahead'])

    type('Name', 'quiet-otter')
    press('cachyos-g14')
    press('Continue')
    await screen.findByText('On this machine')
    expect(states()).toEqual(['done', 'current', 'ahead'])

    press(/2002Bishwajeet\/yantra/)
    press('Continue')
    await screen.findByText('What opens in the session')
    expect(states()).toEqual(['done', 'done', 'current'])
  })

  it('offers no chip for a node that runs no session, and ignores a preset naming one', async () => {
    const nodes = [
      aMachine({ name: 'an-iphone', os: 'iOS' }),
      aMachine({ name: 'a-pixel', os: 'android' }),
      aMachine({ name: 'a-desktop', os: 'windows' }),
    ]
    mountNew('desktop', '/new?machine=an-iphone', {
      'GET /api/machines': [
        200,
        {
          ...contract.machines,
          data: [...contract.machines.data.map((one) => ({ ...one, hub: false })), ...nodes],
        },
      ],
    })
    await screen.findByRole('dialog', { name: 'New session' })
    const chips = within(screen.getByRole('group', { name: 'Machine' }))
    expect(chips.getByRole('button', { name: 'cachyos-g14' })).toBeTruthy()
    for (const node of nodes) expect(chips.queryByRole('button', { name: new RegExp(node.name) })).toBeNull()
    // The preset names a node that is not offered, so it selects nothing.
    expect(chips.queryByRole('button', { pressed: true, name: /an-iphone/ })).toBeNull()
  })

  it('takes one machine, and never one that is not there', async () => {
    mountNew('desktop', '/new', { 'POST /api/placement': [200, { ranked: [], rejected: [] }] })
    await screen.findByRole('dialog', { name: 'New session' })
    const chips = within(screen.getByRole('group', { name: 'Machine' }))
    expect(chips.getByRole('button', { name: 'bishwajeets-macbook-pro · unreachable' })).toHaveProperty(
      'disabled',
      true,
    )
    // Nothing is chosen until one is, so Continue waits.
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
    fireEvent.click(chips.getByRole('button', { name: 'cachyos-g14' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
  })

  it('says so when the machines cannot be read', async () => {
    mountNew('desktop', '/new', {
      'GET /api/machines': [200, { looked: 'failed', age_seconds: 0, error: 'tailscale: not running' }],
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Machines could not be read')
    expect(alert.textContent).toContain('tailscale: not running')
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('step 2, where the code comes from', () => {
  it('joins the swept list to the machine, and searching narrows it in the browser', async () => {
    const asked = mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')

    const rows = within(await screen.findByRole('list', { name: 'Repositories' }))
    await waitFor(() => expect(rows.getByText('On this machine')).toBeTruthy())
    expect(rows.getByText('Will clone')).toBeTruthy()
    expect(rows.queryByText(/~\/Github/)).toBeNull()
    // One listing of the clone home, not a probe per row.
    expect(asked.filter((one) => one.endsWith('/probe'))).toHaveLength(0)

    type('Search your repositories', 'scratch')
    await waitFor(() => expect(rows.queryByText(/2002Bishwajeet\/yantra/)).toBeNull())
    type('Search your repositories', 'zzz')
    expect(await screen.findByText('nothing matches zzz')).toBeTruthy()
  })

  it('a machine that cannot be listed leaves the rows unchecked rather than absent', async () => {
    mountNew('desktop', '/new', {
      'POST /api/machines/cachyos-g14/dirs': (sent) =>
        sent.path === undefined
          ? [200, listing(HOME)]
          : [503, 'ssh: connect to host cachyos-g14 port 22: No route to host'],
    })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    const rows = within(await screen.findByRole('list', { name: 'Repositories' }))
    await waitFor(() => expect(rows.getAllByText('Not checked')).toHaveLength(2))
    // Unchecked still goes on: only a proven absence blocks (D4 §5).
    fireEvent.click(rows.getByRole('button', { name: /2002Bishwajeet\/yantra/ }))
    expect(screen.getByRole('status').textContent).toBe('Not checked. Will try ~/Github/yantra')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
  })

  it('says why Continue is off, and what selecting a row will do', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    const rows = within(await screen.findByRole('list', { name: 'Repositories' }))
    await waitFor(() => expect(rows.getByText('Will clone')).toBeTruthy())
    const hint = screen.getByRole('status')
    expect(hint.textContent).toBe('Choose a repository to continue.')
    const next = screen.getByRole('button', { name: 'Continue' })
    expect(next).toHaveProperty('disabled', true)
    expect(next.getAttribute('aria-describedby')).toBe(hint.id)

    fireEvent.click(rows.getByRole('button', { name: /2002Bishwajeet\/scratch/ }))
    expect(screen.getByRole('status').textContent).toBe('Will clone into ~/Github/scratch')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Continue' }).getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(rows.getByRole('button', { name: /2002Bishwajeet\/yantra/ }))
    expect(screen.getByRole('status').textContent).toBe('On cachyos-g14 at ~/Github/yantra')
  })

  it('points a folder a workspace already works in at that workspace chat', async () => {
    const mine = aListed(aWorkspace({ name: 'yantra', machine: 'cachyos-g14', repo: `${HOME}/Github/yantra` }))
    mountNew('desktop', '/new', { 'GET /api/workspaces': [200, looked.ok([mine])] })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    const rows = within(await screen.findByRole('list', { name: 'Repositories' }))
    fireEvent.click(await rows.findByRole('button', { name: /2002Bishwajeet\/scratch/ }))
    expect(screen.queryByText(/already works in this folder/)).toBeNull()
    fireEvent.click(rows.getByRole('button', { name: /2002Bishwajeet\/yantra/ }))
    expect(await screen.findByText('yantra already works in this folder. Start a thread in its chat.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open yantra' }).getAttribute('href')).toBe('/w/yantra?view=chat')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
  })

  it('sends nobody to GitHub without a grant, and draws GitLab as later', async () => {
    mountNew('desktop', '/new', { 'GET /api/github': [200, contract.disconnected] })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    expect(await screen.findByText('GitHub is not signed in')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in in Settings' }).getAttribute('href')).toBe(
      '/settings/providers',
    )
    expect(screen.getByRole('button', { name: /GitLab/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  it('says GitHub refused the grant, and lists nothing, when the readiness is absent', async () => {
    mountNew('desktop', '/new', { 'GET /api/readiness/github': [200, contract.githubRefused] })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    expect(await screen.findByText('GitHub refused the grant')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in again in Settings' }).getAttribute('href')).toBe(
      '/settings/providers',
    )
    expect(screen.queryByText(/private repositories included/)).toBeNull()
    expect(screen.queryByRole('list', { name: 'Repositories' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  it('keeps the list, without the private claim, while GitHub has not been asked', async () => {
    mountNew('desktop', '/new', {
      'GET /api/readiness/github': [200, { looked: 'failed', age_seconds: 0, error: 'timeout' }],
    })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    expect(await screen.findByRole('list', { name: 'Repositories' })).toBeTruthy()
    expect(screen.getByText(/GitHub not asked yet/)).toBeTruthy()
    expect(screen.queryByText(/private repositories included/)).toBeNull()
  })

  it('still says private repositories are included for an accepted grant', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    expect(await screen.findByText(/private repositories included/)).toBeTruthy()
  })

  it('does not tell anyone to choose from a list that failed to load', async () => {
    mountNew('desktop', '/new', {
      'GET /api/repos': [200, { looked: 'failed', age_seconds: 0, error: 'rate limited' }],
    })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    expect(await screen.findByText('The repositories could not be read.')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  /** Y-629: an organisation whose repositories the grant cannot see is named. */
  async function toRepos(answers: Answers) {
    const asked = mountNew('desktop', '/new', answers)
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('list', { name: 'Repositories' })
    await waitFor(() => expect(asked).toContain('GET /api/repos/hidden'))
  }

  it('names the organisations it sees no repository from, and links the grant page', async () => {
    await toRepos({
      'GET /api/github': [200, { ...contract.github, client_id: 'Iv1.abc123' }],
      'GET /api/repos/hidden': [200, { ...contract.hiddenOrgs, data: ['acme-corp', 'utopia-php'] }],
    })
    expect(
      await screen.findByText(
        'Yantra sees no repository from acme-corp, utopia-php. An organisation that restricts OAuth apps hides them. If your membership in one is private, it is not in this list.',
      ),
    ).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Grant access on GitHub' })
    expect(link.getAttribute('href')).toBe('https://github.com/settings/connections/applications/Iv1.abc123')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('links every authorised app when the client id is unknown', async () => {
    await toRepos({
      'GET /api/github': [200, { ...contract.github, client_id: null }],
      'GET /api/repos/hidden': [200, contract.hiddenOrgs],
    })
    expect((await screen.findByRole('link', { name: 'Grant access on GitHub' })).getAttribute('href')).toBe(
      'https://github.com/settings/applications',
    )
  })

  it('still links the grant page when it can name no organisation', async () => {
    await toRepos({ 'GET /api/repos/hidden': [200, { ...contract.hiddenOrgs, data: [] }] })
    expect(await screen.findByText(/If your membership there is private, Yantra cannot name it\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Grant access on GitHub' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /2002Bishwajeet\/yantra/ })).toBeTruthy()
  })

  it.each<[string, Answer]>([
    ['failed', [200, { looked: 'failed', age_seconds: 0, error: 'GitHub answered 502 to /user/orgs' }]],
    ['never', [200, { looked: 'never' }]],
    ['refused', [500, 'boom']],
  ])('keeps the rows and the grant link, with no note, when the hidden read is %s', async (_, reply) => {
    await toRepos({
      'GET /api/github': [200, { ...contract.github, client_id: 'Iv1.abc123' }],
      'GET /api/repos/hidden': reply,
    })
    expect(screen.getByRole('button', { name: /2002Bishwajeet\/yantra/ })).toBeTruthy()
    // The answer has arrived; give it the frame it needs to draw anything.
    await new Promise((done) => setTimeout(done, 50))
    expect(screen.queryByText(/restricts OAuth apps/)).toBeNull()
    expect(screen.queryByText(/private, Yantra cannot name it|it is not in this list/)).toBeNull()
    const link = await screen.findByRole('link', { name: 'Grant access on GitHub' })
    await waitFor(() =>
      expect(link.getAttribute('href')).toBe('https://github.com/settings/connections/applications/Iv1.abc123'),
    )
  })

  it('browses the machine, and makes a folder where there is none', async () => {
    const made = { ...listing(`${HOME}/Github`), entries: [] as unknown[] }
    const asked = mountNew('desktop', '/new', {
      'POST /api/machines/cachyos-g14/dirs': (sent) =>
        sent.make === undefined ? [200, listing(String(sent.path ?? HOME))] : [200, made],
    })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('button', { name: /Local directory/ })
    press(/Local directory/)

    const folders = within(await screen.findByRole('list', { name: 'Folders' }))
    fireEvent.click(folders.getByRole('button', { name: /^Github/ }))
    await screen.findByText(/2002Bishwajeet\/yantra/)

    type('New folder', 'landing')
    press('Make')
    await waitFor(() =>
      expect(asked).toContain('POST /api/machines/cachyos-g14/dirs'),
    )
    // The folder just made is where the session will run.
    await waitFor(() => expect(screen.getByText('~/Github/landing')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
  })
})

/** Y-414: the whole filesystem, one level at a time. */
describe('step 2, the local browser', () => {
  async function toLocal(answers: Answers = {}) {
    const sent: unknown[] = []
    const asked = mountNew('desktop', '/new', {
      'POST /api/machines/cachyos-g14/dirs': (body) => {
        sent.push(body.path)
        return [200, listing(String(body.path ?? HOME))]
      },
      ...answers,
    })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('button', { name: /Local directory/ })
    press(/Local directory/)
    // Not awaited: a refused listing draws no list.
    const folders = within(document.body)
    return { asked, sent, folders }
  }

  it('hides dotfiles until asked, then lists them', async () => {
    const { folders } = await toLocal()
    await folders.findByText('Github')
    expect(folders.queryByText('.config')).toBeNull()

    const toggle = screen.getByRole('button', { name: 'Show hidden' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(await folders.findByRole('button', { name: /^\.config/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }))
    await waitFor(() => expect(folders.queryByText('.config')).toBeNull())
  })

  it('draws closed folders, marked, and no files', async () => {
    const { folders, sent } = await toLocal()
    const closed = await folders.findByText('private')
    expect(folders.queryByText('todo.txt')).toBeNull()
    expect(folders.getByText('no access')).toBeTruthy()
    expect(closed.closest('button')).toBeNull()
    expect(folders.queryByRole('button', { name: /^private/ })).toBeNull()

    const before = sent.length
    fireEvent.click(closed)
    // Nothing was asked and nothing was chosen.
    expect(sent).toHaveLength(before)
    expect(document.querySelector('.ns__chosen')).toBeNull()
  })

  it('says "no folders here" when a folder holds files and no folders', async () => {
    const only = { ...listing(`${HOME}/Github`), entries: [{ path: `${HOME}/Github/README.md`, name: 'README.md', kind: 'file', access: true, repo: false, origin: null }] }
    const { folders } = await toLocal({
      'POST /api/machines/cachyos-g14/dirs': (body) => [200, body.path === `${HOME}/Github` ? only : listing(String(body.path ?? HOME))],
    })
    fireEvent.click(await folders.findByRole('button', { name: /^Github/ }))
    expect(await folders.findByText('no folders here')).toBeTruthy()
    expect(folders.queryByText('README.md')).toBeNull()
  })

  it('chooses nothing until the person walks or presses Use', async () => {
    const { folders } = await toLocal()
    await folders.findByRole('button', { name: /^Github/ })
    expect(document.querySelector('.ns__chosen')).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: 'Use ~' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false))
    expect(document.querySelector('.ns__chosen')?.textContent).toContain('~')
  })

  it('chooses a folder by walking into it', async () => {
    const { folders } = await toLocal()
    fireEvent.click(await folders.findByRole('button', { name: /^Github/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false))
    expect(document.querySelector('.ns__chosen')?.textContent).toContain('~/Github')
  })

  it('writes the missing line and the new-folder hint with ~', async () => {
    const { folders } = await toLocal({
      'POST /api/machines/cachyos-g14/probe': [200, { machine: 'cachyos-g14', path: `${HOME}/Github/nope`, exists: false, origin: null }],
    })
    await folders.findByRole('button', { name: /^Github/ })
    expect(screen.getByText('under ~/')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit path' }))
    const field = screen.getByLabelText('Path')
    fireEvent.change(field, { target: { value: '~/Github/nope' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText(/has no directory at ~\/Github\/nope\./)).toBeTruthy()
  })

  it('walks above $HOME to / and into another folder there', async () => {
    const { folders, sent } = await toLocal()
    await folders.findByText('Github')
    const where = within(screen.getByRole('navigation', { name: 'Where you are' }))
    expect(where.getAllByRole('button').map((one) => one.textContent)).toEqual(['/', 'home'])

    fireEvent.click(where.getByRole('button', { name: '/' }))
    await folders.findByRole('button', { name: /^srv/ })
    expect(sent).toContain('/')
    expect(folders.getByText('root').closest('button')).toBeNull()

    fireEvent.click(folders.getByRole('button', { name: /^srv/ }))
    await waitFor(() => expect(sent).toContain('/srv'))
  })

  it('says when the list was cut, and when this account cannot read a folder', async () => {
    const { folders } = await toLocal({
      'POST /api/machines/cachyos-g14/dirs': (body) =>
        body.path === '/srv'
          ? [200, { machine: 'cachyos-g14', path: '/srv', access: false, entries: [], truncated: false }]
          : body.path === '/'
            ? [200, listing('/')]
            : [200, { ...listing(HOME), truncated: true }],
    })
    expect(await folders.findByText(/sent the first 4 entries and stopped.*Edit path, or press \//)).toBeTruthy()

    const where = within(screen.getByRole('navigation', { name: 'Where you are' }))
    fireEvent.click(where.getByRole('button', { name: '/' }))
    fireEvent.click(await folders.findByRole('button', { name: /^srv/ }))
    expect(await folders.findByText('cachyos-g14 does not let this account read this folder.')).toBeTruthy()
    expect(folders.queryByText(/Remote Login/)).toBeNull()
    expect(folders.queryByText('this folder is empty')).toBeNull()
  })

  it('a folder that is not there, and a machine that cannot be asked, are two errors', async () => {
    const refusal = (status: number, said: string): Answers => ({
      'POST /api/machines/cachyos-g14/dirs': [status, said],
    })
    await toLocal(refusal(409, 'cachyos-g14 has no directory at /home/biswa'))
    expect(await screen.findByText('cachyos-g14 has no directory there')).toBeTruthy()
    cleanup()
    unmountNew()

    await toLocal(refusal(503, 'ssh: connect to host cachyos-g14 port 22: No route to host'))
    expect(await screen.findByText('cachyos-g14 could not be asked what is there')).toBeTruthy()
    expect(screen.getByText(/No route to host/)).toBeTruthy()
  })
})

describe('step 3, what opens in the session', () => {
  it('starts Claude unless a command is typed, and says what will happen', async () => {
    await toStepThree()
    expect(screen.getByRole('heading', { name: 'When you press Create and open' })).toBeTruthy()
    expect(screen.getByText(/^It opens a session in/)).toBeTruthy()
    expect(screen.getByText(/Claude starts there/)).toBeTruthy()

    press(/Your command/)
    expect(screen.getByRole('button', { name: 'Create and open' })).toHaveProperty('disabled', true)
    type('Command', 'just dev')
    await waitFor(() => expect(screen.getByText(/^just dev runs there/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Create and open' })).toHaveProperty('disabled', false)
  })

  it('heads the dialog with the machine and the folder as the list draws it', async () => {
    await toStepThree()
    const description = screen.getByRole('dialog').getAttribute('aria-describedby')
    const text = document.getElementById(description ?? '')?.textContent ?? ''
    expect(text).toBe('on cachyos-g14 · ~/Github/yantra')
    expect(text).not.toContain('/home/biswa')
  })

  it('offers two options and no placeholder for another agent', async () => {
    await toStepThree()
    const group = screen.getByRole('group', { name: 'What opens in the session' })
    expect(within(group).getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByText('Another agent')).toBeNull()
  })
})

describe('step 4, starting', () => {
  it('creates the workspace, opens the session, and goes to the chat', async () => {
    const asked = await toStepThree({
      'POST /api/workspaces': (sent) => [201, { ...sent, startup: sent.startup ?? null }],
      'POST /api/workspaces/quiet-otter/up': [200, contract.opened],
    })
    press('Create and open')

    expect(await screen.findByText('Starting quiet-otter')).toBeTruthy()
    await waitFor(() => expect(asked).toContain('POST /api/workspaces'))
    await waitFor(() => expect(asked).toContain('POST /api/workspaces/quiet-otter/up'))
    // Nothing was cloned: the repository was already on the machine.
    expect(asked.some((one) => one.endsWith('/clone'))).toBe(false)
    await waitFor(() => expect(window.location.pathname).toBe('/w/quiet-otter'))
  })

  it('does not run twice when the form factor changes during the run (Y-361)', async () => {
    const create = vi.fn((sent: Record<string, unknown>) => [201, { ...sent, startup: null }] as [number, unknown])
    const asked = await toStepThree({
      'POST /api/workspaces': create,
      'POST /api/workspaces/quiet-otter/up': [200, contract.opened],
    })
    press('Create and open')
    expect(await screen.findByText('Starting quiet-otter')).toBeTruthy()

    resize('tablet')
    expect(screen.getByRole('dialog')).toBeTruthy()
    resize('phone')
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(asked).toContain('POST /api/workspaces/quiet-otter/up'))
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/refused/)).toBeNull()
  })

  /** 4.1.3: the four stages advance on a poll with no navigation, so the track
   *  over them is a live region and it says which stage is which. */
  it('draws a progress track that says what the stages are doing', async () => {
    await toStepThree({
      'POST /api/workspaces': (sent) => [201, { ...sent, startup: sent.startup ?? null }],
      'POST /api/workspaces/quiet-otter/up': [200, contract.opened],
    })
    press('Create and open')

    const track = await screen.findByRole('progressbar')
    expect(track.closest('[role="status"]')).not.toBeNull()
    // The clone was skipped, so one of the four is behind it before anything ran.
    await waitFor(() => expect(Number(track.getAttribute('aria-valuenow'))).toBeGreaterThan(0))
  })

  it('draws a refusal in the daemon’s own words, and offers the stage again', async () => {
    const create = vi.fn(() => [409, 'workspace `quiet-otter` already exists'] as [number, unknown])
    await toStepThree({ 'POST /api/workspaces': create })
    press('Create and open')

    expect(await screen.findByText('workspace `quiet-otter` already exists')).toBeTruthy()
    expect(screen.getByText(/Creating workspace quiet-otter was refused/)).toBeTruthy()
    press('Try again')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
  })
})

/** Y-631: a Mac with no login tmux server refuses the session, and the screen
 *  says why in full and offers the Terminal command. */
describe('a Mac with no login tmux server (Y-631)', () => {
  const UP_SAID =
    '`cachyos-g14` runs macOS and has no tmux server, and Yantra will not start one there: panes in a server started over ssh cannot read the login keychain, so the agent would come up unauthenticated. Start one from a login session on that machine — in Terminal: `tmux new-session -d`'
  const DOCTOR_SAID =
    'no tmux server from a login session is running on this Mac, and Yantra will not start one, because panes in a server started over ssh cannot read the login keychain. Start one in Terminal there: `tmux new-session -d`'
  const MAC = 'bishwajeets-macbook-pro'
  const writeText = vi.fn<(text: string) => Promise<void>>()
  const stubClipboard = (clipboard: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  afterEach(() => {
    writeText.mockReset()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  const refuse = (status = 409, said = UP_SAID) => ({
    'POST /api/workspaces': (sent: Record<string, unknown>): [number, unknown] => [201, { ...sent, startup: null }],
    'POST /api/workspaces/quiet-otter/up': [status, said] as [number, unknown],
  })

  it('shows the whole sentence, and a Copy button that copies the command', async () => {
    writeText.mockResolvedValue()
    stubClipboard({ writeText })
    await toStepThree(refuse())
    press('Create and open')

    expect(await screen.findByText(UP_SAID)).toBeTruthy()
    expect(screen.getByText(/In Terminal on cachyos-g14, run this, then Try again/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    press(/Copy the Terminal command/)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('tmux -L yantra new-session -d'))
    expect(await screen.findByRole('button', { name: /Copied the Terminal command/ })).toBeTruthy()
  })

  it('selects the command and says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    stubClipboard({ writeText })
    await toStepThree(refuse())
    press('Create and open')
    await screen.findByText(UP_SAID)
    press(/Copy the Terminal command/)
    expect(await screen.findByText(/this page has no clipboard/)).toBeTruthy()
  })

  it('offers no command for a refusal that is not this one', async () => {
    await toStepThree(refuse(409, 'workspace `quiet-otter` opens at `/x`, and `cachyos-g14` has no such directory'))
    press('Create and open')
    await screen.findByText(/has no such directory/)
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
  })

  const withMac = (checks: { check: string; state: string; detail: string }[] | 'failed'): Answers => ({
    'GET /api/machines': [
      200,
      {
        ...contract.machines,
        data: contract.machines.data.map((one) =>
          one.name === MAC ? { ...one, online: true, os: 'macOS', hub: false } : { ...one, hub: false },
        ),
      },
    ],
    'GET /api/readiness': [
      200,
      checks === 'failed'
        ? { looked: 'failed', age_seconds: 0, error: 'ssh: nothing' }
        : { looked: 'ok', age_seconds: 0, data: [{ machine: MAC, age_seconds: 0, checks }] },
    ],
  })
  const noServer = [
    { check: 'login-session', state: 'absent', detail: DOCTOR_SAID },
    { check: 'tmux', state: 'present', detail: '' },
  ]

  it('warns on the Machine step, with the command, when the chosen Mac has no login server', async () => {
    mountNew('desktop', '/new', withMac(noServer))
    await screen.findByRole('dialog', { name: 'New session' })
    press(MAC)
    expect(await screen.findByText(/has no tmux server from a login session, so a session cannot start there yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Copy the Terminal command/ })).toBeTruthy()
  })

  it('warns of nothing for a ready Linux machine', async () => {
    mountNew('desktop', '/new', withMac(noServer))
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    await waitFor(() => expect(screen.getByRole('button', { name: 'cachyos-g14', pressed: true })).toBeTruthy())
    expect(screen.queryByText(/cannot start there yet/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
  })

  it('warns of nothing when the readiness sweep failed, because unknown is not absent', async () => {
    mountNew('desktop', '/new', withMac('failed'))
    await screen.findByRole('dialog', { name: 'New session' })
    press(MAC)
    await waitFor(() => expect(screen.getByRole('button', { name: MAC, pressed: true })).toBeTruthy())
    expect(screen.queryByText(/cannot start there yet/)).toBeNull()
  })
})

describe('the modal and the page', () => {
  it.each(['desktop', 'tablet'] as const)('draws a dialog named New session on a %s', async (size) => {
    mountNew(size, '/new')
    const dialog = await screen.findByRole('dialog', { name: 'New session' })
    expect(within(dialog).getByRole('heading', { level: 2, name: 'New session' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'New session' })).toBeNull()
  })

  it('draws a page with an h1 and no dialog on a phone', async () => {
    mountNew('phone', '/new')
    expect(await screen.findAllByRole('heading', { level: 1, name: 'New session' })).not.toHaveLength(0)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('goes back to the dashboard from the close button', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    press('Close')
    await waitFor(() => expect(location.pathname).toBe('/'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('goes back to the dashboard on Escape', async () => {
    mountNew('desktop', '/new')
    const dialog = await screen.findByRole('dialog', { name: 'New session' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(location.pathname).toBe('/'))
  })

  it('goes back to the dashboard from Cancel', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    fireEvent.click(screen.getByRole('link', { name: 'Cancel' }))
    await waitFor(() => expect(location.pathname).toBe('/'))
  })

  it('keeps the form when the scrim is clicked', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    const scrim = document.querySelector('.m3-scrim')!
    fireEvent.pointerDown(scrim, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseDown(scrim, { button: 0 })
    fireEvent.pointerUp(scrim, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseUp(scrim, { button: 0 })
    fireEvent.click(scrim)
    await new Promise((done) => setTimeout(done, 50))
    expect(location.pathname).toBe('/new')
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy()
  })

  it('heads step 2 with the tile, the name and the machine', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    type('Name', 'quiet-otter')
    press('cachyos-g14')
    press('Continue')
    const dialog = await screen.findByRole('dialog', { name: 'quiet-otter' })
    expect(within(dialog).getByRole('heading', { level: 2, name: 'quiet-otter' })).toBeTruthy()
    expect(dialog.querySelector('.ns-dialog__tile')).toBeTruthy()
    expect(within(dialog).getByText('on cachyos-g14')).toBeTruthy()
  })
})

describe('the default machine', () => {
  const pressed = () =>
    within(screen.getByRole('group', { name: 'Machine' }))
      .getAllByRole('button')
      .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
  const stays = async () => {
    await screen.findByRole('group', { name: 'Machine' })
    expect(pressed()).toHaveLength(0)
    type('Name', 'quiet-otter')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  }

  it('presses a reachable default once the list arrives, and Continue enables with a name', async () => {
    writePrefs({ general: { defaultMachine: 'cachyos-g14' } })
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    await waitFor(() => expect(pressed().map((chip) => chip.textContent)).toEqual(['cachyos-g14']))
    type('Name', 'quiet-otter')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false))
  })

  it('selects no machine when there is no default and nothing is suggested', async () => {
    mountNew('desktop', '/new', { 'POST /api/placement': [200, { ranked: [], rejected: [] }] })
    await stays()
  })

  it('does not select a default that is offline', async () => {
    writePrefs({ general: { defaultMachine: 'bishwajeets-macbook-pro' } })
    mountNew('desktop', '/new', { 'POST /api/placement': [200, { ranked: [], rejected: [] }] })
    await stays()
  })

  it('does not select a default the list does not hold', async () => {
    writePrefs({ general: { defaultMachine: 'gone' } })
    mountNew('desktop', '/new', { 'POST /api/placement': [200, { ranked: [], rejected: [] }] })
    await stays()
  })

  it('yields to ?machine=', async () => {
    writePrefs({ general: { defaultMachine: 'pi' } })
    mountNew('desktop', '/new?machine=cachyos-g14')
    await screen.findByRole('dialog', { name: 'New session' })
    await waitFor(() => expect(pressed().map((chip) => chip.textContent)).toEqual(['cachyos-g14']))
  })

  it('does not press a ?machine= that is unreachable', async () => {
    mountNew('desktop', '/new?machine=bishwajeets-macbook-pro', { 'POST /api/placement': [200, { ranked: [], rejected: [] }] })
    await stays()
  })

  it('does not overwrite a machine picked before the list was read again', async () => {
    writePrefs({ general: { defaultMachine: 'cachyos-g14' } })
    mountNew('desktop', '/new')
    await waitFor(() => expect(pressed()).toHaveLength(1))
    press('pi')
    await waitFor(() => expect(pressed().map((chip) => chip.textContent)).toEqual(['pi']))
  })

  it('selects nothing and shows the error when the machines cannot be read', async () => {
    writePrefs({ general: { defaultMachine: 'cachyos-g14' } })
    mountNew('desktop', '/new', {
      'GET /api/machines': [200, { looked: 'failed', age_seconds: 0, error: 'tailscale: not running' }],
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Machines could not be read')
    expect(screen.queryByRole('group', { name: 'Machine' })).toBeNull()
    type('Name', 'quiet-otter')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  it('chooses no machine when the general pref is corrupt and nothing is suggested', async () => {
    writePrefs({ general: { defaultMachine: 42 } })
    mountNew('desktop', '/new', { 'POST /api/placement': [200, { ranked: [], rejected: [] }] })
    await stays()
  })
})

describe('the suggested machine (Y-517)', () => {
  const pressed = () =>
    within(screen.getByRole('group', { name: 'Machine' }))
      .getAllByRole('button')
      .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
      .map((chip) => chip.textContent)
  const terms = { ram: 20, cpu: 15, power: 10, repo: 0, affinity: 0 }
  const placed = (machine: string, score: number, reason: string, path?: string) => ({
    machine,
    score,
    terms,
    reason,
    ...(path ? { path } : {}),
  })
  // Every placed machine is checked ready, so the plain Y-517 words hold.
  const readyReport = (machine: string, ok = true) => ({
    machine,
    age_seconds: 0,
    checks: READY.map((check) => ({ check, state: ok ? 'present' : 'absent', detail: '' })),
  })
  const ranked = (...machines: ReturnType<typeof placed>[]): Answers => ({
    'POST /api/placement': [200, { ranked: machines, rejected: [] }],
    'GET /api/readiness': [
      200,
      { looked: 'ok', age_seconds: 0, data: machines.map((one) => readyReport(one.machine)) },
    ],
  })

  it('preselects the top machine and says why, and Continue enables with a name', async () => {
    mountNew('desktop', '/new', ranked(placed('pi', 45, 'it is idle and it has RAM to spare'), placed('cachyos-g14', 20, 'x')))
    await waitFor(() => expect(pressed()).toEqual(['pi']))
    expect(screen.getByRole('status').textContent).toBe('Suggested: pi, because it is idle and it has RAM to spare')
    type('Name', 'quiet-otter')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
  })

  it('says the top machine is not checked yet when the sweep has no report for it', async () => {
    mountNew('desktop', '/new', {
      ...ranked(placed('pi', 45, 'it is idle')),
      'GET /api/readiness': [200, { looked: 'ok', age_seconds: 0, data: [] }],
    })
    await waitFor(() => expect(pressed()).toEqual(['pi']))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Suggested: pi, because it is idle · not checked yet'))
  })

  it('says the top machine is not ready yet when its report is not ready', async () => {
    mountNew('desktop', '/new', {
      ...ranked(placed('pi', 45, 'it is idle')),
      'GET /api/readiness': [200, { looked: 'ok', age_seconds: 0, data: [readyReport('pi', false)] }],
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Suggested: pi, because it is idle · not ready yet'))
  })

  it('keeps the plain words while the sweep has not been read', async () => {
    mountNew('desktop', '/new', {
      ...ranked(placed('pi', 45, 'it is idle')),
      'GET /api/readiness': [200, { looked: 'failed', age_seconds: 0, error: 'ssh: nothing' }],
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Suggested: pi, because it is idle'))
  })

  it('takes the first of a tie, which the daemon sorts by name', async () => {
    mountNew('desktop', '/new', ranked(placed('cachyos-g14', 30, 'it is idle'), placed('pi', 30, 'it is idle')))
    await waitFor(() => expect(pressed()).toEqual(['cachyos-g14']))
  })

  it('does not preselect a machine whose chip cannot be pressed', async () => {
    mountNew('desktop', '/new', ranked(placed('bishwajeets-macbook-pro', 45, 'it is idle')))
    expect(await screen.findByText('Suggested: bishwajeets-macbook-pro, because it is idle')).toBeTruthy()
    expect(pressed()).toEqual([])
  })

  it('preselects nothing when no machine reports a heartbeat', async () => {
    mountNew('desktop', '/new', {
      'POST /api/placement': [
        200,
        { ranked: [], rejected: [{ machine: 'bishwajeets-macbook-pro', why: 'asleep_or_off' }] },
      ],
    })
    expect(await screen.findByText('No machine reports a heartbeat, so none is suggested.')).toBeTruthy()
    expect(pressed()).toEqual([])
  })

  it('yields to ?machine= and to a default machine', async () => {
    mountNew('desktop', '/new?machine=pi', ranked(placed('cachyos-g14', 45, 'it is idle')))
    await waitFor(() => expect(pressed()).toEqual(['pi']))
    expect(await screen.findByText('Suggested: cachyos-g14, because it is idle')).toBeTruthy()
    expect(pressed()).toEqual(['pi'])
    cleanup()
    unmountNew()

    writePrefs({ general: { defaultMachine: 'pi' } })
    mountNew('desktop', '/new', ranked(placed('cachyos-g14', 45, 'it is idle')))
    await screen.findByText('Suggested: cachyos-g14, because it is idle')
    await waitFor(() => expect(pressed()).toEqual(['pi']))
  })

  it('fills in for a default machine that cannot be used', async () => {
    writePrefs({ general: { defaultMachine: 'bishwajeets-macbook-pro' } })
    mountNew('desktop', '/new', ranked(placed('pi', 45, 'it is idle')))
    await waitFor(() => expect(pressed()).toEqual(['pi']))
  })

  it('skips a top machine whose chip cannot be pressed, and names the one it picks', async () => {
    mountNew('desktop', '/new', ranked(placed('bishwajeets-macbook-pro', 60, 'it is idle'), placed('pi', 45, 'it has RAM to spare')))
    await waitFor(() => expect(pressed()).toEqual(['pi']))
    expect(screen.getByRole('status').textContent).toBe('Suggested: pi, because it has RAM to spare')
  })

  it('never overwrites a pick made by hand', async () => {
    mountNew('desktop', '/new', ranked(placed('cachyos-g14', 45, 'it is idle')))
    await screen.findByRole('group', { name: 'Machine' })
    press('pi')
    await screen.findByText('Suggested: cachyos-g14, because it is idle')
    expect(pressed()).toEqual(['pi'])
  })

  it('a failed ask says so, can be asked again, and the chips still work', async () => {
    let calls = 0
    const asked = mountNew('desktop', '/new', {
      'POST /api/placement': () => {
        calls += 1
        return calls === 1 ? [503, 'yantrad has not looked at the tailnet yet'] : [200, { ranked: [], rejected: [] }]
      },
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('No machine could be suggested')
    expect(alert.textContent).toContain('yantrad has not looked at the tailnet yet')
    press('cachyos-g14')
    expect(pressed()).toEqual(['cachyos-g14'])
    fireEvent.click(within(alert).getByRole('button', { name: 'Ask again' }))
    expect(await screen.findByText('No machine reports a heartbeat, so none is suggested.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(asked.filter((one) => one === 'POST /api/placement')).toHaveLength(2)
  })

  it('step 2 offers the machine that holds the repo, and switching keeps the repo', async () => {
    const sent: Record<string, unknown>[] = []
    mountNew('desktop', '/new', {
      'POST /api/machines/pi/dirs': (body) => [200, listing(String(body.path ?? HOME))],
      'POST /api/placement': (body) => {
        sent.push(body)
        return body.repo === undefined
          ? [200, { ranked: [placed('cachyos-g14', 45, 'it is idle')], rejected: [] }]
          : [200, { ranked: [placed('pi', 75, 'the repo is there and it is idle', '/srv/yantra'), placed('cachyos-g14', 45, 'it is idle')], rejected: [] }]
      },
    })
    await waitFor(() => expect(pressed()).toEqual(['cachyos-g14']))
    type('Name', 'quiet-otter')
    press('Continue')
    await screen.findByText('On this machine')
    press(/2002Bishwajeet\/yantra/)
    expect(await screen.findByText('pi: the repo is there and it is idle')).toBeTruthy()
    expect(sent.at(-1)).toMatchObject({ repo: '2002Bishwajeet/yantra' })

    press('Use pi')
    const dialog = await screen.findByRole('dialog', { name: 'quiet-otter' })
    await waitFor(() => expect(within(dialog).getByText('on pi')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Use pi' })).toBeNull()
    press('Continue')
    expect(await screen.findByText('on pi · /srv/yantra')).toBeTruthy()
  })
  it.each([
    ['an unreachable machine', [placed('bishwajeets-macbook-pro', 80, 'the repo is there', '/srv/y'), placed('cachyos-g14', 45, 'it is idle')]],
    ['a machine when the chosen one holds the repo', [placed('pi', 80, 'the repo is there', '/srv/y'), placed('cachyos-g14', 75, 'the repo is there', '/home/b/y')]],
  ])('step 2 does not offer %s', async (_, step2) => {
    let answered = false
    mountNew('desktop', '/new', {
      'POST /api/placement': (body) => {
        if (body.repo === undefined) return [200, { ranked: [placed('cachyos-g14', 45, 'it is idle')], rejected: [] }]
        answered = true
        return [200, { ranked: step2, rejected: [] }]
      },
    })
    await waitFor(() => expect(pressed()).toEqual(['cachyos-g14']))
    type('Name', 'quiet-otter')
    press('Continue')
    await screen.findByText('On this machine')
    press(/2002Bishwajeet\/yantra/)
    await waitFor(() => expect(answered).toBe(true))
    await new Promise((done) => setTimeout(done, 50))
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull()
  })
})

/** Y-627: the hub is the daemon's own host, so it is offered once an account on it has joined. */
describe('the hub (Y-627)', () => {
  const box = aMachine({ name: 'yantra-box', hub: true, address: '100.64.0.9' })
  const machines = () => looked.ok([...contract.machines.data.map((one) => ({ ...one, hub: false })), box])
  const said = (state: 'present' | 'absent', detail: string): Readiness => ({
    machine: box.name,
    age_seconds: 0,
    checks: [{ check: 'reachable', state, detail }],
  })
  const swept = (report: Readiness | null) =>
    looked.ok<Readiness[]>([...contract.readiness.data, ...(report ? [report] : [])] as Readiness[])
  const mount = (readiness: unknown, path = '/new', more: Answers = {}) =>
    mountNew('desktop', path, {
      'GET /api/machines': [200, machines()],
      'GET /api/readiness': [200, readiness],
      'GET /api/about': [200, contract.about],
      'POST /api/placement': [200, { ranked: [], rejected: [] }],
      ...more,
    })
  const group = async () => within(await screen.findByRole('group', { name: 'Machine' }))
  const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'

  it('gives a hub that ssh gets into a pressable chip, and no note', async () => {
    mount(swept(said('present', 'a command ran there')))
    const chips = await group()
    await waitFor(() => expect(chips.getByRole('button', { name: 'yantra-box' })).toBeTruthy())
    expect(chips.getByRole('button', { name: 'yantra-box' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it.each([
    ['Permission denied (publickey)'],
    ['the ssh config here names no account for yantra-box, so ssh tried `yantra`'],
  ])('draws no chip for a hub that said %j, and names the join step', async (detail) => {
    mount(swept(said('absent', detail)))
    const chips = await group()
    const note = await screen.findByRole('note')
    expect(chips.queryByRole('button', { name: /yantra-box/ })).toBeNull()
    expect(note.textContent).toMatch(/after an account on it joins/)
    expect(note.textContent).toMatch(/separate account without sudo on yantra-box, named karigar/)
    expect(await within(note).findByText(COMMAND)).toBeTruthy()
    expect(within(note).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/m/yantra-box')
  })

  it('draws no chip and a note for a hub no report speaks of', async () => {
    mount(swept(null))
    const chips = await group()
    expect((await screen.findByRole('note')).textContent).toMatch(/without sudo/)
    expect(chips.queryByRole('button', { name: /yantra-box/ })).toBeNull()
  })

  it('does not preselect a ?machine= hub that has not joined', async () => {
    mount(swept(said('absent', 'Permission denied (publickey)')), '/new?machine=yantra-box')
    await screen.findByRole('note')
    type('Name', 'quiet-otter')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  it('preselects a ?machine= hub that has joined', async () => {
    mount(swept(said('present', '')), '/new?machine=yantra-box')
    const chips = await group()
    await waitFor(() => expect(chips.getByRole('button', { name: 'yantra-box' }).getAttribute('aria-pressed')).toBe('true'))
  })

  it('draws no hub chip when the readiness read failed, and says so in the note', async () => {
    mount(looked.failed('the sweep did not run'))
    const chips = await group()
    expect(await screen.findByRole('note')).toBeTruthy()
    expect(chips.queryByRole('button', { name: /yantra-box/ })).toBeNull()
  })

  it('draws a skeleton, no chip and no note while readiness is still pending', async () => {
    mount(null, '/new', { 'GET /api/readiness': () => new Promise<never>(() => {}) })
    await screen.findByRole('dialog', { name: 'New session' })
    expect(screen.queryByRole('group', { name: 'Machine' })).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('gives the note without the command when /api/about is missing', async () => {
    mount(swept(said('absent', 'Permission denied (publickey)')), '/new', { 'GET /api/about': [404, 'gone'] })
    const note = await screen.findByRole('note')
    expect(note.textContent).toMatch(/without sudo/)
    expect(within(note).queryByText(/curl -fsSL/)).toBeNull()
  })
})
