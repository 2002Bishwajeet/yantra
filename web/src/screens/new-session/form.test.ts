import { describe, expect, it } from 'vitest'
import type { Machine, Readiness, Repo } from '@/api'
import {
  cloneInto,
  complete,
  expand,
  hubJoined,
  knownWorkspace,
  nameError,
  next,
  offered,
  pickMachine,
  plan,
  reachable,
  repoName,
  soleMachine,
  slug,
  sourceHint,
  tilde,
  type Values,
} from './form'
import { aMachine, aWorkspace } from '@/api/fixtures'
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
  it('marks only a local source, the one that remembers its folder', () => {
    expect(plan(cloned('yes'))?.local).toBeUndefined()
    expect(plan(cloned('no'))?.local).toBeUndefined()
  })

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

describe('the one line step 3 adds', () => {
  const local = (checked: 'yes' | 'unknown') =>
    values({ source: { kind: 'local', path: '/home/biswa/Github/x', origin: null, checked } })

  it('names the repository it clones first', () => {
    expect(next(cloned('no'))).toBe('Clones 2002Bishwajeet/homelab-k8s first.')
  })

  it('says nothing about a folder that is there', () => {
    expect(next(cloned('yes'))).toBeNull()
    expect(next(local('yes'))).toBeNull()
  })

  it('says Yantra checks a folder it has not checked', () => {
    expect(next(cloned('unknown'))).toBe('Yantra checks the folder first.')
    expect(next(local('unknown'))).toBe('Yantra checks the folder first.')
  })

  it('says nothing before a source is chosen', () => {
    expect(next(values())).toBeNull()
  })
})

describe('paths', () => {
  it('writes a clone under the clone folder, and a path as the boards write it', () => {
    expect(repoName(repo)).toBe('homelab-k8s')
    expect(cloneInto('/home/biswa/Documents/Github', repo)).toBe('/home/biswa/Documents/Github/homelab-k8s')
    expect(tilde('/home/biswa/Github/x', '/home/biswa')).toBe('~/Github/x')
    expect(tilde('/home/biswa', '/home/biswa')).toBe('~')
    expect(tilde('/srv/x', '/home/biswa')).toBe('/srv/x')
    expect(tilde('/srv/x', null)).toBe('/srv/x')
  })

  it('draws a path with ~ when home carries a trailing slash', () => {
    expect(tilde('/Users/biswa/Github/x', '/Users/biswa/')).toBe('~/Github/x')
    expect(tilde('/Users/biswa', '/Users/biswa/')).toBe('~')
  })

  it('expands ~ and ~/x under home, and leaves other paths alone', () => {
    expect(expand('~', '/home/biswa')).toBe('/home/biswa')
    expect(expand('~/Github/yantra', '/home/biswa')).toBe('/home/biswa/Github/yantra')
    expect(expand('~/x', '/home/biswa/')).toBe('/home/biswa/x')
    expect(expand('/srv/x', '/home/biswa')).toBe('/srv/x')
    expect(expand('~other/x', '/home/biswa')).toBe('~other/x')
    expect(expand('~/x', null)).toBeNull()
    expect(expand('/srv/x', null)).toBe('/srv/x')
  })

  it('reads an origin as owner/name, however it was written', () => {
    expect(slug('https://github.com/2002Bishwajeet/yantra.git')).toBe('2002Bishwajeet/yantra')
    expect(slug('git@github.com:2002Bishwajeet/yantra.git')).toBe('2002Bishwajeet/yantra')
    expect(slug('https://gitlab.com/group/thing/')).toBe('group/thing')
  })
})

describe('pickMachine', () => {
  const one = (name: string, over: Partial<Machine> = {}) => aMachine({ name, ...over })
  const list = [
    one('up'),
    one('down', { online: false }),
    one('old', { expired: true }),
    one('theirs', { ownership: 'shared' }),
  ]

  it('keeps a machine that is yours, online and current', () => {
    expect(pickMachine('up', list)).toBe('up')
  })

  it.each(['down', 'old', 'theirs', 'gone', ''])('drops %j', (given) => {
    expect(pickMachine(given, list)).toBe('')
  })
})

