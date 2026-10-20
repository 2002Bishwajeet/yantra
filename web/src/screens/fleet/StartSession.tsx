import { Link, useNavigate } from '@tanstack/react-router'
import type { Item, Workspace } from '@/api'
import { loaded, useWorkspaces } from '@/api/hooks'
import type { ApiError } from '@/api/errors'
import { useOpenThread, usePlacement } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { Dialog, DialogClose, DialogPopup, DialogTrigger } from '@/m3/dialog/Dialog'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Empty } from './Empty'
import { pickWorkspaces, type Choice } from './issuePick'

/** What a refusal of `threads/new` means here. A status alone is ambiguous: 409 is
 *  no sign-in or a worktree clash, 404 is a missing issue or a missing workspace. */
export function sentenceFor(error: ApiError): string | undefined {
  const said = error.said.toLowerCase()
  switch (error.status) {
    case 400:
      return 'The daemon refused the request.'
    case 404:
      return said.includes('github answered')
        ? 'GitHub has no such issue, or the sign-in cannot see it.'
        : 'The daemon does not know that workspace.'
    case 409:
      return said.includes('no github grant')
        ? 'The daemon holds no GitHub sign-in, so it cannot read the issue.'
        : 'The workspace already has a worktree or branch for this issue.'
    case 502:
      return 'GitHub did not answer.'
    case 503:
      return 'The workspace machine did not answer.'
  }
}

const noSignIn = (error: ApiError) => error.status === 409 && error.said.toLowerCase().includes('no github grant')

const explain = (error: ApiError) => ({
  kind: error.kind,
  said: error.said,
  retryable: error.retryable,
  describe: () => sentenceFor(error) ?? error.describe(),
})

/** Y-489: Start session on an inbox issue. The picker lists the workspaces
 *  that hold the repository, best machine first. */
export function StartSession(props: { item: Item }) {
  const { item } = props
  const issue = `${item.repo}#${item.number}`
  const workspaces = loaded(useWorkspaces())
  const placement = usePlacement()
  const ask = () => placement.mutate({ repo: item.repo })

  const settled = placement.isSuccess || placement.isError
  const picks =
    workspaces.looked === 'ok' && settled ? pickWorkspaces(workspaces.data, item.repo, placement.data ?? null) : null

  return (
    <Dialog onOpenChange={(open) => (open ? ask() : placement.reset())}>
      <DialogTrigger render={<Button aria-label={`Start session on ${issue}`} variant="tonal" />}>
        Start session
      </DialogTrigger>
      <DialogPopup
        actions={<DialogClose render={<Button variant="text" />}>Cancel</DialogClose>}
        description={item.title}
        dismiss="Close"
        title={`Start a session on ${issue}`}
      >
        <div className="start">
          {workspaces.looked === 'failed' ? (
            <Mono className="start__note">The workspaces could not be read: {workspaces.error}</Mono>
          ) : null}
          {workspaces.looked === 'pending' || (workspaces.looked === 'ok' && !settled) ? (
            <div aria-busy="true" className="start__pending">
              <Skeleton shape="text" style={{ width: '60%' }} />
              <Skeleton shape="text" style={{ width: '40%' }} />
            </div>
          ) : null}
          {placement.error ? (
            <Text render={<p role="status" />} scale="body-small" tone="variant">
              The machines could not be ranked, so the list is in name order. {placement.error.said}
            </Text>
          ) : null}
          {picks && picks.choices.length === 0 ? (
            <Empty state="idle" title="No workspace holds this repository">
              A new session can clone it.
            </Empty>
          ) : null}
          {picks && picks.choices.length === 0 ? (
            <Button render={<Link to="/new" />} role="link" variant="tonal">
              New session
            </Button>
          ) : null}
          {picks && picks.choices.length > 0 ? (
            <ul aria-label="Workspaces that hold this repository" className="start__list">
              {picks.choices.map((choice) => (
                <li key={choice.workspace.name}>
                  <Pick choice={choice} issue={issue} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  )
}

function Pick(props: { choice: Choice; issue: string }) {
  const { choice, issue } = props
  const { workspace } = choice
  const navigate = useNavigate()
  const open = useOpenThread(workspace.name)
  const go = (name: Workspace['name']) =>
    open.mutate(issue, {
      onSuccess: (opened) =>
        // The draft goes in state, not the URL: the issue body stays out of logs (ADR-0034 §4).
        void navigate({
          to: '/w/$name',
          params: { name },
          search: { view: 'chat', thread: opened.thread },
          state: { draft: opened.draft } as never,
        }),
    })
  return (
    <div className="start__pick">
      <Button
        disabled={open.isPending}
        onClick={() => go(workspace.name)}
        type="button"
        variant={choice.asleep ? 'outlined' : 'filled'}
      >
        {workspace.name}
      </Button>
      <Mono className="start__machine">{workspace.machine}</Mono>
      {choice.owned ? null : (
        <Text scale="body-small" tone="variant">
          Matched by folder name only. Check the repository before you start.
        </Text>
      )}
      {choice.reason ? <Text scale="body-small" tone="variant">{choice.reason}</Text> : null}
      {open.error ? (
        <ErrorSurface.Inline
          action={
            noSignIn(open.error) ? (
              <Button render={<Link params={{ category: 'providers' }} to="/settings/$category" />} role="link" variant="text">
                Sign in
              </Button>
            ) : undefined
          }
          error={explain(open.error)}
          title="The session could not be started"
        />
      ) : null}
    </div>
  )
}
