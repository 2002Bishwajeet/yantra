import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { type Answers, HOME, listing, mountNew, unmountNew } from './harness'

afterEach(() => {
  cleanup()
  unmountNew()
})

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

/** Steps 1 and 2 of the walk: a machine, GitHub, and the repository that is
 *  already on it. */
async function toStepThree(answers: Answers = {}) {
  const asked = mountNew('desktop', '/new', answers)
  await screen.findByRole('heading', { level: 1, name: 'New session' })
  type('Name', 'quiet-otter')
  press('cachyos-g14')
  press('Continue')
  await screen.findByText(/already on cachyos-g14/)
  press(/2002Bishwajeet\/yantra/)
  press('Continue')
  await screen.findByText('What opens in the session')
  return asked
}

describe('step 1, the name and the machine', () => {
  it('offers a generated pair, another one on request, and refuses what the daemon would', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('heading', { level: 1, name: 'New session' })
    const field = screen.getByLabelText('Name') as HTMLInputElement
    expect(field.value).toMatch(/^[a-z]+-[a-z]+$/)

    press('Another name')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toMatch(/^[a-z]+-[a-z]+$/)

    type('Name', 'quiet otter')
    expect(await screen.findByText(/letters, digits/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  it('takes one machine, and never one that is not there', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('heading', { level: 1, name: 'New session' })
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
    expect(await screen.findByText(/The machines could not be read/)).toBeTruthy()
    expect(screen.getByText('tailscale: not running')).toBeTruthy()
  })
})

describe('step 2, where the code comes from', () => {
  it('joins the swept list to the machine, and searching narrows it in the browser', async () => {
    const asked = mountNew('desktop', '/new')
    await screen.findByRole('heading', { level: 1, name: 'New session' })
    press('cachyos-g14')
    press('Continue')

    const rows = within(await screen.findByRole('list', { name: 'Repositories' }))
    await waitFor(() => expect(rows.getByText(/already on cachyos-g14/)).toBeTruthy())
    expect(rows.getByText(`already on cachyos-g14 at ~/Github/yantra`)).toBeTruthy()
    expect(rows.getByText('not here yet · clone into ~/Github/scratch')).toBeTruthy()
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
    await screen.findByRole('heading', { level: 1, name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    const rows = within(await screen.findByRole('list', { name: 'Repositories' }))
    await waitFor(() => expect(rows.getAllByText(/could not be asked/)).toHaveLength(2))
    // Unchecked still goes on: only a proven absence blocks (D4 §5).
    fireEvent.click(rows.getByRole('button', { name: /2002Bishwajeet\/yantra/ }))
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
  })

  it('sends nobody to GitHub without a grant, and draws GitLab as later', async () => {
    mountNew('desktop', '/new', { 'GET /api/github': [200, contract.disconnected] })
    await screen.findByRole('heading', { level: 1, name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    expect(await screen.findByText('GitHub is not signed in')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in in Settings' }).getAttribute('href')).toBe(
      '/settings/providers',
    )
    expect(screen.getByRole('button', { name: /GitLab/ })).toHaveProperty('disabled', true)
  })

  it('browses the machine, and makes a folder where there is none', async () => {
    const made = { ...listing(`${HOME}/Github`), entries: [] as unknown[] }
    const asked = mountNew('desktop', '/new', {
      'POST /api/machines/cachyos-g14/dirs': (sent) =>
        sent.make === undefined ? [200, listing(String(sent.path ?? HOME))] : [200, made],
    })
    await screen.findByRole('heading', { level: 1, name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('button', { name: /Local directory/ })
    press(/Local directory/)

    const folders = within(await screen.findByRole('list', { name: 'Folders' }))
    fireEvent.click(folders.getByRole('button', { name: /Github/ }))
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

describe('step 3, what opens in the session', () => {
  it('starts Claude unless a command is typed, and says what will happen', async () => {
    await toStepThree()
    expect(screen.getByText(/^open a tmux session on cachyos-g14/)).toBeTruthy()
    expect(screen.getByText(/start Claude in it/)).toBeTruthy()

    press(/A command/)
    expect(screen.getByRole('button', { name: 'Create and open' })).toHaveProperty('disabled', true)
    type('Command', 'just dev')
    await waitFor(() => expect(screen.getByText(/^run just dev in it/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Create and open' })).toHaveProperty('disabled', false)
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