describe('soleMachine', () => {
  const one = (name: string, over: Partial<Machine> = {}) => aMachine({ name, ...over })

  it('is empty for no machine', () => {
    expect(soleMachine([])).toBe('')
  })

  it('names the one machine that can be pressed', () => {
    expect(soleMachine([one('pi')])).toBe('pi')
  })

  it('is empty for two', () => {
    expect(soleMachine([one('pi'), one('box')])).toBe('')
  })

  it('skips the unreachable, expired and shared ones', () => {
    const list = [one('down', { online: false }), one('old', { expired: true }), one('theirs', { ownership: 'shared' }), one('up')]
    expect(soleMachine(list)).toBe('up')
  })
})

describe('the hint under the source step', () => {
  const home = '/home/biswa'
  const at = (here: 'yes' | 'no' | 'unknown') =>
    values({ source: { kind: 'github', repo, path: '/home/biswa/Github/homelab-k8s', here } })
  const local = (checked: 'yes' | 'no' | 'unknown') =>
    values({ provider: 'local', source: { kind: 'local', path: '/srv/x', origin: null, checked } })

  it('says what to choose when nothing is chosen', () => {
    expect(sourceHint(values(), home)).toBe('Choose a repository to continue.')
    expect(sourceHint(values({ provider: 'local' }), home)).toBe('Choose a folder that exists to continue.')
  })

  it('stays silent when no repository list is on screen', () => {
    expect(sourceHint(values(), home, false)).toBeNull()
    expect(sourceHint(values({ provider: 'local' }), home, false)).toBe('Choose a folder that exists to continue.')
  })

  it('says what a chosen repository will do', () => {
    expect(sourceHint(at('no'), home)).toBe('Will clone into ~/Github/homelab-k8s')
    expect(sourceHint(at('yes'), home)).toBe('On cachyos-g14 at ~/Github/homelab-k8s')
    expect(sourceHint(at('unknown'), home)).toBe('Not checked. Will try ~/Github/homelab-k8s')
  })

  it('blocks only a folder proven absent', () => {
    expect(sourceHint(local('no'), home)).toBe('Choose a folder that exists to continue.')
    expect(sourceHint(local('yes'), home)).toBeNull()
    expect(sourceHint(local('unknown'), home)).toBeNull()
  })
})

describe('the hub in New session', () => {
  const hub = aMachine({ name: 'yantra-box', hub: true })
  const report = (detail: string, state: 'present' | 'absent'): Readiness => ({
    machine: hub.name,
    age_seconds: 0,
    checks: [{ check: 'reachable', state, detail }],
  })
  const joined = report('', 'present')

  it('has joined when it is online and ssh gets in', () => {
    expect(hubJoined(hub, joined)).toBe(true)
  })

  it.each([
    ['refused', report('Permission denied (publickey)', 'absent')],
    ['unjoined', report('the ssh config here names no account for yantra-box', 'absent')],
    ['no report', null],
  ])('has not joined when %s', (_why, given) => {
    expect(hubJoined(hub, given)).toBe(false)
  })

  it('has not joined when it is offline, whatever an old report says', () => {
    expect(hubJoined({ ...hub, online: false }, joined)).toBe(false)
  })

  it('drops only a hub that has not joined', () => {
    const other = aMachine({ name: 'cachyos-g14' })
    expect(offered([hub, other], [null, null])).toEqual([other])
    expect(offered([hub, other], [joined, null])).toEqual([hub, other])
  })
})

describe('knownWorkspace', () => {
  const mine = aWorkspace({ name: 'k8s', machine: 'cachyos-g14', repo: '/home/biswa/Github/homelab-k8s' })
  const found = (over: Partial<Values> = {}) => knownWorkspace({ ...cloned('yes'), ...over }, [mine])

  it('finds the workspace on the same machine and path', () => {
    expect(found()).toBe(mine)
  })

  it('ignores a trailing slash on either side', () => {
    expect(knownWorkspace(cloned('yes'), [{ ...mine, repo: `${mine.repo}/` }])).toBeTruthy()
    const typed = values({ source: { kind: 'local', path: `${mine.repo}/`, origin: null, checked: 'yes' } })
    expect(knownWorkspace(typed, [mine])).toBe(mine)
  })

  it('finds nothing on another machine, on another path, or with no source', () => {
    expect(found({ machine: 'macbook' })).toBeNull()
    expect(knownWorkspace(values({ source: { kind: 'local', path: '/home/biswa/other', origin: null, checked: 'yes' } }), [mine])).toBeNull()
    expect(knownWorkspace(values(), [mine])).toBeNull()
  })
})
