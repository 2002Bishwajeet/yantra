import { useEffect, useId, useRef, useState } from 'react'
import { GitCommitHorizontal, GitPullRequest, Upload } from 'lucide-react'
import { useCommit, useDraftMessage, useOpenPr, usePush, useThreads } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { Dialog, DialogClose, DialogPopup, DialogTrigger } from '@/m3/dialog/Dialog'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { gitFailure, whyOff, type GitFailure } from './git'
import './GitActions.css'

type Pr = { number: number; url: string }

function Failure(props: { failure: GitFailure; retry: () => void }) {
  const { failure, retry } = props
  return <ErrorSurface.Inline className="git__fail" error={failure} reset={retry} title={failure.title} />
}

/** Commit, push and open a PR for the chat's thread (Y-493). Each verb is the
 *  daemon's own route; a person asks for each, and none runs by itself. */
export function GitActions(props: { workspace: string; thread: string | null; busy: boolean }) {
  const { workspace, thread, busy } = props
  const why = whyOff(thread, busy)
  const whyId = useId()
  const [note, setNote] = useState('')

  const threads = useThreads(workspace)
  const { mutate: listThreads } = threads
  useEffect(() => {
    if (thread !== null) listThreads()
  }, [thread, listThreads])
  const [opened, setOpened] = useState<Pr | null>(null)
  const listed = threads.data?.find((one) => one.id === thread)?.pr
  const pr: Pr | null = opened ?? (listed && (listed.state === 'open' || listed.state === 'merged') ? listed : null)

  const draft = useDraftMessage(workspace)
  const commit = useCommit(workspace)
  const push = usePush(workspace)
  const openPr = useOpenPr(workspace)
  const [dialog, setDialog] = useState(false)
  const [message, setMessage] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const boxId = useId()

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
          setNote(`Committed: ${done.subject}`)
        },
      },
    )
  }
  const pushIt = () => {
    if (thread === null) return
    push.mutate(thread, { onSuccess: (done) => setNote(`Pushed ${done.remote}/${done.branch}`) })
  }
  const openIt = () => {
    if (thread === null) return
    openPr.mutate(thread, {
      onSuccess: (done) => {
        setOpened({ number: done.number, url: done.url })
        setNote(`${done.created ? 'Opened' : 'Found'} PR #${done.number}`)
        listThreads()
      },
    })
  }

  const off = why !== null
  const described = off ? whyId : undefined
  const draftFailure = draft.isError ? gitFailure('draft', draft.error) : null
  const commitFailure = commit.isError ? gitFailure('commit', commit.error) : null

  return (
    <>
      <Dialog onOpenChange={changeDialog} open={dialog}>
        <DialogTrigger
          aria-describedby={described}
          disabled={off}
          render={<Button icon={<GitCommitHorizontal />} variant="text" />}
        >
          Commit
        </DialogTrigger>
        <DialogPopup
          actions={
            <>
              <DialogClose render={<Button variant="text" />}>Cancel</DialogClose>
              <Button disabled={message.trim() === '' || draft.isPending || commit.isPending} onClick={send}>
                {commit.isPending ? 'Committing…' : 'Commit'}
              </Button>
            </>
          }
          description="claude drafts a message from the changes on the machine. Edit it, or write your own."
          title="Commit this thread"
        >
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
        </DialogPopup>
      </Dialog>
      <Button
        aria-describedby={described}
        disabled={off || push.isPending}
        icon={<Upload />}
        onClick={pushIt}
        variant="text"
      >
        {push.isPending ? 'Pushing…' : 'Push'}
      </Button>
      {pr ? (
        <Button
          icon={<GitPullRequest />}
          render={<a href={pr.url} rel="noopener noreferrer" target="_blank" />}
          variant="text"
        >
          {`PR #${pr.number}`}
        </Button>
      ) : (
        <Button
          aria-describedby={described}
          disabled={off || openPr.isPending}
          icon={<GitPullRequest />}
          onClick={openIt}
          variant="text"
        >
          {openPr.isPending ? 'Opening…' : 'Open PR'}
        </Button>
      )}
      {off ? (
        <span className="m3-sr-only" id={whyId}>
          {why}
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
