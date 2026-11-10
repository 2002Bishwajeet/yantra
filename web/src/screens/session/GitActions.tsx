import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, GitCommitHorizontal, GitMerge, GitPullRequest, Trash2, Upload } from 'lucide-react'
import { useCommit, useDraftMessage, useMergePr, useOpenPr, usePush, useRemoveThread } from '@/api/mutations'
import type { ThreadPr } from '@/api'
import { Button } from '@/m3/button/Button'
import { Dialog, DialogClose, DialogPopup } from '@/m3/dialog/Dialog'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'
import { gitFailure, type GitFailure } from './git'
import { buildMenuItems, resolveQuickAction, type GitVerb } from './gitActions.logic'
import './GitActions.css'

type Pr = { number: number; url: string; state: 'open' | 'merged' }

function Failure(props: { failure: GitFailure; retry: () => void }) {
  const { failure, retry } = props
  return <ErrorSurface.Inline className="git__fail" error={failure} reset={retry} title={failure.title} />
}

const ICON = {
  commit: <GitCommitHorizontal />,
  push: <Upload />,
  pr: <GitPullRequest />,
  merge: <GitMerge />,
  remove: <Trash2 />,
}

/** Commit, push and open a PR for the chat's thread (Y-493), as T3 Code lays them out: one quick
 *  action for the next step, and a menu for every verb, merge and worktree removal too (Y-496). A person asks for each verb; none runs by itself.
 *  The daemon sends no git status, so the next step comes from what this page saw (Y-633). */
