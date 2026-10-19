import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ByRoleMatcher, ByRoleOptions, Matcher } from '@testing-library/dom'
import * as contract from '@/contract.gen'
import { readPrefs, writePrefs } from '@/shell/prefs'
import { type Answers, HOME, listing, mountNew, unmountNew } from './harness'

afterEach(() => {
  cleanup()
  unmountNew()
  writePrefs({ general: {} })
})

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

const DOCS = `${HOME}/Documents`

/** A Mac that keeps its repositories in ~/Documents/GitHub. */
const mac = (path: string) => {
  const at = (dir: string, name: string, origin: string | null = null, kind: 'dir' | 'file' = 'dir') => ({
    path: `${dir}/${name}`,
    name,
    kind,
    access: true,
    repo: origin !== null,
    origin,
  })
  const of = (here: string, entries: unknown[]) => ({
    machine: 'cachyos-g14',
    path: here,
    access: true,
    entries,
    truncated: false,
  })
  if (path === `${DOCS}/GitHub`) return of(path, [at(path, 'yantra', 'git@github.com:2002Bishwajeet/yantra.git')])
  if (path === DOCS) return of(path, [at(DOCS, 'GitHub'), at(DOCS, 'notes.txt', null, 'file')])
  if (path === `${HOME}/Projects`) return of(path, [])
  if (path === `${HOME}/Desktop`) return { ...of(path, []), access: false }
  if (path === HOME) return of(HOME, [at(HOME, 'Desktop'), at(HOME, 'Documents'), at(HOME, 'Projects')])
  return listing(path)
}

const onMac: Answers = {
  'POST /api/machines/cachyos-g14/dirs': (sent) => [200, mac(String(sent.path ?? HOME))],
}

