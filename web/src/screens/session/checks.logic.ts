/*
 * The check states and the summary line adapt T3 Code's pull request presentation:
 * https://github.com/pingdotgg/t3code/blob/b8c2cfad/apps/web/src/components/pullRequest/pullRequestPresentation.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import type { Pull, PullCheck, PullReview } from '@/api'

export type CheckStatus = 'pending' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral'

// The daemon's watch counts these four as failed (watch.rs FAILED), so Fix with agent does too.
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required'])

export const failed = (check: PullCheck) => check.status === 'completed' && FAILED.has(check.conclusion ?? '')

/** GitHub's status and conclusion, cut to the six marks the surface draws. */
export function checkStatus(check: PullCheck): CheckStatus {
  if (check.status !== 'completed') return 'pending'
  switch (check.conclusion) {
    case 'success':
      return 'success'
    case 'skipped':
      return 'skipped'
    case 'cancelled':
      return 'cancelled'
    case 'neutral':
      return 'neutral'
    default:
      return failed(check) ? 'failure' : 'neutral'
  }
}

export const STATUS_LABEL: Record<CheckStatus, string> = {
  pending: 'Running',
  success: 'Passed',
  failure: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  neutral: 'Neutral',
}

export function summarizeChecks(checks: readonly PullCheck[]): string {
  const total = checks.length
  if (total === 0) return 'GitHub reported no checks yet'
  const failing = checks.filter(failed).length
  if (failing > 0) return `${failing} of ${total} failing`
  const running = checks.filter((check) => check.status !== 'completed').length
  if (running > 0) return `${running} of ${total} running`
  const passed = checks.filter((check) => check.conclusion === 'success').length
  return passed === total ? 'All checks passed' : `${passed} of ${total} passing`
}

const REVIEW_WORD: Record<PullReview['state'], string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
}

export const reviewWord = (review: PullReview) => REVIEW_WORD[review.state] ?? review.state.toLowerCase()

export const who = (author: string) => author || 'ghost'

/** A review with no body says nothing for the agent to act on. */
const said = (review: PullReview) => review.body.trim() !== ''

export const canFix = (pull: Pull) => pull.checks.some(failed) || pull.reviews.some(said) || pull.comments.length > 0

/** Fix with agent's one block: the failed checks, then the reviews, then the line comments in order.
 *  Empty when there is nothing to fix. */
export function fixBlock(pull: Pull): string {
  const parts: string[] = []
  for (const check of pull.checks.filter(failed)) {
    const lines = [`Check ${check.name} failed (${check.conclusion}).`]
    if (check.output?.title) lines.push(check.output.title)
    if (check.output?.summary) lines.push(check.output.summary)
    parts.push(lines.join('\n'))
  }
  for (const review of pull.reviews.filter(said)) {
    parts.push(`Review by ${who(review.author)} (${reviewWord(review)}):\n${review.body.trim()}`)
  }
  for (const comment of pull.comments) {
    const at = comment.line === null ? comment.path : `${comment.path}:L${comment.line}`
    parts.push(`> ${at}\n${comment.body.trim()}`)
  }
  if (parts.length === 0) return ''
  return [`Fix PR #${pull.number}:`, ...parts].join('\n\n')
}
