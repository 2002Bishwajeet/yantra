// Test fixtures only: nothing under `routes/` or `components/` imports this.
// The generated ones are responses yantrad really rendered; the builders are
// for a test that needs one field to differ.
import type { Beat, Listed, Looked, Machine, Workspace } from '@/api'

export * from '@/contract.gen'

export function aBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    age_seconds: 3,
    arch: 'x86_64',
    labels: ['gpu', 'cuda', 'docker'],
    free_ram_mb: 19942,
    free_disk_mb: 214003,
    cpu_busy_pct: 15,
    power: 'ac',
    ...overrides,
  }
}

export function aMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    name: 'cachyos-g14',
    dns_name: 'cachyos-g14.<tailnet>.ts.net.',
    os: 'linux',
    online: true,
    expired: false,
    last_seen: '2026-07-07T09:00:00Z',
    heartbeat: aBeat(),
    ...overrides,
  }
}

export function aWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    name: 'yantra',
    machine: 'cachyos-g14',
    repo: '/home/<user>/Github/homelab/yantra',
    startup: null,
    ...overrides,
  }
}

/** As `GET /api/workspaces` lists one, which since Y-141 says it loaded. */
export const aListed = (workspace: Workspace = aWorkspace()): Listed => ({
  loaded: 'yes',
  ...workspace,
})

export const looked = {
  ok: <T,>(data: T, age_seconds = 0): Looked<T> => ({
    looked: 'ok',
    age_seconds,
    data,
  }),
  failed: <T,>(error: string, age_seconds = 0): Looked<T> => ({
    looked: 'failed',
    age_seconds,
    error,
  }),
  never: <T,>(): Looked<T> => ({ looked: 'never' }),
}
