/*
 * The quick action and the menu adapt T3 Code's git action logic, cut to Yantra's three verbs:
 * https://github.com/pingdotgg/t3code/blob/810e8f62/apps/web/src/components/GitActionsControl.logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { whyOff } from './git'

export type GitVerb = 'commit' | 'push' | 'pr' | 'merge' | 'remove'

/** What this page knows. The daemon sends no dirty flag and no ahead count, so `changed`,
 *  `committed` and `pushed` come from what this page saw and did since it attached. */
export type GitState = {
  thread: boolean
  busy: boolean
  /** A turn changed files after the last commit this page made. */
  changed: boolean
  /** This page committed and has not pushed since. */
  committed: boolean
  /** This page pushed and has not opened a PR since. */
  pushed: boolean
  pr: { number: number; state: 'open' | 'merged' } | null
}

export type QuickAction = {
  label: string
  kind: GitVerb | 'open_pr_link' | 'hint'
  disabled: boolean
  /** Why a hint does nothing; null for an action. */
  hint: string | null
}

export type MenuItem = {
  id: GitVerb
  label: string
  kind: GitVerb | 'open_pr_link'
  disabled: boolean
  reason: string | null
}

const act = (label: string, kind: GitVerb): QuickAction => ({ label, kind, disabled: false, hint: null })

export function resolveQuickAction(state: GitState): QuickAction {
  const { thread, busy, changed, committed, pushed, pr } = state
  const off = whyOff(thread ? 'thread' : null, busy)
  if (off !== null) return { label: 'Commit', kind: 'hint', disabled: true, hint: off }
  if (changed) return act('Commit', 'commit')
  if (committed) return act('Push', 'push')
  if (pushed && !pr) return act('Open PR', 'pr')
  if (pr) return { label: `PR #${pr.number}`, kind: 'open_pr_link', disabled: false, hint: null }
  return { label: 'Up to date', kind: 'hint', disabled: true, hint: 'Nothing to commit, push or open.' }
}

export function buildMenuItems(state: GitState): MenuItem[] {
  const reason = whyOff(state.thread ? 'thread' : null, state.busy)
  const off = reason !== null
  const { pr } = state
  const items: MenuItem[] = [
    { id: 'commit', label: 'Commit', kind: 'commit', disabled: off, reason },
    { id: 'push', label: 'Push', kind: 'push', disabled: off, reason },
    pr
      ? { id: 'pr', label: `PR #${pr.number}`, kind: 'open_pr_link', disabled: false, reason: null }
      : { id: 'pr', label: 'Open PR', kind: 'pr', disabled: off, reason },
  ]
  // Y-496: an open PR is merged from here, and a merged one leaves a worktree to remove.
  if (pr?.state === 'open') items.push({ id: 'merge', label: `Merge PR #${pr.number}`, kind: 'merge', disabled: off, reason })
  if (pr?.state === 'merged') items.push({ id: 'remove', label: 'Remove worktree', kind: 'remove', disabled: off, reason })
  return items
}
