import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { writePrefs } from '@/shell/prefs'
import { type Answers, HOME, listing, mountNew, unmountNew } from './harness'

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
  await screen.findByText(/already on cachyos-g14/)
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

  /** The boards name four steps and draw three panels: leaving the first
   *  ticks Name and Machine together (NewSession, NewSessionSource). */
  it('names the boards four steps, and ticks two of them at once', async () => {
    mountNew('desktop', '/new')
    await screen.findByRole('dialog', { name: 'New session' })
    const steps = () => within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    expect(steps().map((one) => one.textContent)).toEqual(['1Name', '2Machine', '3Source', '4Start'])
    expect(steps()[0].getAttribute('aria-current')).toBe('step')

    type('Name', 'quiet-otter')
    press('cachyos-g14')
    press('Continue')
    await screen.findByText(/already on cachyos-g14/)
    expect(steps().map((one) => one.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'current',
      'ahead',
    ])
  })

  it('takes one machine, and never one that is not there', async () => {
    mountNew('desktop', '/new')
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
    await screen.findByRole('dialog', { name: 'New session' })
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
    await screen.findByRole('dialog', { name: 'New session' })
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
    await screen.findByRole('dialog', { name: 'New session' })
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
    expect(await folders.findByRole('button', { name: /\.config/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }))
    await waitFor(() => expect(folders.queryByText('.config')).toBeNull())
  })

  it('draws files and closed folders, marked, and neither is a choice', async () => {
    const { folders, sent } = await toLocal()
    const file = await folders.findByText('todo.txt')
    const closed = folders.getByText('private')
    expect(folders.getByText('file')).toBeTruthy()
    expect(folders.getByText('no access')).toBeTruthy()
    expect(file.closest('button')).toBeNull()
    expect(closed.closest('button')).toBeNull()
    expect(folders.queryByRole('button', { name: /^(todo\.txt|private)/ })).toBeNull()

    const before = sent.length
    fireEvent.click(file)
    fireEvent.click(closed)
    // Nothing was asked and nothing was chosen: the folder is still $HOME.
    expect(sent).toHaveLength(before)
    expect(screen.getAllByText('~').length).toBeGreaterThan(0)
  })

  it('walks above $HOME to / and into another folder there', async () => {
    const { folders, sent } = await toLocal()
    await folders.findByText('Github')
    const where = within(screen.getByRole('navigation', { name: 'Where you are' }))
    expect(where.getAllByRole('button').map((one) => one.textContent)).toEqual(['/', 'home'])

    fireEvent.click(where.getByRole('button', { name: '/' }))
    await folders.findByRole('button', { name: /srv/ })
    expect(sent).toContain('/')
    expect(folders.getByText('root').closest('button')).toBeNull()

    fireEvent.click(folders.getByRole('button', { name: /srv/ }))
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
    expect(await folders.findByText(/sent the first 4 entries and stopped/)).toBeTruthy()

    const where = within(screen.getByRole('navigation', { name: 'Where you are' }))
    fireEvent.click(where.getByRole('button', { name: '/' }))
    fireEvent.click(await folders.findByRole('button', { name: /srv/ }))
    expect(await folders.findByText('cachyos-g14 does not let this account read this folder')).toBeTruthy()
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

  it('selects no machine when there is no default', async () => {
    mountNew('desktop', '/new')
    await stays()
  })

  it('does not select a default that is offline', async () => {
    writePrefs({ general: { defaultMachine: 'bishwajeets-macbook-pro' } })
    mountNew('desktop', '/new')
    await stays()
  })

  it('does not select a default the list does not hold', async () => {
    writePrefs({ general: { defaultMachine: 'gone' } })
    mountNew('desktop', '/new')
    await stays()
  })

  it('yields to ?machine=', async () => {
    writePrefs({ general: { defaultMachine: 'pi' } })
    mountNew('desktop', '/new?machine=cachyos-g14')
    await screen.findByRole('dialog', { name: 'New session' })
    await waitFor(() => expect(pressed().map((chip) => chip.textContent)).toEqual(['cachyos-g14']))
  })

  it('does not press a ?machine= that is unreachable', async () => {
    mountNew('desktop', '/new?machine=bishwajeets-macbook-pro')
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

  it('chooses no machine when the general pref is corrupt', async () => {
    writePrefs({ general: { defaultMachine: 42 } })
    mountNew('desktop', '/new')
    await stays()
  })
})
