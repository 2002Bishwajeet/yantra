import { describe, expect, it, vi } from 'vitest'
import type { Attached } from '@/api/socket'
import { ApiError } from '@/api/errors'
import type { Plan } from './form'
import { type Io, run } from './run'
import { advance, begin, next, type Event, type Stages } from './stages'

const plan: Plan = {
  name: 'quiet-otter',
  machine: 'cachyos-g14',
  path: '/home/biswa/Github/homelab-k8s',
  clone: { url: 'https://github.com/a/homelab-k8s.git', full_name: 'a/homelab-k8s' },
}

const socket: Attached = { send: () => {}, type: () => {}, resize: () => {}, close: () => {} }

/** The wire, with each stage answering at once. `exists` is what the probe
 *  says on each call in turn. */
function wire(over: Partial<Io> = {}, exists: boolean[] = [true]) {
  const lines: ((line: string) => void)[] = []
  const ends: ((refused: ApiError | null) => void)[] = []
  const io: Io = {
    clone: vi.fn(() => Promise.resolve({ machine: plan.machine, session: 'clone-homelab-k8s' })),
    attach: vi.fn((_session, onLine, onEnd) => {
      lines.push(onLine)
      ends.push(onEnd)
      return socket
    }),
    probe: vi.fn(() =>
      Promise.resolve({
        machine: plan.machine,
        path: plan.path,
        exists: exists.shift() ?? true,
        origin: null,
      }),
    ),
    create: vi.fn((body) => Promise.resolve({ ...body, startup: body.startup ?? null })),
    up: vi.fn(() => Promise.resolve({ machine: plan.machine, session: 'created' as const, launched: true, term: 'xterm' })),
    open: vi.fn(),
    sleep: () => Promise.resolve(),
    ...over,
  }
  return { io, lines, ends }
}

/** Every event the run emitted, and the stages it left behind. */
async function ran(io: Io, from: Stages = begin(true, null)) {
  const said: Event[] = []
  let stages = from
  await run(plan, from, io, (event) => {
    said.push(event)
    stages = advance(stages, event)
  }, () => true)
  return { said, stages }
}

describe('the four stages', () => {
  it('clones, creates, starts and opens, in that order', async () => {
    const { io } = wire()
    const { said, stages } = await ran(io)
    expect(said.filter((one) => one.type === 'done').map((one) => one.stage)).toEqual([
      'clone',
      'create',
      'start',
      'open',
    ])
    expect(stages.every((one) => one.state === 'done')).toBe(true)
    expect(io.clone).toHaveBeenCalledWith({
      machine: plan.machine,
      url: plan.clone?.url,
      path: plan.path,
    })
    expect(io.open).toHaveBeenCalledWith('quiet-otter')
  })

  it('skips the clone for a directory that is already there', async () => {
    const { io } = wire()
    const { said } = await ran(io, begin(false, 'already on cachyos-g14'))
    expect(io.clone).not.toHaveBeenCalled()
    expect(said[0]).toEqual({ type: 'running', stage: 'create' })
  })

  it('draws the clone’s last line while it probes for the directory', async () => {
    // Two probes, and then the screen is gone: the clone is still going.
    let probed = 0
    const { io, lines } = wire(
      {
        probe: vi.fn(() => {
          probed += 1
          lines[0]?.('remote: Compressing objects:  40%\r')
          return Promise.resolve({ machine: plan.machine, path: plan.path, exists: false, origin: null })
        }),
      },
      [],
    )
    const said: Event[] = []
    await run(plan, begin(true, null), io, (event) => said.push(event), () => probed < 2)
    expect(said).toContainEqual({
      type: 'progress',
      stage: 'clone',
      detail: 'remote: Compressing objects:  40%',
    })
  })

  it('a clone session that ends without the directory is refused, in its own words', async () => {
    const { io, lines, ends } = wire(
      {
        probe: vi.fn(() => {
          lines[0]?.('fatal: repository not found\r\n')
          ends[0]?.(null)
          return Promise.resolve({ machine: plan.machine, path: plan.path, exists: false, origin: null })
        }),
      },
      [],
    )
    const { stages } = await ran(io)
    const clone = stages.find((one) => one.id === 'clone')
    expect(clone?.state).toBe('refused')
    expect(clone?.error?.said).toBe('fatal: repository not found')
    expect(clone?.error?.describe()).toMatch(/is not on cachyos-g14/)
  })

  it('stops at the stage that was refused, and a retry runs from there', async () => {
    const refusal = new ApiError('refused', 'workspace `quiet-otter` already exists', { status: 409 })
    const { io } = wire({ create: vi.fn(() => Promise.reject(refusal)) })
    const { stages } = await ran(io)
    expect(stages.map((one) => one.state)).toEqual(['done', 'refused', 'waiting', 'waiting'])
    expect(io.up).not.toHaveBeenCalled()

    const after = advance(stages, { type: 'retry' })
    expect(next(after)).toBe('create')
    const second = await ran(wire().io, after)
    expect(second.stages.every((one) => one.state === 'done')).toBe(true)
    // The clone was done, so a retry does not clone again.
    expect(second.said.map((one) => (one.type === 'retry' ? 'retry' : one.stage))).not.toContain('clone')
  })

  it('says nothing after the screen has gone', async () => {
    const { io } = wire()
    const said: Event[] = []
    await run(plan, begin(true, null), io, (event) => said.push(event), () => false)
    expect(said).toEqual([])
    expect(io.open).not.toHaveBeenCalled()
  })
})
