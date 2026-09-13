import { describe, expect, it } from 'vitest'
import type { Machine, Readiness } from '@/api'
import { ApiError } from '@/api/errors'
import * as contract from '@/contract.gen'
import { joinCommand, joinUrl } from '@/lib/join'
import { added, github, line, machines, push, ready, tailnet } from './steps'

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

/** The seven checks a session needs (`lib/ready`), each in the state given. */
const needs = (over: Record<string, string> = {}) =>
  ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session'].map((name) => check(name, over[name] ?? 'present'))

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

  /** D7 §4.1 step 2: a join, which also makes the key (ADR-0029). */
  it('is done at the first machine that joined, and names no command before it', () => {
    const none = added([])
    expect(none).toEqual({ status: 'todo', words: 'no machine has joined yet · Add a device shows the steps' })
    expect(none.words).not.toMatch(/yantra|`/)
    expect(added(['pi-5', 'nas'])).toEqual({ status: 'done', words: 'pi-5, nas joined' })
  })

  /** With no key made, ssh that gets in used the account's own keys. */
  it("says a machine ssh reaches without Yantra's key is not joined, and what to run", () => {
    expect(added([], ['pi-5'])).toEqual({
      status: 'todo',
      words: "pi-5 reached without Yantra's key · run the join command on it once",
    })
    expect(added([], ['pi-5', 'nas']).words).toBe("pi-5, nas reached without Yantra's key · run the join command on each once")
    expect(added(['pi-5'], ['nas']).status).toBe('done')
  })

  it('says who GitHub is signed in as, and that a flow is waiting', () => {
    expect(github(got(contract.github)).words).toContain('signed in as 2002Bishwajeet')
    expect(github(got(contract.disconnected)).status).toBe('todo')
    expect(github(got({ ...contract.disconnected, pending: true }))).toEqual({
      status: 'progress',
      words: 'a sign-in is waiting at github.com',
    })
  })

  /** ADR-0021: a relay saved in Settings is the next start's, so the step
   *  reads what the running daemon holds. */
  it('reads the relay the daemon holds, and fails with the daemon words', () => {
    expect(push(got({ ...contract.about, relay: true }))).toEqual({
      status: 'done',
      words: 'the daemon holds a relay and pushes to it',
    })
    const none = push(got({ ...contract.about, relay: false }))
    expect(none.status).toBe('todo')
    expect(none.words).toContain('after yantrad restarts')
    expect(push(reading)).toEqual({ status: 'todo', words: 'reading…' })
    const failed = push(broke(new ApiError('network', 'down')))
    expect(failed.status).toBe('failed')
  })
})

describe("a machine's line", () => {
  /** D7 §3.3: off is asleep, which is normal and never an error. */
  it('is asleep before ssh, with the age of the last sighting', () => {
    expect(line(machine({ online: false }), null, '3h')).toEqual({ kind: 'asleep', since: '3h' })
  })

  it('is unchecked while no report exists, because a check costs a round trip', () => {
    expect(line(machine(), null, null)).toEqual({ kind: 'unchecked' })
  })

  /** `doctor::diagnose()` separates these, and the remedy differs: a refused
   *  key is the join command, an unanswered host is not. */
  it('separates a refused key from a host that did not answer', () => {
    const refused = report([check('reachable', 'absent', 'Permission denied (publickey)')])
    expect(line(machine(), refused, null)).toEqual({ kind: 'refused' })
    const silent = report([check('reachable', 'absent', 'No route to host')])
    expect(line(machine(), silent, null)).toEqual({
      kind: 'unreachable',
      words: 'ssh did not answer · No route to host',
    })
  })

  it('is ready when the seven checks a session needs are present', () => {
    const one = line(machine(), report(needs()), null)
    expect(one).toEqual({ kind: 'ready', present: 7, total: 7 })
    expect(ready(one)).toBe(true)
  })

  /** GitHub and `yantra-agent` are optional, so neither holds ready back. */
  it('is ready with gh missing and no heartbeat, and counts every check it shows', () => {
    const optional = report([...needs(), check('provider-auth', 'absent'), check('heartbeat', 'absent')])
    expect(line(machine(), optional, null)).toEqual({ kind: 'ready', present: 7, total: 9 })
  })

  /** Install is not what fixes terminfo (D7 §3.5). */
  it('is not ready while a check a session needs is missing, and says whether Install fixes it', () => {
    expect(line(machine(), report(needs({ terminfo: 'absent' })), null)).toMatchObject({
      kind: 'missing',
      words: 'missing terminfo',
      installable: false,
    })
  })

  it('names only the checks that hold ready back, and whether Install fixes them', () => {
    const some = report([...needs({ tmux: 'absent', 'login-session': 'unknown' }), check('provider-auth', 'unknown')])
    expect(line(machine(), some, null)).toEqual({
      kind: 'missing',
      present: 5,
      total: 8,
      words: 'missing tmux · could not ask about claude signed in',
      installable: true,
    })
  })
})

describe('the ready step', () => {
  const named = (kind: string, name: string) => ({ machine: name, line: { kind } as never })
  const up = (name: string) => ({ machine: name, line: { kind: 'ready', present: 2, total: 2 } as const })

  it('has nothing to check when the tailnet lists no machine that runs a session', () => {
    expect(machines([])).toEqual({ status: 'todo', words: 'this tailnet lists no machine that runs Linux or macOS' })
  })

  it('waits while every machine is unchecked', () => {
    expect(machines([named('unchecked', 'pi-5')])).toEqual({
      status: 'todo',
      words: 'not checked yet · Check asks a machine over ssh',
    })
  })

  it('is in progress while the machines it knows are none of them ready', () => {
    expect(machines([named('refused', 'nas'), named('asleep', 'pi-5')])).toEqual({
      status: 'progress',
      words: '0 of 2 machines ready · one ready machine finishes this step',
    })
  })

  /** Walk-through Q2.3: an asleep laptop does not hold back a first session. */
  it('is done at one ready machine, and lists the rest without waiting on them', () => {
    expect(machines([up('pi-5'), named('refused', 'nas'), named('unchecked', 'macbook')])).toEqual({
      status: 'done',
      words: '1 of 3 machines ready · one is enough to start',
    })
    expect(machines([up('pi-5')])).toEqual({ status: 'done', words: '1 of 1 machines ready' })
  })
})

describe('the join command', () => {
  /** On HTTPS the page came through `tailscale serve` on 8443, which forwards
   *  `/join` as well (ADR-0029, consequences). */
  it('is the page origin on HTTPS', () => {
    const page = { protocol: 'https:', origin: 'https://yantra.tail3a1b.ts.net:8443' }
    expect(joinUrl(page, undefined)).toBe('https://yantra.tail3a1b.ts.net:8443/join')
  })

  it("is the daemon's bound address on HTTP, and nothing until that is read", () => {
    const page = { protocol: 'http:', origin: 'http://100.64.0.1:7717' }
    expect(joinUrl(page, contract.about)).toBe('http://100.64.0.1:7717/join')
    expect(joinUrl(page, undefined)).toBeNull()
    expect(joinUrl(page, { ...contract.about, listening_on: [] })).toBeNull()
  })

  it('pipes the script to sh', () => {
    expect(joinCommand('http://100.64.0.1:7717/join')).toBe('curl -fsSL http://100.64.0.1:7717/join | sh')
  })
})
