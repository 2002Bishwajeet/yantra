import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
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
  if (path === HOME) return of(HOME, [at(HOME, 'Documents'), at(HOME, 'Projects')])
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
