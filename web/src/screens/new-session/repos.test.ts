import { describe, expect, it } from 'vitest'
import type { Listing, Repo } from '@/api'
import { crumbs } from './dirs'
import { lastLine } from './progress'
import { byOrigin, filterRepos, place } from './repos'

const repo = (full_name: string): Repo => ({
  full_name,
  private: false,
  language: null,
  pushed_at: null,
  clone_url: `https://github.com/${full_name}.git`,
  default_branch: 'main',
})

const listing: Listing = {
  machine: 'cachyos-g14',
  path: '/home/biswa/Github',
  entries: [
    {
      path: '/home/biswa/Github/yantra',
      name: 'yantra',
      repo: true,
      origin: 'git@github.com:2002Bishwajeet/yantra.git',
    },
    { path: '/home/biswa/Github/scratch', name: 'scratch', repo: false, origin: null },
  ],
}

describe('the repository search', () => {
  it('filters the swept list in the browser, without case', () => {
    const list = [repo('a/yantra'), repo('a/landing')]
    expect(filterRepos(list, '')).toHaveLength(2)
    expect(filterRepos(list, '  YAN ').map((one) => one.full_name)).toEqual(['a/yantra'])
    expect(filterRepos(list, 'zzz')).toHaveLength(0)
  })
})

describe('what a machine already holds', () => {
  const held = byOrigin(listing)

  it('joins the clone home by origin, however the origin is written', () => {
    expect([...held.keys()]).toEqual(['2002bishwajeet/yantra'])
    expect(place(repo('2002Bishwajeet/yantra'), '/home/biswa', held)).toEqual({
      path: '/home/biswa/Github/yantra',
      here: 'yes',
    })
  })

  it('places what is not there under the clone home', () => {
    expect(place(repo('2002Bishwajeet/landing'), '/home/biswa', held)).toEqual({
      path: '/home/biswa/Github/landing',
      here: 'no',
    })
  })

  it('a machine that could not be asked is unchecked, not absent', () => {
    expect(place(repo('a/b'), '/home/biswa', byOrigin(undefined), 'ssh: no route')).toEqual({
      path: '/home/biswa/Github/b',
      here: 'unknown',
      because: 'ssh: no route',
    })
  })
})

describe('the breadcrumb', () => {
  it('makes every segment a way back up, from ~ inside home', () => {
    expect(crumbs('/home/biswa/Github/yantra', '/home/biswa')).toEqual([
      { label: '~', path: '/home/biswa' },
      { label: 'Github', path: '/home/biswa/Github' },
      { label: 'yantra', path: '/home/biswa/Github/yantra' },
    ])
  })

  it('starts at / outside home, and where no home is known', () => {
    expect(crumbs('/srv/code', '/home/biswa')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: 'code', path: '/srv/code' },
    ])
    expect(crumbs('/srv', null)[0]).toEqual({ label: '/', path: '/' })
  })
})

describe('clone progress', () => {
  it('is the last line the terminal drew, without its escapes', () => {
    expect(lastLine('', 'Cloning into ')).toBe('Cloning into')
    expect(lastLine('Cloning into ', "'yantra'...\r\n")).toBe("Cloning into 'yantra'...")
    expect(lastLine('', 'remote: Counting\rremote: Compressing 40%\r')).toBe('remote: Compressing 40%')
    expect(lastLine('', '[32mReceiving objects: 71%[0m\r')).toBe('Receiving objects: 71%')
    expect(lastLine('', '\r\n')).toBe('')
  })
})
