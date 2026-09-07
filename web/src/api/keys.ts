/** One factory, hierarchical: `['workspaces']` is the list, and everything the
 *  daemon says about one workspace sits under `['workspaces', name, …]`, so a
 *  write invalidates by prefix rather than by remembering every key it touched.
 *  Every part is JSON-serialisable, which is what makes the keys stable. */
export type Window = { lines: number; before: number }

export const keys = {
  machines: () => ['machines'] as const,
  workspaces: () => ['workspaces'] as const,
  status: (name: string) => ['workspaces', name, 'status'] as const,
  spend: (name: string) => ['workspaces', name, 'spend'] as const,
  transcript: (name: string, window: Window) =>
    ['workspaces', name, 'transcript', window] as const,
  repair: (name: string) => ['workspaces', name, 'repair'] as const,
  sessions: () => ['sessions'] as const,
  /** The whole sweep, or one machine's report under it. */
  readiness: (machine?: string) =>
    machine === undefined
      ? (['readiness'] as const)
      : (['readiness', machine] as const),
  attention: () => ['attention'] as const,
  github: () => ['github'] as const,
  repos: () => ['repos'] as const,
  notifications: () => ['notifications'] as const,
  about: () => ['about'] as const,
  sshIdentity: () => ['ssh-identity'] as const,
  /** `null` is the machine's own `$HOME`, which only the far side can name. */
  dirs: (machine: string, path: string | null) =>
    ['machines', machine, 'dirs', path] as const,
  probe: (machine: string, path: string) =>
    ['machines', machine, 'probe', path] as const,
}
