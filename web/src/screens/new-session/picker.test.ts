import { afterEach, describe, expect, it } from 'vitest'
import type { Entry } from '@/api'
import { readPrefs, writePrefs } from '@/shell/prefs'
import { arrange, lastFolder, recentFolders, rememberFolder } from './picker'

afterEach(() => writePrefs({ general: {} }))

const one = (name: string, over: Partial<Entry> = {}): Entry => ({
  path: `/h/${name}`,
  name,
  kind: 'dir',
  access: true,
  repo: false,
  origin: null,
  ...over,
})

const names = (entries: Entry[]) => entries.map((e) => e.name)

describe('arrange', () => {
  const all = [
    one('zeta'),
    one('README.md', { kind: 'file' }),
    one('locked', { access: false }),
    one('alpha'),
    one('yantra', { repo: true, origin: 'git@github.com:a/yantra.git' }),
    one('landing', { repo: true }),
    one('.config'),
  ]

  it('puts repositories first, then folders, then files, then folders it cannot read', () => {
    expect(names(arrange(all, { hidden: true, filter: '' }))).toEqual([
      'landing',
      'yantra',
      '.config',
      'alpha',
      'zeta',
      'README.md',
      'locked',
    ])
  })

  it('drops dotfiles unless hidden is on', () => {
    expect(names(arrange(all, { hidden: false, filter: '' }))).not.toContain('.config')
    expect(names(arrange(all, { hidden: true, filter: '' }))).toContain('.config')
  })

  it('keeps case-insensitive substring matches', () => {
    expect(names(arrange(all, { hidden: false, filter: 'AN' }))).toEqual(['landing', 'yantra'])
    expect(names(arrange(all, { hidden: false, filter: '  ' }))).toHaveLength(6)
  })

  it('combines hidden with the filter', () => {
    expect(names(arrange(all, { hidden: false, filter: 'conf' }))).toEqual([])
    expect(names(arrange(all, { hidden: true, filter: 'conf' }))).toEqual(['.config'])
  })
})

describe('remembered folders', () => {
  it('reads nothing from empty prefs', () => {
    expect(lastFolder(readPrefs(), 'm')).toBeNull()
    expect(recentFolders(readPrefs(), 'm')).toEqual([])
  })

  it('keeps the last folder and recents per machine, newest first', () => {
    rememberFolder('m', '/h/a')
    rememberFolder('m', '/h/b')
    rememberFolder('n', '/srv/x')
    expect(lastFolder(readPrefs(), 'm')).toBe('/h/b')
    expect(recentFolders(readPrefs(), 'm')).toEqual(['/h/b', '/h/a'])
    expect(recentFolders(readPrefs(), 'n')).toEqual(['/srv/x'])
  })

  it('dedupes a repeat, moving it to the front, and ignores a trailing slash', () => {
    rememberFolder('m', '/h/a')
    rememberFolder('m', '/h/b')
    rememberFolder('m', '/h/a/')
    expect(recentFolders(readPrefs(), 'm')).toEqual(['/h/a', '/h/b'])
  })

  it('caps recents at five', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) rememberFolder('m', `/h/${n}`)
    expect(recentFolders(readPrefs(), 'm')).toEqual(['/h/7', '/h/6', '/h/5', '/h/4', '/h/3'])
  })

  it('survives malformed prefs', () => {
    writePrefs({ general: { lastFolders: 'x', recentFolders: { m: 'nope', n: [1, '/ok', 'rel', null] } } })
    expect(lastFolder(readPrefs(), 'm')).toBeNull()
    expect(recentFolders(readPrefs(), 'm')).toEqual([])
    expect(recentFolders(readPrefs(), 'n')).toEqual(['/ok'])
    writePrefs({ general: { lastFolders: [1], recentFolders: ['a'] } })
    rememberFolder('m', '/h/a')
    expect(lastFolder(readPrefs(), 'm')).toBe('/h/a')
    expect(recentFolders(readPrefs(), 'm')).toEqual(['/h/a'])
  })

  it('keeps the other preferences it finds', () => {
    writePrefs({ general: { cloneFolders: { m: '/c' } } })
    rememberFolder('m', '/h/a')
    expect(readPrefs().general.cloneFolders).toEqual({ m: '/c' })
  })
})
