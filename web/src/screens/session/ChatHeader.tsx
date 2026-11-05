/*
 * The breadcrumb with a thread menu and the actions at the right adapt T3 Code's chat header:
 * https://github.com/pingdotgg/t3code/blob/810e8f62/apps/web/src/components/chat/ChatHeader.tsx
 * The grouping and the status marks adapt its thread list, as threads.ts says.
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Diff, RefreshCw } from 'lucide-react'
import { useThreads } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/m3/menu/Menu'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { GitActions } from './GitActions'
import { groupThreads, prMark } from './threads'

const branchTail = (branch: string) => branch.split('/').pop() ?? branch

export type ChatHeaderProps = {
  workspace: string
  /** The thread the daemon named for this chat; null until it has. */
  thread: string | null
  /** `?thread=`: the chat to continue, known before the daemon names it. */
  urlThread?: string
  busy: boolean
  /** Turn diffs in the timeline, for the git quick action. */
  diffs: number
  diff: { open: boolean; onToggle: () => void; onRefresh: () => void }
  diffRef: RefObject<HTMLButtonElement | null>
  /** The polite note a comment added from the diff leaves. */
  added: boolean
}

/** Y-633: the Chat tab's top line. The threads read on mount and on Refresh, and never poll:
 *  each read is an ssh to the machine and a call to GitHub (Y-489). */
export function ChatHeader(props: ChatHeaderProps) {
  const { workspace, thread, urlThread, busy, diffs, diff, diffRef, added } = props
  const active = thread ?? urlThread ?? null
  const threads = useThreads(workspace)
  const { mutate } = threads
  // A refresh keeps the last list on screen until the new one lands.
  const [shown, setShown] = useState(threads.data)
  if (threads.data && threads.data !== shown) setShown(threads.data)
  useEffect(() => mutate(), [mutate, workspace])
  // The chat named a thread the list has not seen: read once more, but once per thread.
  const tried = useRef(active)
  useEffect(() => {
    if (!active || !shown || tried.current === active) return
    if (!shown.some((one) => one.id === active)) mutate()
    tried.current = active
  }, [active, shown, mutate])

  const current = shown?.find((one) => one.id === active)
  const title = current ? branchTail(current.branch) : (active ?? 'New thread')
  const groupId = useId()

  return (
    <header className="chat__header">
      <nav aria-label="Thread" className="chat__crumbs">
        <Text className="chat__crumb" scale="label-large" tone="variant">
          {workspace}
        </Text>
        <span aria-hidden="true">/</span>
        <Menu>
          <MenuTrigger className="chat__title m3-interactive" aria-label={`Threads, ${title}`}>
            <Mono>{title}</Mono>
            <ChevronDown aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="start" className="chat__threads">
            {threads.isPending && !shown ? (
              <div aria-busy="true" className="threads__pending">
                <Skeleton shape="text" style={{ width: '50%' }} />
                <Skeleton shape="text" style={{ width: '35%' }} />
              </div>
            ) : null}
            {threads.error ? (
              <ErrorSurface.Inline
                action={
                  <MenuItem closeOnClick={false} onClick={() => mutate()}>
                    Try again
                  </MenuItem>
                }
                error={threads.error}
                title="The threads could not be listed"
              />
            ) : null}
            {shown && shown.length === 0 ? (
              <EmptyState title="No threads yet">Send a message in Chat to start one.</EmptyState>
            ) : null}
            {shown
              ? groupThreads(shown).map((group) => (
                  <div aria-labelledby={`${groupId}-${group.title}`} className="threads__group" key={group.title} role="group">
                    <Text id={`${groupId}-${group.title}`} scale="body-small" tone="variant">
                      {group.title}
                    </Text>
                    {group.items.map((one) => {
                      const mark = prMark(one.pr)
                      return (
                        <MenuLinkItem
                          aria-current={one.id === active ? 'true' : undefined}
                          className="threads__row"
                          key={one.id}
                          render={
                            <Link params={{ name: workspace }} replace search={{ view: 'chat', thread: one.id }} to="/w/$name" />
                          }
                        >
                          <Mono className="threads__branch">{branchTail(one.branch)}</Mono>
                          {one.issue ? <Mono className="threads__issue">{one.issue}</Mono> : null}
                          <State className="threads__pr" state={mark.state}>
                            {mark.word}
                          </State>
                          {one.pr.state === 'unknown' ? (
                            <Text className="threads__said" scale="body-small" tone="variant">
                              {one.pr.said}
                            </Text>
                          ) : null}
                        </MenuLinkItem>
                      )
                    })}
                  </div>
                ))
              : null}
            <MenuSeparator />
            <MenuItem closeOnClick={false} disabled={threads.isPending} onClick={() => mutate()}>
              Refresh threads
            </MenuItem>
          </MenuPopup>
        </Menu>
      </nav>
      <Button
        aria-pressed={diff.open}
        icon={<Diff />}
        onClick={diff.onToggle}
        ref={diffRef}
        variant={diff.open ? 'tonal' : 'text'}
      >
        Diff
      </Button>
      {diff.open ? (
        <Button aria-label="Refresh the diff" icon={<RefreshCw />} onClick={diff.onRefresh} variant="text">
          Refresh
        </Button>
      ) : null}
      <GitActions
        busy={busy}
        diffs={diffs}
        key={thread ?? ''}
        listed={thread ? shown?.find((one) => one.id === thread)?.pr : undefined}
        refresh={() => mutate()}
        thread={thread}
        workspace={workspace}
      />
      <span aria-live="polite" className="chat__added">
        {added ? 'Comment added to your message.' : ''}
      </span>
    </header>
  )
}