describe('step 2, subfolders in the local browser', () => {
  async function toLocal() {
    mountNew('desktop', '/new', onMac)
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('button', { name: /Local directory/ })
    press(/Local directory/)
    return within(await screen.findByRole('list', { name: 'Folders' }))
  }

  it('opens a folder in place, lists only folders, and closes it again', async () => {
    const folders = await toLocal()
    const toggle = await folders.findByRole('button', { name: 'Show folders in Documents' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(folders.queryByText('GitHub')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const inside = within(await folders.findByRole('list', { name: 'Folders in Documents' }))
    expect(await inside.findByText('GitHub')).toBeTruthy()
    expect(inside.queryByText('notes.txt')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(folders.queryByText('GitHub')).toBeNull()
  })

  it('a folder the machine refuses to read says why, and does not read as empty', async () => {
    const folders = await toLocal()
    fireEvent.click(await folders.findByRole('button', { name: 'Show folders in Desktop' }))
    expect(await folders.findByText(/Allow full disk access for remote users/)).toBeTruthy()
    expect(folders.queryByText('no folders here')).toBeNull()
  })

  it('opens a subfolder inside a subfolder, and pressing its name walks into it', async () => {
    const folders = await toLocal()
    fireEvent.click(await folders.findByRole('button', { name: 'Show folders in Documents' }))
    fireEvent.click(await folders.findByRole('button', { name: 'Show folders in GitHub' }))
    const deep = within(await folders.findByRole('list', { name: 'Folders in GitHub' }))
    fireEvent.click(await deep.findByRole('button', { name: /^yantra/ }))
    await waitFor(() => expect(screen.getAllByText('~/Documents/GitHub/yantra').length).toBeGreaterThan(0))
  })
})

describe('step 2, the clone folder', () => {
  async function toGithub() {
    mountNew('desktop', '/new', onMac)
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    return within(await screen.findByRole('list', { name: 'Repositories' }))
  }

  it('finds the provider folder in ~/Documents and says already on', async () => {
    const rows = await toGithub()
    await waitFor(() => expect(rows.getByText('already on cachyos-g14 at ~/Documents/GitHub/yantra')).toBeTruthy())
    expect(screen.getByText('~/Documents/GitHub')).toBeTruthy()
    expect(rows.getByText('not here yet · clone into ~/Documents/GitHub/scratch')).toBeTruthy()
  })

  it('lets a person change it, and keeps the choice for this machine', async () => {
    const rows = await toGithub()
    await waitFor(() => expect(rows.getByText(/already on/)).toBeTruthy())
    press('Change')
    await screen.findByRole('list', { name: 'Clone folder choices' })
    const where = within(screen.getByRole('navigation', { name: 'Where you are' }))
    fireEvent.click(where.getByRole('button', { name: '~' }))
    const picker = within(await screen.findByRole('list', { name: 'Clone folder choices' }))
    fireEvent.click(await picker.findByRole('button', { name: /^Projects/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Use ~\/Projects$/ }))
    expect((await screen.findAllByText(/not here yet · clone into ~\/Projects\//)).length).toBeGreaterThan(0)
    expect(readPrefs().general.cloneFolders).toEqual({ 'cachyos-g14': `${HOME}/Projects` })
    expect(screen.queryByRole('list', { name: 'Clone folder choices' })).toBeNull()
  })

  it('uses the remembered folder in the next New session', async () => {
    writePrefs({ general: { cloneFolders: { 'cachyos-g14': `${HOME}/Projects` } } })
    const rows = await toGithub()
    expect((await screen.findAllByText(/not here yet · clone into ~\/Projects\//)).length).toBeGreaterThan(0)
    expect(rows.queryByText(/~\/Documents/)).toBeNull()
  })
})

/** The Mac again, with the pieces Y-516 sorts and filters: a dotfile in
 *  `$HOME`, and a folder of two plain folders and two repositories. */
describe('step 2, the local picker browses like a file browser (Y-516)', () => {
  const entry = (dir: string, name: string, over: Record<string, unknown> = {}) => ({
    path: `${dir}/${name}`,
    name,
    kind: 'dir',
    access: true,
    repo: false,
    origin: null,
    ...over,
  })
  const repo = (dir: string, name: string) => entry(dir, name, { repo: true, origin: `git@github.com:me/${name}.git` })
  const of = (path: string, entries: unknown[]) => ({ machine: 'cachyos-g14', path, access: true, entries, truncated: false })

  const tree = (path: string) => {
    if (path === `${DOCS}/GitHub`) {
      return of(path, [entry(path, 'alpha'), repo(path, 'yantra'), entry(path, 'notes'), repo(path, 'landing')])
    }
    if (path === DOCS) return of(path, [entry(DOCS, 'GitHub')])
    if (path === HOME) {
      return of(HOME, [
        entry(HOME, '.config'),
        entry(HOME, 'Documents'),
        entry(HOME, 'Projects'),
        entry(HOME, 'configs'),
        entry(HOME, 'todo.txt', { kind: 'file' }),
      ])
    }
    if (path === `${HOME}/Projects`) return of(path, [])
    if (path === '/home') return of(path, [entry('/home', 'biswa')])
    if (path === '/') return of(path, [entry('', 'home')])
    return null
  }
  const dirs = (sent: Record<string, unknown>): [number, unknown] => {
    const path = String(sent.path ?? HOME)
    const found = tree(path)
    return found ? [200, found] : [409, `no directory at ${path}`]
  }
  const probe = (sent: Record<string, unknown>): [number, unknown] => {
    const path = String(sent.path)
    const exists = path !== '/nowhere'
    return [200, { machine: 'cachyos-g14', path, exists, origin: path.endsWith('/yantra') ? 'git@github.com:me/yantra.git' : null }]
  }
  const answers: Answers = {
    'POST /api/machines/cachyos-g14/dirs': dirs,
    'POST /api/machines/cachyos-g14/probe': probe,
  }

  // The list is replaced by a skeleton on every walk, so each query finds it again.
  type Args = [role: ByRoleMatcher, options?: ByRoleOptions]
  const list = () => within(screen.getByRole('list', { name: 'Folders' }))
  const folders = {
    getByRole: (...a: Args) => list().getByRole(...a),
    queryByRole: (...a: Args) => list().queryByRole(...a),
    getAllByRole: (...a: Args) => list().getAllByRole(...a),
    queryByText: (text: Matcher) => list().queryByText(text),
    findByRole: (...a: Args) => waitFor(() => list().getByRole(...a)),
  }

  async function toLocal(extra: Answers = {}, name = 'quiet-otter') {
    mountNew('desktop', '/new', { ...answers, ...extra })
    await screen.findByRole('dialog', { name: 'New session' })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('button', { name: /Local directory/ })
    press(/Local directory/)
    await screen.findByRole('list', { name: 'Folders' })
    return folders
  }
  const crumbsNow = () => within(screen.getByRole('navigation', { name: 'Where you are' }))
  const rowNames = () =>
    folders.getAllByRole('button', { name: /^(?!Show folders)/ }).map((one) => one.textContent?.replace(/(git|not a repository).*$/, ''))

  it('types a path in the path bar and walks there', async () => {
    await toLocal()
    press('Edit path')
    const field = screen.getByLabelText('Path') as HTMLInputElement
    expect(field.value).toBe(HOME)
    fireEvent.change(field, { target: { value: `${DOCS}/GitHub` } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await folders.findByRole('button', { name: /^yantra/ })).toBeTruthy()
    expect(screen.queryByLabelText('Path')).toBeNull()
    expect(crumbsNow().getByText('GitHub').getAttribute('aria-current')).toBe('location')
    expect(screen.getAllByText('~/Documents/GitHub').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Or type a path')).toBeNull()
  })

  it('opens the path bar on / and on Ctrl+L, but not from inside a text field', async () => {
    await toLocal()
    fireEvent.keyDown(document.body, { key: '/' })
    expect(await screen.findByLabelText('Path')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Path'), { key: 'Escape' })
    expect(screen.queryByLabelText('Path')).toBeNull()

    fireEvent.keyDown(document.body, { key: 'l', ctrlKey: true })
    expect(await screen.findByLabelText('Path')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Path'), { key: 'Escape' })

    fireEvent.keyDown(screen.getByLabelText('Filter this folder'), { key: '/' })
    expect(screen.queryByLabelText('Path')).toBeNull()
  })

  it('chooses a typed path that is missing, with the error line, and stays put', async () => {
    await toLocal()
    press('Edit path')
    const field = screen.getByLabelText('Path')
    fireEvent.change(field, { target: { value: '/nowhere' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText('cachyos-g14 has no directory at /nowhere. Make it there, or choose another.')).toBeTruthy()
    expect(crumbsNow().getByText('~').getAttribute('aria-current')).toBe('location')
  })

  it('chooses a typed path unchecked when the machine cannot be asked', async () => {
    await toLocal({ 'POST /api/machines/cachyos-g14/probe': [503, 'ssh: No route to host'] })
    press('Edit path')
    const field = screen.getByLabelText('Path')
    fireEvent.change(field, { target: { value: '/srv/code' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText(/could not be asked, so this path is unchecked/)).toBeTruthy()
    expect(screen.getByText('ssh: No route to host')).toBeTruthy()
  })

  it('chooses a typed path unchecked when the machine cannot list', async () => {
    mountNew('desktop', '/new', {
      'POST /api/machines/cachyos-g14/dirs': [503, 'ssh: No route to host'],
      'POST /api/machines/cachyos-g14/probe': [503, 'ssh: No route to host'],
    })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('button', { name: /Local directory/ })
    press(/Local directory/)
    expect(await screen.findByText('cachyos-g14 could not be asked what is there')).toBeTruthy()
    const field = screen.getByLabelText('Path')
    fireEvent.change(field, { target: { value: '/srv/code' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText(/could not be asked, so this path is unchecked/)).toBeTruthy()
  })

  it('gives the crumbs back on Escape, without walking', async () => {
    await toLocal()
    press('Edit path')
    const field = screen.getByLabelText('Path')
    fireEvent.change(field, { target: { value: `${DOCS}/GitHub` } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByLabelText('Path')).toBeNull()
    expect(crumbsNow().getByText('~').getAttribute('aria-current')).toBe('location')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit path' }))
  })

  it('filters the open folder as you type, says when nothing matches, and clears on a walk', async () => {
    await toLocal()
    await folders.findByRole('button', { name: /^Documents/ })
    const filter = screen.getByLabelText('Filter this folder')
    fireEvent.change(filter, { target: { value: 'CONF' } })
    expect(folders.queryByRole('button', { name: /^Documents/ })).toBeNull()
    expect(folders.getByRole('button', { name: /^configs/ })).toBeTruthy()

    fireEvent.change(filter, { target: { value: 'zzz' } })
    expect(screen.getByText('nothing in ~ matches zzz')).toBeTruthy()

    fireEvent.change(filter, { target: { value: 'doc' } })
    fireEvent.click(folders.getByRole('button', { name: /^Documents/ }))
    await folders.findByRole('button', { name: /^GitHub/ })
    expect((screen.getByLabelText('Filter this folder') as HTMLInputElement).value).toBe('')
  })

  it('sorts repositories before plain folders, then by name', async () => {
    await toLocal()
    fireEvent.click(await folders.findByRole('button', { name: /^Documents/ }))
    fireEvent.click(await folders.findByRole('button', { name: /^GitHub/ }))
    await folders.findByRole('button', { name: /^yantra/ })
    expect(rowNames()).toEqual(['landing', 'yantra', 'alpha', 'notes'])
  })

  it('moves with the arrow keys over the rows, and Tab reaches only one of them', async () => {
    await toLocal()
    const documents = await folders.findByRole('button', { name: /^Documents/ })
    const projects = folders.getByRole('button', { name: /^Projects/ })
    expect(folders.getByRole('button', { name: /^configs/ }).tabIndex).toBe(0)
    expect(documents.tabIndex).toBe(-1)
    expect(projects.tabIndex).toBe(-1)

    const key = (el: HTMLElement, name: string) => fireEvent.keyDown(el, { key: name })
    const configs = folders.getByRole('button', { name: /^configs/ })
    configs.focus()
    key(configs, 'ArrowDown')
    expect(document.activeElement).toBe(documents)
    expect(documents.tabIndex).toBe(0)
    expect(configs.tabIndex).toBe(-1)
    key(documents, 'End')
    expect(document.activeElement).toBe(projects)
    key(projects, 'ArrowUp')
    expect(document.activeElement).toBe(documents)
    key(documents, 'Home')
    expect(document.activeElement).toBe(configs)
  })

  it('opens on Enter, shows subfolders on Right, and hides them or goes to the parent on Left', async () => {
    await toLocal()
    const documents = await folders.findByRole('button', { name: /^Documents/ })
    documents.focus()
    const toggle = folders.getByRole('button', { name: 'Show folders in Documents' })

    fireEvent.keyDown(documents, { key: 'ArrowRight' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const sub = within(await folders.findByRole('list', { name: 'Folders in Documents' }))
    const inner = await sub.findByRole('button', { name: /^GitHub/ })
    fireEvent.keyDown(documents, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(inner)

    fireEvent.keyDown(inner, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(documents)
    fireEvent.keyDown(documents, { key: 'ArrowLeft' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    const enter = fireEvent.keyDown(documents, { key: 'Enter' })
    expect(enter).toBe(true)
    fireEvent.click(documents)
    await waitFor(() => expect(crumbsNow().getByText('Documents').getAttribute('aria-current')).toBe('location'))
  })

  it('goes up one folder on Backspace, but not while typing in a field', async () => {
    await toLocal()
    fireEvent.click(await folders.findByRole('button', { name: /^Documents/ }))
    const github = await folders.findByRole('button', { name: /^GitHub/ })
    fireEvent.change(screen.getByLabelText('Filter this folder'), { target: { value: 'git' } })
    fireEvent.keyDown(screen.getByLabelText('Filter this folder'), { key: 'Backspace' })
    expect(crumbsNow().getByText('Documents').getAttribute('aria-current')).toBe('location')

    fireEvent.keyDown(github, { key: 'Backspace' })
    await waitFor(() => expect(crumbsNow().getByText('~').getAttribute('aria-current')).toBe('location'))
    expect(await folders.findByRole('button', { name: /^Documents/ })).toBeTruthy()
  })

  it('moves from the filter to the first row on Down', async () => {
    await toLocal()
    await folders.findByRole('button', { name: /^Documents/ })
    fireEvent.keyDown(screen.getByLabelText('Filter this folder'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(folders.getAllByRole('button', { name: /^(?!Show folders)/ })[0])
  })

  it('describes the keys on the list', async () => {
    await toLocal()
    await folders.findByRole('button', { name: /^Documents/ })
    const list = screen.getByRole('list', { name: 'Folders' })
    const said = document.getElementById(list.getAttribute('aria-describedby') ?? '')
    expect(said?.textContent).toMatch(/Backspace goes up one folder/)
  })

  it('combines Show hidden with the filter', async () => {
    await toLocal()
    await folders.findByRole('button', { name: /^Documents/ })
    fireEvent.change(screen.getByLabelText('Filter this folder'), { target: { value: 'conf' } })
    expect(folders.queryByText('.config')).toBeNull()
    press('Show hidden')
    expect(folders.getByRole('button', { name: /^\.config/ })).toBeTruthy()
    expect(folders.getByRole('button', { name: /^configs/ })).toBeTruthy()
    expect(folders.queryByRole('button', { name: /^Documents/ })).toBeNull()
  })

  it('opens at the folder last used on this machine', async () => {
    writePrefs({ general: { lastFolders: { 'cachyos-g14': `${DOCS}/GitHub` } } })
    await toLocal()
    expect(await folders.findByRole('button', { name: /^yantra/ })).toBeTruthy()
    expect(crumbsNow().getByText('GitHub').getAttribute('aria-current')).toBe('location')
    expect(screen.queryByText(/is gone; showing home/)).toBeNull()
  })

  it('falls back to home with a note when the last folder is gone', async () => {
    writePrefs({ general: { lastFolders: { 'cachyos-g14': '/home/biswa/old' } } })
    await toLocal()
    expect(await screen.findByText('/home/biswa/old is gone; showing home')).toBeTruthy()
    expect(await folders.findByRole('button', { name: /^Documents/ })).toBeTruthy()
    expect(crumbsNow().getByText('~').getAttribute('aria-current')).toBe('location')

    fireEvent.click(folders.getByRole('button', { name: /^Documents/ }))
    await waitFor(() => expect(screen.queryByText(/is gone; showing home/)).toBeNull())
  })

  it('keeps the inline error when home itself cannot be listed', async () => {
    writePrefs({ general: { lastFolders: { 'cachyos-g14': '/home/biswa/old' } } })
    mountNew('desktop', '/new', {
      'POST /api/machines/cachyos-g14/dirs': [503, 'ssh: connect to host cachyos-g14 port 22: No route to host'],
    })
    await screen.findByRole('dialog', { name: 'New session' })
    press('cachyos-g14')
    press('Continue')
    await screen.findByRole('button', { name: /Local directory/ })
    press(/Local directory/)
    expect(await screen.findByText('cachyos-g14 could not be asked what is there')).toBeTruthy()
    expect(screen.getByText(/No route to host/)).toBeTruthy()
  })

  it('draws recent folders only when there are some, and a press walks there and chooses it', async () => {
    await toLocal()
    expect(screen.queryByText('Recent on cachyos-g14')).toBeNull()
    cleanup()
    unmountNew()

    writePrefs({ general: { recentFolders: { 'cachyos-g14': [`${DOCS}/GitHub/yantra`, `${HOME}/Projects`] } } })
    await toLocal({
      'POST /api/machines/cachyos-g14/dirs': (sent) => {
        const path = String(sent.path ?? HOME)
        return path === `${DOCS}/GitHub/yantra` ? [200, of(path, [])] : dirs(sent)
      },
    })
    await folders.findByRole('button', { name: /^Documents/ })
    const recent = within(screen.getByRole('region', { name: 'Recent on cachyos-g14' }))
    expect(recent.getAllByRole('button').map((one) => one.textContent)).toEqual(['~/Documents/GitHub/yantra', '~/Projects'])

    fireEvent.click(recent.getByRole('button', { name: '~/Documents/GitHub/yantra' }))
    await waitFor(() => expect(crumbsNow().getByText('yantra').getAttribute('aria-current')).toBe('location'))
    expect(screen.getByText('me/yantra')).toBeTruthy()
  })

  it('shows at most five recents, newest first', async () => {
    writePrefs({ general: {} })
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const { rememberFolder } = await import('./picker')
      rememberFolder('cachyos-g14', `/srv/${n}`)
    }
    await toLocal()
    const recent = within(await screen.findByRole('region', { name: 'Recent on cachyos-g14' }))
    expect(recent.getAllByRole('button').map((one) => one.textContent)).toEqual(['/srv/6', '/srv/5', '/srv/4', '/srv/3', '/srv/2'])
  })

  describe('starting', () => {
    const toStart = async (extra: Answers) => {
      await toLocal({ ...extra, 'POST /api/workspaces/quiet-otter/up': [200, contract.opened] })
      fireEvent.click(await folders.findByRole('button', { name: /^Documents/ }))
      await waitFor(() => expect(crumbsNow().getByText('Documents').getAttribute('aria-current')).toBe('location'))
      press('Continue')
      await screen.findByText('What opens in the session')
      press('Create and open')
    }

    it('records the folder once the workspace is created, and not on a walk', async () => {
      await toLocal()
      expect(readPrefs().general.lastFolders).toBeUndefined()
      cleanup()
      unmountNew()

      await toStart({ 'POST /api/workspaces': (sent) => [201, { ...sent, startup: null }] })
      await waitFor(() => expect(readPrefs().general.lastFolders).toEqual({ 'cachyos-g14': DOCS }))
      expect(readPrefs().general.recentFolders).toEqual({ 'cachyos-g14': [DOCS] })
    })

    it('records nothing when the daemon refuses the workspace', async () => {
      await toStart({ 'POST /api/workspaces': [409, 'workspace `quiet-otter` already exists'] })
      expect(await screen.findByText('workspace `quiet-otter` already exists')).toBeTruthy()
      expect(readPrefs().general.lastFolders).toBeUndefined()
      expect(readPrefs().general.recentFolders).toBeUndefined()
    })
  })
})
