// D3 §10's case: ten workspaces and three machines, drawn so every mark and
// every tone D3 §6 names is on the page at once. Shapes follow
// `src/contract.gen.ts`, which the daemon rendered.
import type {
  Attention,
  Listed,
  Looked,
  Machine,
  MachineSessions,
  WorkspaceStatus,
} from '@/api'

const ok = <T>(data: T, age_seconds = 0): Looked<T> => ({
  looked: 'ok',
  age_seconds,
  data,
})

const machines: Looked<Machine[]> = ok([
  {
    name: 'cachyos-g14',
    dns_name: 'cachyos-g14.<tailnet>.ts.net.',
    os: 'linux',
    online: true,
    expired: false,
    last_seen: null,
    heartbeat: {
      age_seconds: 4,
      arch: 'x86_64',
      cpu_busy_pct: 23,
      free_disk_mb: 214003,
      free_ram_mb: 19942,
      labels: ['gpu', 'docker'],
      power: 'ac',
    },
  },
  {
    name: 'bishwajeets-macbook-pro',
    dns_name: 'bishwajeets-macbook-pro.<tailnet>.ts.net.',
    os: 'macos',
    online: true,
    expired: false,
    last_seen: null,
    heartbeat: {
      age_seconds: 9,
      arch: 'aarch64',
      cpu_busy_pct: 61,
      free_disk_mb: 88210,
      free_ram_mb: 6120,
      labels: [],
      power: { battery: { percent: 42 } },
    },
  },
  {
    name: 'pi',
    dns_name: 'pi.<tailnet>.ts.net.',
    os: 'linux',
    online: true,
    expired: false,
    last_seen: null,
    heartbeat: null,
  },
])

const list = (
  name: string,
  machine: string,
  startup: string | null = null,
): Listed => ({
  loaded: 'yes',
  name,
  machine,
  repo: `/home/<user>/Github/${name}`,
  startup,
})

const workspaces: Looked<Listed[]> = ok([
  list('yantra', 'cachyos-g14'),
  list('site', 'bishwajeets-macbook-pro'),
  list('api', 'cachyos-g14'),
  list('infra', 'pi'),
  list('homelab', 'pi'),
  list('notes', 'bishwajeets-macbook-pro', 'nvim'),
  list('docs', 'cachyos-g14'),
  list('chat', 'bishwajeets-macbook-pro'),
  list('blog', 'cachyos-g14', 'npm run dev'),
  list('scratch', 'cachyos-g14'),
])

const sessions: Looked<MachineSessions[]> = ok(
  [
    {
      machine: 'cachyos-g14',
      reached: 'yes',
      sessions: [
        { name: 'yantra', windows: 2, attached: 1, created: 'Thu Sep  3 09:12:31 2026' },
        { name: 'api', windows: 1, attached: 0, created: 'Fri Sep  4 11:40:02 2026' },
        { name: 'scratch', windows: 1, attached: 0, created: 'Fri Sep  4 13:05:55 2026' },
        { name: 'tmp', windows: 1, attached: 0, created: 'Fri Sep  4 14:20:10 2026' },
      ],
    },
    {
      machine: 'bishwajeets-macbook-pro',
      reached: 'yes',
      sessions: [
        { name: 'site', windows: 1, attached: 0, created: 'Fri Sep  4 08:02:14 2026' },
        { name: 'notes', windows: 3, attached: 1, created: 'Wed Sep  2 18:30:00 2026' },
      ],
    },
    {
      machine: 'pi',
      reached: 'no',
      error: 'ssh to pi failed before the command reported a status: connect to host pi port 22: Connection refused',
    },
  ],
  12,
)

const reached = (
  workspace: string,
  machine: string,
  status: Extract<WorkspaceStatus, { reached: 'yes' }>['status'],
  session: { id: string; pid: number } | null = null,
): WorkspaceStatus => ({ workspace, machine, reached: 'yes', status, session })

const statuses: Record<string, WorkspaceStatus> = {
  yantra: reached('yantra', 'cachyos-g14', { state: 'running' }, {
    id: '1f0c1a2e-4c2b-4f7a-9a1d-3f0c2b8e7d61',
    pid: 48213,
  }),
  site: reached('site', 'bishwajeets-macbook-pro', { state: 'awaiting_trust' }),
  api: reached('api', 'cachyos-g14', { state: 'crashed', exit_status: 1 }),
  infra: {
    workspace: 'infra',
    machine: 'pi',
    reached: 'no',
    error: 'ssh to pi failed before the command reported a status: connect to host pi port 22: Connection refused',
  },
  homelab: {
    workspace: 'homelab',
    machine: 'pi',
    reached: 'no',
    error: 'ssh to pi failed before the command reported a status: connect to host pi port 22: Connection refused',
  },
  notes: reached('notes', 'bishwajeets-macbook-pro', { state: 'no_agent' }),
  docs: reached('docs', 'cachyos-g14', { state: 'finished' }),
  chat: reached('chat', 'bishwajeets-macbook-pro', { state: 'stopped' }),
  blog: reached('blog', 'cachyos-g14', { state: 'no_session' }),
  scratch: reached('scratch', 'cachyos-g14', {
    state: 'unclear',
    because: 'the pane is alive but claude knows of no agent in that directory',
  }),
}

const attention: Looked<Attention> = ok(
  {
    reviews: [
      {
        number: 54,
        repo: 'utopia-php/messaging',
        title: 'feat: add the APNs adapter',
        updated_at: '2026-09-03T09:12:44Z',
        url: 'https://github.com/utopia-php/messaging/pull/54',
      },
    ],
    issues: [
      {
        number: 1459,
        repo: 'homebase-id/chat-kmp',
        title: 'Vault: "Note" in the add sheet does nothing when appending to an existing entry',
        updated_at: '2026-09-02T13:11:53Z',
        url: 'https://github.com/homebase-id/chat-kmp/issues/1459',
      },
      {
        number: 118,
        repo: '2002Bishwajeet/yantra',
        title: 'the fleet page draws an empty table while nobody has looked',
        updated_at: '2026-08-11T18:09:33Z',
        url: 'https://github.com/2002Bishwajeet/yantra/issues/118',
      },
    ],
    notifications: 7,
  },
  140,
)

/** What `/api` answers, by path. A miss is the daemon's own JSON 404 (I-64). */
export function answer(path: string): { status: number; body: unknown } {
  if (path === '/api/machines') return { status: 200, body: machines }
  if (path === '/api/workspaces') return { status: 200, body: workspaces }
  if (path === '/api/sessions') return { status: 200, body: sessions }
  if (path === '/api/attention') return { status: 200, body: attention }
  if (path === '/api/viewing') return { status: 204, body: null }
  const status = /^\/api\/workspaces\/([^/]+)\/status$/.exec(path)
  if (status) {
    const one = statuses[decodeURIComponent(status[1]!)]
    return one
      ? { status: 200, body: ok(one, 6) }
      : { status: 404, body: { error: `no workspace named ${status[1]}` } }
  }
  return { status: 404, body: { error: `nothing is at ${path}` } }
}
