/*
 * The breadcrumb with a thread menu and the actions at the right adapt T3 Code's chat header:
 * https://github.com/pingdotgg/t3code/blob/810e8f62/apps/web/src/components/chat/ChatHeader.tsx
 * The grouping and the status marks adapt its thread list, as threads.ts says.
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, Diff, Plus, RefreshCw, SquareTerminal } from 'lucide-react'
import { useThreads } from '@/api/mutations'
import { useThreadStates } from '@/api/queries'
import { useTick } from '@/useTick'
import { Button } from '@/m3/button/Button'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/m3/menu/Menu'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { Checks } from './Checks'
import { GitActions } from './GitActions'
import { elapsed, groupThreads, prMark, threadTitle } from './threads'

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
  /** Y-498: the drawer with a shell in the thread's worktree. */
  terminal: { open: boolean; onToggle: () => void }
  terminalRef: RefObject<HTMLButtonElement | null>
  /** The polite note a comment added from the diff leaves. */
  added: boolean
  /** The page's tab bar. Undefined draws the header in place; null draws nothing, for a tab that is not Chat. */
  into?: HTMLElement | null
  /** Fix with agent: put this block in the composer, and send nothing. */
  onFix: (block: string) => void
}

/** Y-633: the Chat tab's top line. The threads read on mount and on Refresh, and never poll:
 *  each read is an ssh to the machine and a call to GitHub (Y-489). */
export function ChatHeader(props: ChatHeaderProps) {
  const { workspace, thread, urlThread, busy, diffs, diff, diffRef, terminal, terminalRef, added, into, onFix } = props
  const active = thread ?? urlThread ?? null
  const threads = useThreads(workspace)
  const { mutate } = threads
  const navigate = useNavigate()
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

  // The live read polls only while the menu is open, and the clock ticks only then too.
  const [open, setOpen] = useState(false)
  const states = useThreadStates(workspace, open)
  const now = useTick(open)
  const live = states.data
  // The socket knows the open thread best, then the daemon's memory, then the list's read.
  const listed = shown?.map((one) => {
    const read = live?.find((state) => state.id === one.id) ?? one
    if (one.id !== active) return { ...one, state: read.state, since: read.since }
    return { ...one, state: busy ? ('working' as const) : ('idle' as const), since: busy ? read.since : null }
  })

  const current = listed?.find((one) => one.id === active)
  const pr = thread ? shown?.find((one) => one.id === thread)?.pr : undefined
  const title = current ? threadTitle(current) : active ? 'Thread' : 'New thread'
  const groupId = useId()
  const noTerminal = useId()

  if (into === null) return null

  const header = (
    <header className="chat__header">
      <nav aria-label="Thread" className="chat__crumbs">
        {into === undefined ? (
          <>
            <Text className="chat__crumb" scale="label-large" tone="variant">
              {workspace}
            </Text>
            <span aria-hidden="true">/</span>
          </>
        ) : null}
        <Menu onOpenChange={setOpen}>
          <MenuTrigger className="chat__title m3-interactive" aria-label={`Threads, ${title}`}>
            <span className="chat__title-text">{title}</span>
            <ChevronDown aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="start" className="chat__threads">
            {active ? (
              <MenuLinkItem
                render={
                  <Link
                    activeOptions={{ exact: true, includeSearch: true }}
                    params={{ name: workspace }}
                    search={{ view: 'chat' }}
                    to="/w/$name"
                  />
                }
              >
                <Plus aria-hidden="true" />
                New thread
              </MenuLinkItem>
            ) : null}
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
            {states.error ? (
              <ErrorSurface.Inline error={states.error} title="The thread states could not be read" />
            ) : null}
            {shown && shown.length === 0 ? (
              <EmptyState title="No threads yet">Send a message in Chat to start one.</EmptyState>
            ) : null}
            {listed
              ? groupThreads(listed).map((group) => (
                  <div aria-labelledby={`${groupId}-${group.title}`} className="threads__group" key={group.title} role="group">
                    <Text id={`${groupId}-${group.title}`} scale="body-small" tone="variant">
                      {group.title}
                    </Text>
                    {group.items.map((one) => {
                      const mark = prMark(one.pr)
                      const name = threadTitle(one)
                      const isWorking = one.state === 'working'
                      const doing = isWorking ? (one.since === null ? 'Working' : `Working · ${elapsed(one.since, now)}`) : 'Idle'
                      return (
                        <MenuLinkItem
                          aria-current={one.id === active ? 'true' : undefined}
                          aria-label={`${name}${one.from ? `, from ${one.from}` : ''}, ${doing}, ${mark.word}`}
                          className="threads__row"
                          key={one.id}
                          render={
                            <Link params={{ name: workspace }} replace search={{ view: 'chat', thread: one.id }} to="/w/$name" />
                          }
                        >
                          <span className="threads__title">{name}</span>
                          {one.from ? (
                            <Text className="threads__from" scale="body-small" tone="variant">
                              from {one.from}
                            </Text>
                          ) : null}
                          <State className="threads__doing" state={isWorking ? 'running' : 'idle'}>
                            {doing}
                          </State>
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
        aria-describedby={thread ? undefined : noTerminal}
        aria-pressed={terminal.open}
        disabled={!thread}
        focusableWhenDisabled
        icon={<SquareTerminal />}
        onClick={terminal.onToggle}
        ref={terminalRef}
        variant={terminal.open ? 'tonal' : 'text'}
      >
        Terminal
      </Button>
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
      <Checks onFix={onFix} pr={pr?.state === 'open' ? pr : null} />
      <GitActions
        busy={busy}
        diffs={diffs}
        key={thread ?? ''}
        listed={pr}
        onRemoved={() => {
          mutate()
          void navigate({ to: '/w/$name', params: { name: workspace }, search: { view: 'chat' }, replace: true })
        }}
        refresh={() => mutate()}
        thread={thread}
        workspace={workspace}
      />
      {thread ? null : (
        <span className="m3-sr-only" id={noTerminal}>
          The terminal opens in the thread's worktree, which the first turn makes.
        </span>
      )}
      <span aria-live="polite" className="chat__added">
        {added ? 'Comment added to your message.' : ''}
      </span>
    </header>
  )
  return into ? createPortal(header, into) : header
}
