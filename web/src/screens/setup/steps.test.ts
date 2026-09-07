import { describe, expect, it } from 'vitest'
import type { Machine, Readiness } from '@/api'
import { ApiError } from '@/api/errors'
import * as contract from '@/contract.gen'
import { github, line, machines, ready, remedy, sshKey, tailnet } from './steps'

const reading = { data: undefined, error: null, isPending: true }
const got = <T,>(data: T) => ({ data, error: null, isPending: false })
const broke = (error: Error) => ({ data: undefined, error, isPending: false })

const machine = (over: Partial<Machine> = {}): Machine => ({
  ...contract.machines.data[0]!,
  ...over,
})

const report = (checks: Readiness['checks']): Readiness => ({ machine: 'pi-5', checks })
const check = (name: string, state: string, detail = '') =>
  ({ check: name, state, detail }) as Readiness['checks'][number]

describe('the step each read makes', () => {
  it('reads while nothing has answered, and fails with the daemon words', () => {
    expect(tailnet(reading, 'http:')).toEqual({ status: 'todo', words: 'reading…' })
    const failed = tailnet(broke(new ApiError('refused', 'boom', { status: 503 })), 'http:')
    expect(failed.status).toBe('failed')
    expect(failed.words).toContain('boom')
  })

  it('names the tailnet and the scheme it was reached over', () => {
    expect(tailnet(got(contract.about), 'https:')).toEqual({
      status: 'done',
      words: '<tailnet>.ts.net, reached over HTTPS',
    })
    expect(tailnet(got({ ...contract.about, tailnet: null }), 'http:').status).toBe('todo')
  })

  /** A key the daemon has not made is a 404, which is a state of the step and
   *  not a failure of the read (api.ts). */
  it('reads a 404 on the identity as a key not created', () => {
    const missing = sshKey(broke(new ApiError('missing', 'no identity', { status: 404 })))
    expect(missing.status).toBe('todo')
    expect(missing.words).toContain('yantra ssh-identity')
    expect(sshKey(got(contract.sshIdentity))).toEqual({
      status: 'done',
      words: 'created on the appliance · SHA256:<fingerprint>',
    })
  })

  it('says who GitHub is signed in as, and that a flow is waiting', () => {
    expect(github(got(contract.github)).words).toContain('signed in as 2002Bishwajeet')
    expect(github(got(contract.disconnected)).status).toBe('todo')
    expect(github(got({ ...contract.disconnected, pending: true }))).toEqual({
      status: 'progress',
      words: 'a sign-in is waiting at github.com',
    })
  })
})

describe("a machine's line", () => {
  it('is unreachable before ssh, with the age of the last sighting', () => {
    const off = line(machine({ online: false }), null, '3h')
    expect(off).toEqual({
      kind: 'unreachable',
      words: 'unreachable · last seen 3h ago · nothing behind ssh could be asked',
    })
  })

  it('is unchecked while no report exists, because a check costs a round trip', () => {
    expect(line(machine(), null, null)).toEqual({ kind: 'unchecked' })
  })

  /** `doctor::diagnose()` separates these, and the remedy differs: a refused
   *  key is one line to paste, an unanswered host is not. */
  it('separates a refused key from a host that did not answer', () => {
    const refused = report([check('reachable', 'absent', 'Permission denied (publickey)')])
    expect(line(machine(), refused, null)).toEqual({ kind: 'refused' })
    const silent = report([check('reachable', 'absent', 'No route to host')])
    expect(line(machine(), silent, null)).toEqual({
      kind: 'unreachable',
      words: 'unreachable · No route to host',
    })
  })

  it('is ready when every check is present, and names the ones that matter', () => {
    const all = report([
      check('reachable', 'present'),
      check('sshd', 'present'),
      check('tmux', 'present'),
      check('agent-cli', 'present'),
    ])
    const one = line(machine(), all, null)
    expect(one).toEqual({ kind: 'ready', present: 4, total: 4, words: 'sshd, tmux, claude' })
    expect(ready(one)).toBe(true)
  })

  it('names what is missing and what could not be asked, in the board words', () => {
    const some = report([
      check('reachable', 'present'),
      check('tmux', 'absent'),
      check('provider-auth', 'unknown'),
    ])
    expect(line(machine(), some, null)).toEqual({
      kind: 'missing',
      present: 1,
      total: 3,
      words: 'missing tmux · could not ask about gh signed in',
    })
  })
})

describe('the machines step', () => {
  const named = (kind: string, name: string) => ({ machine: name, line: { kind } as never })

  it('has nothing to check when the tailnet lists no machine', () => {
    expect(machines([]).words).toContain('nothing to check')
  })

  it('waits while every machine is unchecked', () => {
    expect(machines([named('unchecked', 'pi-5')])).toEqual({
      status: 'todo',
      words: 'not checked yet · Check asks a machine over ssh',
    })
  })

  it('counts the ready ones and names the rest', () => {
    const some = machines([
      { machine: 'pi-5', line: { kind: 'ready', present: 2, total: 2, words: 'tmux' } },
      named('refused', 'nas'),
    ])
    expect(some).toEqual({
      status: 'progress',
      words: '1 of 2 machines ready · nas does not yet',
    })
    const all = machines([
      { machine: 'pi-5', line: { kind: 'ready', present: 2, total: 2, words: 'tmux' } },
    ])
    expect(all).toEqual({ status: 'done', words: '1 of 1 machines ready' })
  })
})

it('puts the real key in the line a refused machine needs run on it', () => {
  expect(remedy('ssh-ed25519 AAAA yantra')).toBe(
    "echo 'ssh-ed25519 AAAA yantra' >> ~/.ssh/authorized_keys",
  )
})
