/*
 * The typed failures adapt T3 Code's git action logic, cut to commit, push and PR:
 * https://github.com/pingdotgg/t3code/blob/1451e7c/apps/web/src/components/GitActionsControl.logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { asApiError } from '@/api/errors'

export type GitAction = 'draft' | 'commit' | 'push' | 'pr'

/** One kind per action and status the daemon sends (Y-492, Y-449), then the three any action meets. */
export type GitFailureKind =
  | 'turnRunning'
  | 'draftNothing'
  | 'noLogin'
  | 'draftClaude'
  | 'draftTimeout'
  | 'commitEmpty'
  | 'commitRefused'
  | 'pushRefused'
  | 'prRefused'
  | 'prGithub'
  | 'noThread'
  | 'unreachable'
  | 'network'
  // A status the daemon does not send for this action: a 500, a 403, a body this page cannot read.
  | 'other'

const words: Record<GitFailureKind, { title: string; next: string }> = {
  turnRunning: {
    title: 'A turn is running',
    next: 'The agent or a revert is writing to the branch. Wait for the turn or the revert to end, then try again.',
  },
  draftNothing: {
    title: 'Nothing to commit',
    next: 'The thread has no changes. Ask the agent for a change, then draft again.',
  },
  noLogin: {
    title: 'The Mac has no login tmux server',
    next: 'Start one on the Mac with `tmux new-session -d`, then try again.',
  },
  draftClaude: {
    title: 'The draft failed',
    next: 'claude could not write a message on the machine. Draft again, or write the message yourself.',
  },
  draftTimeout: {
    title: 'The draft timed out',
    next: 'claude took more than five minutes. Draft again, or write the message yourself.',
  },
  commitEmpty: { title: 'The message is empty', next: 'Write a message, then commit.' },
  commitRefused: {
    title: 'The commit was refused',
    next: 'The machine has no git identity, or nothing changed. Set user.name and user.email there, or change a file.',
  },
  pushRefused: {
    title: 'The push was refused',
    next: 'The branch has no origin, or the remote turned the push away. Fix the remote on the machine, then push again.',
  },
  prRefused: {
    title: 'The pull request was refused',
    next: 'Push the branch first. It must match its upstream, the remote must be on github.com, and the daemon needs a GitHub grant.',
  },
  prGithub: {
    title: 'GitHub failed',
    next: 'GitHub did not take the pull request. Try again in a moment.',
  },
  noThread: { title: 'No such thread', next: 'The workspace holds no thread by this id. Reload the chat.' },
  unreachable: {
    title: 'The machine did not answer',
    next: 'ssh or tmux on the machine failed, so nothing ran. Try again once it is back.',
  },
  network: { title: 'The daemon did not answer', next: 'Nothing ran. Check the network, then try again.' },
  other: { title: 'The action failed', next: 'The daemon says why below.' },
}

const byStatus: Record<GitAction, Partial<Record<number, GitFailureKind>>> = {
  draft: { 502: 'draftClaude', 504: 'draftTimeout' },
  commit: { 400: 'commitEmpty', 409: 'commitRefused' },
  push: { 409: 'pushRefused' },
  pr: { 409: 'prRefused', 502: 'prGithub' },
}

/** What `ErrorSurface` draws: `describe()` is the next step, `said` the daemon's own words. */
export class GitFailure {
  readonly kind: GitFailureKind
  readonly said: string
  readonly retryable: boolean

  constructor(kind: GitFailureKind, said: string) {
    this.kind = kind
    this.said = said
    // A missing thread does not appear by asking again, and an empty message is mended by typing.
    this.retryable = kind !== 'noThread' && kind !== 'commitEmpty'
  }

  get title(): string {
    return words[this.kind].title
  }

  describe(): string {
    return words[this.kind].next
  }
}

// The daemon sends one 409 for several causes (write.rs idle, commit::Error); only its words tell them apart.
function conflict(action: GitAction, said: string): GitFailureKind {
  if (/running/i.test(said)) return 'turnRunning'
  if (/tmux server/i.test(said)) return 'noLogin'
  if (action === 'draft') return /nothing to commit/i.test(said) ? 'draftNothing' : 'other'
  return byStatus[action][409] ?? 'other'
}

export function gitFailure(action: GitAction, cause: unknown): GitFailure {
  const error = asApiError(cause)
  const kind: GitFailureKind =
    error.kind === 'network'
      ? 'network'
      : error.status === 404
        ? 'noThread'
        : error.status === 503
          ? 'unreachable'
          : error.status === 409 && action !== 'pr'
            ? conflict(action, error.said)
            : ((error.status !== undefined && byStatus[action][error.status]) || 'other')
  return new GitFailure(kind, error.said)
}

/** Why a control is off, or null when it is on. The sr-only description says this. */
export function whyOff(thread: string | null, busy: boolean): string | null {
  if (thread === null) return 'This chat has no thread yet. Send a first message.'
  if (busy) return 'A turn is running. Wait for it to end.'
  return null
}