export function GitActions(props: {
  workspace: string
  thread: string | null
  busy: boolean
  /** Turn diffs in the timeline. A rise after this page's last commit means files changed. */
  diffs: number
  /** The thread's PR as the list read it. */
  listed: ThreadPr | undefined
  /** Read the thread list again, as a PR opened here changes it. */
  refresh: () => void
  /** The thread's worktree is gone: leave it for the workspace's chat. */
  onRemoved: () => void
}) {
  const { workspace, thread, busy, diffs, listed, refresh, onRemoved } = props
  const whyId = useId()
  const menuWhyId = useId()
  const [note, setNote] = useState('')

  const [opened, setOpened] = useState<Pr | null>(null)
  const pr: Pr | null =
    opened ?? (listed && (listed.state === 'open' || listed.state === 'merged') ? { ...listed, state: listed.state } : null)
  const [committedAt, setCommittedAt] = useState(0)
  const [committed, setCommitted] = useState(false)
  const [pushed, setPushed] = useState(false)

  const state = { thread: thread !== null, busy, changed: diffs > committedAt, committed, pushed, pr }
  const quick = resolveQuickAction(state)
  const items = buildMenuItems(state)
  const off = items[0]!.reason

  const draft = useDraftMessage(workspace)
  const commit = useCommit(workspace)
  const push = usePush(workspace)
  const openPr = useOpenPr(workspace)
  const merge = useMergePr(workspace)
  const remove = useRemoveThread(workspace)
  const [mergeAsk, setMergeAsk] = useState(false)
  const [removeAsk, setRemoveAsk] = useState(false)
  const [branchKept, setBranchKept] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [message, setMessage] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const boxId = useId()
  const quickButton = useRef<HTMLButtonElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  // The dialog hands focus back to whatever opened it; the menu item it came from is gone by then.
  const returnTo = useRef<HTMLElement | null>(null)
  const afterMenu = useRef<GitVerb | null>(null)

  const ask = () => {
    if (thread !== null) draft.mutate(thread, { onSuccess: (got) => setMessage(got.message) })
  }
  const changeDialog = (next: boolean) => {
    setDialog(next)
    if (next) {
      commit.reset()
      setMessage('')
      ask()
    } else {
      draft.reset()
    }
  }
  // The box is off while a draft is written; hand the caret to it when it opens.
  useEffect(() => {
    if (dialog && !draft.isPending && !draft.isIdle) box.current?.focus()
  }, [dialog, draft.isPending, draft.isIdle])

  const send = () => {
    if (thread === null) return
    commit.mutate(
      { id: thread, message: message.trim() },
      {
        onSuccess: (done) => {
          setDialog(false)
          setCommittedAt(diffs)
          setCommitted(true)
          setPushed(false)
          setNote(`Committed: ${done.subject}`)
        },
      },
    )
  }
  const pushIt = () => {
    if (thread === null) return
    push.mutate(thread, {
      onSuccess: (done) => {
        setCommitted(false)
        setPushed(true)
        setNote(`Pushed ${done.remote}/${done.branch}`)
      },
    })
  }
  const openIt = () => {
    if (thread === null) return
    openPr.mutate(thread, {
      onSuccess: (done) => {
        setOpened({ number: done.number, url: done.url, state: 'open' })
        setPushed(false)
        setNote(`${done.created ? 'Opened' : 'Found'} PR #${done.number}`)
        refresh()
      },
    })
  }
  const mergeIt = () => {
    if (thread === null || pr === null) return
    merge.mutate(
      { id: thread, number: pr.number },
      {
        onSuccess: (done) => {
          setOpened({ ...pr, state: 'merged' })
          setBranchKept(!done.branchDeleted)
          setNote(`Merged PR #${done.number}`)
          refresh()
          setMergeAsk(false)
          askRemove()
        },
      },
    )
  }
  const askRemove = () => {
    remove.reset()
    setRemoveAsk(true)
  }
  const removeIt = () => {
    if (thread === null) return
    remove.mutate(thread, {
      onSuccess: () => {
        setRemoveAsk(false)
        onRemoved()
      },
    })
  }
  const run = (verb: GitVerb, from: HTMLElement | null) => {
    returnTo.current = from
    if (verb === 'commit') changeDialog(true)
    else if (verb === 'push') pushIt()
    else if (verb === 'pr') openIt()
    else if (verb === 'merge') {
      merge.reset()
      setMergeAsk(true)
    } else askRemove()
  }

  const draftFailure = draft.isError ? gitFailure('draft', draft.error) : null
  const commitFailure = commit.isError ? gitFailure('commit', commit.error) : null
  const clean = draftFailure?.kind === 'draftNothing'
  const mergeFailure = merge.isError ? gitFailure('merge', merge.error) : null
  const removeFailure = remove.isError ? gitFailure('remove', remove.error) : null

  // The quick action and the menu item run one verb, so they share its pending word.
  const busyWord = (verb: GitVerb, label: string) =>
    verb === 'push' && push.isPending ? 'Pushing…' : verb === 'pr' && openPr.isPending ? 'Opening…' : label
  const verb = quick.kind === 'commit' || quick.kind === 'push' || quick.kind === 'pr' ? quick.kind : null
  const pending = verb !== null && busyWord(verb, quick.label) !== quick.label

  return (
    <>
      <Dialog onOpenChange={changeDialog} open={dialog}>
        <DialogPopup
          actions={
            <>
              <DialogClose render={<Button variant="text" />}>{clean ? 'Close' : 'Cancel'}</DialogClose>
              {clean ? null : (
                <Button disabled={message.trim() === '' || draft.isPending || commit.isPending} onClick={send}>
                  {commit.isPending ? 'Committing…' : 'Commit'}
                </Button>
              )}
            </>
          }
          description="claude drafts a message from the changes on the machine. Edit it, or write your own."
          finalFocus={returnTo}
          title="Commit this thread"
        >
          {clean ? (
            <EmptyState title="Nothing to commit">The thread has no changes.</EmptyState>
          ) : (
            <>
              <div className="git__message">
                <label className="git__label" htmlFor={boxId}>
                  Commit message
                </label>
                <textarea
                  aria-busy={draft.isPending}
                  className="git__box"
                  disabled={draft.isPending}
                  id={boxId}
                  onChange={(event) => setMessage(event.target.value)}
                  ref={box}
                  rows={6}
                  value={message}
                />
                <p className="git__status" role="status">
                  {draft.isPending ? 'Drafting a message…' : ''}
                </p>
                <Button disabled={draft.isPending} onClick={ask} variant="text">
                  Draft again
                </Button>
              </div>
              {commitFailure ? (
                <Failure failure={commitFailure} retry={send} />
              ) : draftFailure ? (
                <Failure failure={draftFailure} retry={ask} />
              ) : null}
            </>
          )}
        </DialogPopup>
      </Dialog>
      <Dialog onOpenChange={setMergeAsk} open={mergeAsk}>
        <DialogPopup
          actions={
            <>
              <DialogClose render={<Button variant="text" />}>Cancel</DialogClose>
              <Button disabled={merge.isPending} icon={ICON.merge} onClick={mergeIt}>
                {merge.isPending ? 'Merging…' : 'Merge'}
              </Button>
            </>
          }
          className="git__confirm"
          description={`Squash-merge PR #${pr?.number} as it is on GitHub now into the default branch, and delete its remote branch.`}
          finalFocus={returnTo}
          title={`Merge PR #${pr?.number}`}
        >
          {mergeFailure ? <Failure failure={mergeFailure} retry={mergeIt} /> : null}
        </DialogPopup>
      </Dialog>
      <Dialog onOpenChange={setRemoveAsk} open={removeAsk}>
        <DialogPopup
          actions={
            <>
              <DialogClose render={<Button variant="text" />}>Keep</DialogClose>
              <Button disabled={remove.isPending} icon={ICON.remove} onClick={removeIt}>
                {remove.isPending ? 'Removing…' : 'Remove worktree'}
              </Button>
            </>
          }
          className="git__confirm"
          description={`Remove this thread's worktree and branch?${branchKept ? ' Its remote branch stayed on GitHub.' : ''}`}
          finalFocus={returnTo}
          title={`PR #${pr?.number} merged`}
        >
          {removeFailure ? <Failure failure={removeFailure} retry={removeIt} /> : null}
        </DialogPopup>
      </Dialog>
      <div className="git__split">
        {quick.kind === 'open_pr_link' && pr ? (
          <Button
            icon={<GitPullRequest />}
            render={<a href={pr.url} rel="noopener noreferrer" target="_blank" />}
            variant="tonal"
          >
            {quick.label}
          </Button>
        ) : (
          <Button
            aria-describedby={quick.kind === 'hint' ? whyId : undefined}
            disabled={quick.disabled || pending}
            icon={verb ? ICON[verb] : undefined}
            onClick={() => verb && run(verb, quickButton.current)}
            ref={quickButton}
            variant={quick.kind === 'hint' ? 'text' : 'tonal'}
          >
            {verb ? busyWord(verb, quick.label) : quick.label}
          </Button>
        )}
        <Menu
          onOpenChangeComplete={(open) => {
            const verb = afterMenu.current
            if (open || verb === null) return
            afterMenu.current = null
            run(verb, menuTrigger.current)
          }}
        >
          <MenuTrigger render={<IconButton label="Git actions" ref={menuTrigger} />}>
            <ChevronDown />
          </MenuTrigger>
          <MenuPopup align="end">
            {items.map((item) =>
              item.kind === 'open_pr_link' && pr ? (
                <MenuLinkItem
                  icon={ICON.pr}
                  key={item.id}
                  render={<a href={pr.url} rel="noopener noreferrer" target="_blank" />}
                >
                  {item.label}
                </MenuLinkItem>
              ) : (
                <MenuItem
                  aria-describedby={item.disabled ? menuWhyId : undefined}
                  disabled={item.disabled}
                  icon={ICON[item.id]}
                  key={item.id}
                  onClick={() => {
                    afterMenu.current = item.id
                  }}
                >
                  {busyWord(item.id, item.label)}
                </MenuItem>
              ),
            )}
            {off ? (
              <span className="m3-sr-only" id={menuWhyId}>
                {off}
              </span>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      {quick.hint ? (
        <span className="m3-sr-only" id={whyId}>
          {quick.hint}
        </span>
      ) : null}
      <span aria-live="polite" className="chat__added">
        {note}
      </span>
      {push.isError ? <Failure failure={gitFailure('push', push.error)} retry={pushIt} /> : null}
      {openPr.isError && !pr ? <Failure failure={gitFailure('pr', openPr.error)} retry={openIt} /> : null}
    </>
  )
}
