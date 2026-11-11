/*
 * Adapts T3 Code's chat header, as ChatHeader.tsx says; the thread menu here lists a machine's
 * home threads: https://github.com/pingdotgg/t3code/blob/810e8f62/apps/web/src/components/chat/ChatHeader.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useRemoveHomeThread } from '@/api/mutations'
import { useMachineHomeThreads } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { Dialog, DialogClose, DialogPopup } from '@/m3/dialog/Dialog'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/m3/menu/Menu'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { threadTitle } from './threads'

export type HomeHeaderProps = {
  machine: string
  /** The thread the daemon named for this chat; null until it has. */
  thread: string | null
  /** `?thread=`: the chat to continue, known before the daemon names it. */
  urlThread?: string
  busy: boolean
  /** The page's bar. Undefined draws the header in place. */
  into?: HTMLElement | null
}

/** A home chat has no repository, so the header holds the thread menu and Remove, and no git. */
export function HomeHeader(props: HomeHeaderProps) {
  const { machine, thread, urlThread, busy, into } = props
  const active = thread ?? urlThread ?? null
  const threads = useMachineHomeThreads(machine)
  const remove = useRemoveHomeThread(machine)
  const navigate = useNavigate()
  const [asking, setAsking] = useState(false)

  const current = threads.data?.find((one) => one.id === active)
  const title = current ? threadTitle(current) : active ? 'Thread' : 'New thread'

  const removeIt = () => {
    if (!active) return
    remove.mutate(active, {
      onSuccess: () => {
        setAsking(false)
        void navigate({ to: '/m/$machine/home', params: { machine }, replace: true })
      },
    })
  }

  if (into === null) return null

  const header = (
    <header className="chat__header">
      <nav aria-label="Thread" className="chat__crumbs">
        {into === undefined ? (
          <>
            <Text className="chat__crumb" scale="label-large" tone="variant">
              {machine}
            </Text>
            <span aria-hidden="true">/</span>
          </>
        ) : null}
        <Menu>
          <MenuTrigger className="chat__title m3-interactive" aria-label={`Threads, ${title}`}>
            <span className="chat__title-text">{title}</span>
            <ChevronDown aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="start" className="chat__threads">
            {active ? (
              <MenuLinkItem render={<Link params={{ machine }} to="/m/$machine/home" />}>
                <Plus aria-hidden="true" />
                New thread
              </MenuLinkItem>
            ) : null}
            {threads.isPending ? (
              <div aria-busy="true" className="threads__pending">
                <Skeleton shape="text" style={{ width: '50%' }} />
                <Skeleton shape="text" style={{ width: '35%' }} />
              </div>
            ) : null}
            {threads.error ? (
              <ErrorSurface.Inline
                action={
                  <MenuItem closeOnClick={false} onClick={() => void threads.refetch()}>
                    Try again
                  </MenuItem>
                }
                error={threads.error}
                title="The threads could not be listed"
              />
            ) : null}
            {threads.data && threads.data.length === 0 ? (
              <EmptyState title="No home threads yet">Send a message to start one.</EmptyState>
            ) : null}
            {threads.data?.map((one) => (
              <MenuLinkItem
                aria-current={one.id === active ? 'true' : undefined}
                className="threads__row"
                key={one.id}
                render={<Link params={{ machine }} replace search={{ thread: one.id }} to="/m/$machine/home" />}
              >
                <span className="threads__title">{threadTitle(one)}</span>
                <State className="threads__doing" state={one.state === 'working' ? 'running' : 'idle'}>
                  {one.state === 'working' ? 'Working' : 'Idle'}
                </State>
              </MenuLinkItem>
            ))}
            <MenuSeparator />
            <MenuItem closeOnClick={false} onClick={() => void threads.refetch()}>
              Refresh threads
            </MenuItem>
          </MenuPopup>
        </Menu>
      </nav>
      <Button
        disabled={!active || busy}
        icon={<Trash2 />}
        onClick={() => {
          remove.reset()
          setAsking(true)
        }}
        variant="text"
      >
        Remove
      </Button>
      <Dialog onOpenChange={setAsking} open={asking}>
        <DialogPopup
          actions={
            <>
              <DialogClose render={<Button variant="text" />}>Keep</DialogClose>
              <Button disabled={remove.isPending} icon={<Trash2 />} onClick={removeIt}>
                {remove.isPending ? 'Removing…' : 'Remove'}
              </Button>
            </>
          }
          description={`Remove this thread and its history from ${machine}? Nothing else in the home folder changes.`}
          title="Remove this thread"
        >
          {remove.error ? (
            <ErrorSurface.Inline error={remove.error} reset={removeIt} title="The thread could not be removed" />
          ) : null}
        </DialogPopup>
      </Dialog>
    </header>
  )
  return into ? createPortal(header, into) : header
}
