import { describe, expect, it } from 'vitest'
import type { Entry, Listing } from '@/api'
import { defaultCloneFolder, findFolder } from './clonePath'

const entry = (at: string, name: string, kind: Entry['kind'] = 'dir', access = true): Entry => ({
  path: `${at}/${name}`,
  name,
  kind,
  access,
  repo: false,
  origin: null,
})

const of = (path: string, entries: Entry[]): Listing => ({
  machine: 'mac',
  path,
  access: true,
  entries,
  truncated: false,
})

const HOME = '/Users/biswa'
const DOCS = `${HOME}/Documents`

describe('the default clone folder', () => {
  it('finds ~/Documents/Github when ~ holds none', () => {
    const home = of(HOME, [entry(HOME, 'Documents')])
    const documents = of(DOCS, [entry(DOCS, 'Github'), entry(DOCS, 'Gitlab')])
    expect(defaultCloneFolder(HOME, home, documents)).toBe(`${DOCS}/Github`)
    expect(defaultCloneFolder(HOME, home, documents, 'Gitlab')).toBe(`${DOCS}/Gitlab`)
  })

  it('prefers ~/Github to ~/Documents/Github', () => {
    const home = of(HOME, [entry(HOME, 'Github'), entry(HOME, 'Documents')])
    const documents = of(DOCS, [entry(DOCS, 'Github')])
    expect(defaultCloneFolder(HOME, home, documents)).toBe(`${HOME}/Github`)
  })

  it('matches the name in any letter case', () => {
    expect(defaultCloneFolder(HOME, of(HOME, [entry(HOME, 'GitHub')]), undefined)).toBe(`${HOME}/GitHub`)
    const documents = of(DOCS, [entry(DOCS, 'github')])
    expect(defaultCloneFolder(HOME, of(HOME, []), documents)).toBe(`${DOCS}/github`)
  })

  it('falls back to ~/Github, which a clone makes, when none exists', () => {
    const home = of(HOME, [entry(HOME, 'Documents')])
    expect(defaultCloneFolder(HOME, home, of(DOCS, []))).toBe(`${HOME}/Github`)
    expect(defaultCloneFolder(HOME, undefined, undefined)).toBe(`${HOME}/Github`)
  })

  it('ignores a file, and a folder this account cannot enter', () => {
    const home = of(HOME, [entry(HOME, 'Github', 'file'), entry(HOME, 'github', 'dir', false)])
    expect(findFolder(home, 'Github')).toBeNull()
  })
})
