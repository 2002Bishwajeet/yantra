/*
 * The checks surface adapts T3 Code's pull request checks popover, cut to one PR per thread,
 * with its reviews and line comments added for Fix with agent:
 * https://github.com/pingdotgg/t3code/blob/b8c2cfad/apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useRef, useState } from 'react'
import { CircleCheck, CircleDashed, CircleDot, CircleSlash, CircleX, LoaderCircle, type LucideIcon } from 'lucide-react'
import type { Pull } from '@/api'
import { BottomSheet, BottomSheetPopup, BottomSheetTrigger } from '@/m3/bottom-sheet/BottomSheet'
import { Button } from '@/m3/button/Button'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import { canFix, checkStatus, fixBlock, STATUS_LABEL, summarizeChecks, reviewWord, who, type CheckStatus } from './checks.logic'
import { ChatMarkdown } from './markdown/ChatMarkdown'
import { usePull } from './pulls'
import './Checks.css'

const ICON: Record<CheckStatus, LucideIcon> = {
  pending: LoaderCircle,
  success: CircleCheck,
  failure: CircleX,
  cancelled: CircleX,
  skipped: CircleSlash,
  neutral: CircleDashed,
}

const SUMMARY_ICON: Record<Pull['summary'], LucideIcon> = { failed: CircleX, passed: CircleCheck, pending: CircleDot }

/** Review text renders as the agent's replies do; it opens no editor, as the PR's lines are GitHub's. */
const Body = (props: { text: string }) => (
  <div className="checks__body">
    <ChatMarkdown machine="" text={props.text} worktree={null} />
  </div>
)

function Surface(props: { query: ReturnType<typeof usePull>; onFix: () => void }) {
  const { query, onFix } = props
  if (query.isPending) {
    return (
      <div aria-busy="true" className="checks__pending">
        <Text scale="body-small" tone="variant">
          Reading the checks…
        </Text>
        <Skeleton shape="text" style={{ width: '60%' }} />
        <Skeleton shape="text" style={{ width: '40%' }} />
      </div>
    )
  }
  if (query.isError) {
    const failure = query.error
    return <ErrorSurface.Inline error={failure} reset={() => void query.refetch()} title={failure.title} />
  }
  const pull = query.data
  if (pull === null) {
    return (
      <EmptyState title="This PR is not watched">
        The daemon watches a thread's PR once it holds a GitHub grant, and finds a new one within five minutes.
      </EmptyState>
    )
  }
  return (
    <div className="checks">
      <Text render={<p />} scale="body-medium" tone="variant">
        {summarizeChecks(pull.checks)}
      </Text>
      {pull.checks.length > 0 ? (
        <ul aria-label="Checks" className="checks__list">
          {pull.checks.map((check, at) => {
            const status = checkStatus(check)
            const Icon = ICON[status]
            return (
              // Check names can repeat across workflows, and a row holds no state.
              <li className="checks__check" data-status={status} key={`${at}:${check.name}`}>
                <Icon aria-hidden="true" className="checks__icon" />
                <span className="checks__name">{check.name}</span>
                <Text className="checks__status" scale="body-small" tone="variant">
                  {STATUS_LABEL[status]}
                </Text>
                {check.output?.title ? <span className="checks__title">{check.output.title}</span> : null}
                {check.output?.summary ? <Body text={check.output.summary} /> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {pull.reviews.length + pull.comments.length > 0 ? (
        <ul aria-label="Review comments" className="checks__list">
          {pull.reviews.map((review) => (
            <li className="checks__comment" key={`review:${review.id}`}>
              <Text scale="label-large">
                {who(review.author)} · {reviewWord(review)}
              </Text>
              {review.body.trim() ? <Body text={review.body} /> : null}
            </li>
          ))}
          {pull.comments.map((comment) => (
            <li className="checks__comment" key={`comment:${comment.id}`}>
              <Text scale="label-large">
                {who(comment.author)} ·{' '}
                <code className="checks__where">
                  {comment.line === null ? comment.path : `${comment.path}:${comment.line}`}
                </code>
              </Text>
              <Body text={comment.body} />
            </li>
          ))}
        </ul>
      ) : null}
      <Button className="checks__fix" disabled={!canFix(pull)} onClick={onFix} variant="filled">
        Fix with agent
      </Button>
    </div>
  )
}

/** Y-495: the thread's PR checks and review comments, read from the appliance's watch. A popover on a
 *  desktop or a tablet, a bottom sheet on a phone. Fix with agent fills the composer and sends nothing
 *  (m16 §5): a turn that starts with nobody watching is a decision the owner has not made. */
export function Checks(props: { pr: { number: number; url: string } | null; onFix: (block: string) => void }) {
  return props.pr ? <ChecksOn onFix={props.onFix} pr={props.pr} /> : null
}

function ChecksOn(props: { pr: { number: number; url: string }; onFix: (block: string) => void }) {
  const { pr, onFix } = props
  const query = usePull(pr.url)
  const factor = useFormFactor()
  const [open, setOpen] = useState(false)
  // The block waits for the surface to close, so the composer takes focus after the trigger has it back.
  const pending = useRef<string | null>(null)

  const fix = () => {
    if (!query.data) return
    pending.current = fixBlock(query.data)
    setOpen(false)
  }
  const closed = (now: boolean) => {
    const block = pending.current
    if (now || block === null) return
    pending.current = null
    onFix(block)
  }
  const Icon = query.data ? SUMMARY_ICON[query.data.summary] : CircleDot
  const trigger = (
    <Button
      className="checks__trigger"
      data-summary={query.data?.summary}
      icon={<Icon />}
      variant="text"
    />
  )
  const title = `Checks on PR #${pr.number}`
  const surface = <Surface onFix={fix} query={query} />

  if (factor === 'phone') {
    return (
      <BottomSheet onOpenChange={setOpen} onOpenChangeComplete={closed} open={open}>
        <BottomSheetTrigger render={trigger}>Checks</BottomSheetTrigger>
        <BottomSheetPopup className="checks__sheet" title={title}>
          {surface}
        </BottomSheetPopup>
      </BottomSheet>
    )
  }
  return (
    <Popover onOpenChange={setOpen} onOpenChangeComplete={closed} open={open}>
      <PopoverTrigger render={trigger}>Checks</PopoverTrigger>
      <PopoverPopup showTitle title={title}>
        {surface}
      </PopoverPopup>
    </Popover>
  )
}
