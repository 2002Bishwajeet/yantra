import { describe, expect, it } from 'vitest'
import type { Repo } from '@/api'
import {
  cloneInto,
  complete,
  happenings,
  nameError,
  plan,
  reachable,
  repoName,
  slug,
  tilde,
  type Values,
} from './form'
import { generateName } from './words'

const repo: Repo = {
  full_name: '2002Bishwajeet/homelab-k8s',
  private: true,
  language: 'YAML',
  pushed_at: '2026-09-01T10:00:00Z',
  clone_url: 'https://github.com/2002Bishwajeet/homelab-k8s.git',
  default_branch: 'main',
}

const values = (over: Partial<Values> = {}): Values => ({
  name: 'quiet-otter',
  named: false,
  machine: 'cachyos-g14',
  provider: 'github',
  source: null,
  opens: 'claude',
  command: '',
  ...over,
})

const cloned = (here: 'yes' | 'no' | 'unknown') =>
  values({ source: { kind: 'github', repo, path: '/home/biswa/Github/homelab-k8s', here } })

describe('the name', () => {
  it('refuses what the daemon would refuse, and says what it takes', () => {
    expect(nameError('quiet-otter')).toBeUndefined()
    expect(nameError('')).toBe('A session needs a name.')
    expect(nameError('quiet otter')).toMatch(/letters, digits/)
    expect(nameError('quiet.otter')).toMatch(/letters, digits/)
  })

  it('generates a word pair the daemon would take', () => {
    expect(generateName(() => 0)).toBe('quiet-otter')
    // Every pair the two lists can make is usable.
    for (const roll of [0, 0.3, 0.7, 0.999]) {
      expect(nameError(generateName(() => roll))).toBeUndefined()
    }
  })
})

describe('what each step needs before it can be left', () => {
  it('step 1 wants a usable name and a machine', () => {
    expect(complete(1, values())).toBe(true)
    expect(complete(1, values({ name: 'quiet otter' }))).toBe(false)
    expect(complete(1, values({ machine: '' }))).toBe(false)
  })

  it('step 2 takes a repository that is not on the machine — that is the clone', () => {
    expect(complete(2, values())).toBe(false)
    expect(complete(2, cloned('yes'))).toBe(true)
    expect(complete(2, cloned('no'))).toBe(true)
    expect(complete(2, cloned('unknown'))).toBe(true)
  })

  it('step 2 blocks only a directory proven absent', () => {
    const local = (checked: 'yes' | 'no' | 'unknown') =>
      values({ source: { kind: 'local', path: '/home/biswa/x', origin: null, checked } })
    expect(complete(2, local('yes'))).toBe(true)
    expect(complete(2, local('unknown'))).toBe(true)
    expect(complete(2, local('no'))).toBe(false)
  })

  it('step 3 wants a command when a command is what opens', () => {
    expect(complete(3, cloned('no'))).toBe(true)
    expect(complete(3, values({ opens: 'command' }))).toBe(false)
    expect(complete(3, values({ opens: 'command', command: ' just dev ' }))).toBe(true)
  })

  it('reaches only as far as the values allow', () => {
    expect(reachable(values({ name: '' }))).toBe(1)
    expect(reachable(values())).toBe(2)
    expect(reachable({ ...cloned('no'), opens: 'command' })).toBe(3)
    expect(reachable(cloned('no'))).toBe(4)
  })
})

describe('the plan the starting screen runs', () => {
  it('clones only a repository the machine does not have', () => {
    expect(plan(cloned('no'))?.clone).toEqual({
      url: repo.clone_url,
      full_name: repo.full_name,
    })
    expect(plan(cloned('yes'))?.clone).toBeNull()
    expect(plan(cloned('unknown'))?.clone).toBeNull()
  })

  it('sends a startup only for a command, and never an unfinished form', () => {
    expect(plan(cloned('yes'))?.startup).toBeUndefined()
    expect(plan({ ...cloned('yes'), opens: 'command', command: 'just dev ' })?.startup).toBe('just dev')
    expect(plan(values())).toBeNull()
  })
})

describe('what will happen', () => {
  it('names the clone, the session and what opens in it', () => {
    const lines = happenings({ ...cloned('no'), opens: 'command', command: 'just dev' }, '/home/biswa')
    expect(lines[0]).toBe('write ~/.config/yantra/workspaces/quiet-otter.toml')
    expect(lines[1]).toBe('clone 2002Bishwajeet/homelab-k8s into ~/Github/homelab-k8s on cachyos-g14')
    expect(lines[2]).toBe('open a tmux session on cachyos-g14 in ~/Github/homelab-k8s')
    expect(lines[3]).toMatch(/^run just dev in it/)
  })

  it('says a directory that is already there is already there', () => {
    const lines = happenings(cloned('yes'), '/home/biswa')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/which is already there$/)
    expect(lines[2]).toMatch(/^start Claude/)
  })
})

describe('paths', () => {
  it('writes a clone home under the provider, and a path as the boards write it', () => {
    expect(repoName(repo)).toBe('homelab-k8s')
    expect(cloneInto('/home/biswa', repo)).toBe('/home/biswa/Github/homelab-k8s')
    expect(tilde('/home/biswa/Github/x', '/home/biswa')).toBe('~/Github/x')
    expect(tilde('/home/biswa', '/home/biswa')).toBe('~')
    expect(tilde('/srv/x', '/home/biswa')).toBe('/srv/x')
    expect(tilde('/srv/x', null)).toBe('/srv/x')
  })

  it('reads an origin as owner/name, however it was written', () => {
    expect(slug('https://github.com/2002Bishwajeet/yantra.git')).toBe('2002Bishwajeet/yantra')
    expect(slug('git@github.com:2002Bishwajeet/yantra.git')).toBe('2002Bishwajeet/yantra')
    expect(slug('https://gitlab.com/group/thing/')).toBe('group/thing')
  })
})
