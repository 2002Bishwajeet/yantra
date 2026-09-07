import type { ReactElement } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { MachineSessions, Workspace, WorkspaceStatus } from '@/api'
import { useDown, useResume } from '@/api/mutations'
import type { Reading } from '@/api/hooks'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Row, RowText } from '@/m3/row/Row'
import { Mono, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { DeleteWorkspace } from '@/screens/fleet/Confirm'
import { phrase } from '@/shell/phrase'
import { home } from './format'
import { startedAt, verbs } from './verbs'

const URL = /^https?:\/\//

/** The Fleet row, repeated word for word under the question (BRIEF.md). */
export function Delete(props: { workspace: Workspace; status: WorkspaceStatus | null; trigger: ReactElement }) {
  const { workspace, status, trigger } = props
  const navigate = useNavigate()
  const { mark, words } = phrase(status)
  return (
    <DeleteWorkspace
      name={workspace.name}
      onDone={() => void navigate({ to: '/fleet' })}
      row={
        <Row tone="lowest">
          <Tile name={workspace.name} />
          <RowText
            headline={workspace.name}
            supporting={
              <State size="small" state={mark}>
                {words} · {workspace.machine}
              </State>
            }
          />
        </Row>
      }
      trigger={trigger}
    />
  )
}

export type HeaderProps = {
  workspace: Workspace
  status: WorkspaceStatus | null
  sessions: Reading<MachineSessions[]>
  now: number
}

/** Tile, name, state and age, where it lives, and the three verbs. Stop and
 *  Resume never confirm; Delete does (BRIEF.md). */
export function Header(props: HeaderProps) {
  const { workspace, status, sessions, now } = props
  const { mark, words } = phrase(status)
  const started = startedAt(sessions, workspace)
  const live = verbs(workspace, status)
  const stop = useDown()
  const resume = useResume()
  const failed = stop.error ?? resume.error

  return (
    <header className="session__head">
      <div className="session__title">
        <Tile name={workspace.name} />
        <div className="session__name">
          <div className="session__line">
            <Text as="h1" scale="headline-medium" emphasized clip>
              {workspace.name}
            </Text>
            <State state={mark}>
              {words}
              {started !== null ? <Mono className="session__age"> · {ago(now / 1000 - started, now).text}</Mono> : null}
            </State>
          </div>
          <Text as="p" scale="body-small" tone="variant" clip>
            {workspace.machine} · {home(workspace.repo)}
            {URL.test(workspace.repo) ? (
              <>
                {' '}
                ·{' '}
                <a href={workspace.repo} rel="noreferrer" target="_blank">
                  {workspace.repo.replace(URL, '')}
                </a>
              </>
            ) : null}
          </Text>
          {status?.reached === 'no' ? (
            <Mono className="session__unreachable">{status.error}</Mono>
          ) : null}
        </div>
      </div>
      <div className="session__verbs">
        <Button
          disabled={!live.stop || stop.isPending}
          onClick={() => stop.mutate(workspace.name)}
          variant="tonal"
        >
          {stop.isPending ? 'Stopping…' : 'Stop'}
        </Button>
        <Button
          disabled={!live.resume || resume.isPending}
          onClick={() => resume.mutate(workspace.name)}
          variant="tonal"
        >
          {resume.isPending ? 'Resuming…' : 'Resume'}
        </Button>
        <Delete
          status={status}
          trigger={
            <Button tone="error" variant="text">
              Delete
            </Button>
          }
          workspace={workspace}
        />
      </div>
      {failed ? (
        <ErrorSurface.Inline
          className="session__refusal"
          error={failed}
          title={stop.error ? `${workspace.name} was not stopped` : `${workspace.name} was not resumed`}
        />
      ) : null}
    </header>
  )
}
