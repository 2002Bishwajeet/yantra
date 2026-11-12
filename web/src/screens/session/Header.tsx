import { useId, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Ellipsis } from 'lucide-react'
import type { MachineSessions, Workspace, WorkspaceStatus } from '@/api'
import { useDown, useResume } from '@/api/mutations'
import type { Reading } from '@/api/hooks'
import { answerFailure, joinFixes, reachWords } from '@/lib/checks'
import { ago } from '@/lib/time'
import { useIdle } from '@/lib/useIdle'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'
import { State } from '@/m3/mark/Mark'
import { PageHeader } from '@/m3/page/PageHeader'
import { Row, RowText } from '@/m3/row/Row'
import { Num, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { DeleteWorkspace } from '@/screens/fleet/Confirm'
import { SshSaid } from '@/screens/machine/ReachFailure'
import { phrase } from '@/shell/phrase'
import { home } from './format'
import { Talk } from './Talk'
import { startedAt, verbs, whyNot } from './verbs'

const URL = /^https?:\/\//

/** The Fleet row, repeated word for word under the question (BRIEF.md). A menu item opens it. */
export function Delete(props: {
  workspace: Workspace
  status: WorkspaceStatus | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { workspace, status, open, onOpenChange } = props
  const navigate = useNavigate()
  const { mark, words } = phrase(status)
  return (
    <DeleteWorkspace
      name={workspace.name}
      onDone={() => void navigate({ to: '/fleet' })}
      onOpenChange={onOpenChange}
      open={open}
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
      trigger={null}
    />
  )
}

/** Y-585: the plain cause and the next step, and the raw text one press away.
 *  The machine page holds the join command and the checks. */
function Unanswered(props: { machine: string; error: string }) {
  const { machine, error } = props
  const kind = answerFailure(error)
  const { cause, next } = reachWords(kind, machine)
  return (
    <>
      <Text render={<p />} scale="body-medium">
        {cause}
      </Text>
      <Text render={<p />} scale="body-small" tone="variant">
        {next}{' '}
        <Link className="m3-hit" params={{ machine }} to="/m/$machine">
          {machine}’s page
        </Link>{' '}
        has {joinFixes(kind) ? 'the join command and the checks' : 'the checks'}.
      </Text>
      <SshSaid detail={error} kind={kind} />
    </>
  )
}

export type HeaderProps = {
  workspace: Workspace
  status: WorkspaceStatus | null
  sessions: Reading<MachineSessions[]>
  now: number
}

/** Name, state and age, where it lives, and the three verbs. Stop and
 *  Resume never confirm; Delete does (BRIEF.md). */
export function Header(props: HeaderProps) {
  const { workspace, status, sessions, now } = props
  const { mark, words } = phrase(status)
  const started = startedAt(sessions, workspace)
  const live = verbs(workspace, status)
  const why = whyNot(workspace, status)
  const said = useId()
  const stop = useDown()
  const resume = useResume()
  const failed = stop.error ?? resume.error
  const [deleting, setDeleting] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  // Y-765: mounted closed once idle, so the first tap only flips it open.
  const idle = useIdle()
  // One tonal verb: Stop while the session runs, Resume otherwise.
  const verb = {
    stop: { word: 'Stop', busy: 'Stopping…', enabled: live.stop, why: why.stop, pending: stop.isPending, run: () => stop.mutate(workspace.name) },
    resume: { word: 'Resume', busy: 'Resuming…', enabled: live.resume, why: why.resume, pending: resume.isPending, run: () => resume.mutate(workspace.name) },
  }
  const [primary, other] = live.stop ? [verb.stop, verb.resume] : [verb.resume, verb.stop]

  return (
    <>
      <PageHeader
        actions={
          <>
            {/* A disabled verb reads as broken unless it says why, and the boards
                draw no line for the reason, so the reason is the description. */}
            <Button
              aria-describedby={primary.enabled ? undefined : `${said}-verb`}
              disabled={!primary.enabled || primary.pending}
              onClick={primary.run}
              variant="tonal"
            >
              {primary.pending ? primary.busy : primary.word}
            </Button>
            {primary.enabled ? null : (
              <span className="m3-sr-only" id={`${said}-verb`}>
                {primary.why}
              </span>
            )}
            <Menu>
              <MenuTrigger render={<IconButton label="More actions" ref={more} />}>
                <Ellipsis />
              </MenuTrigger>
              <MenuPopup align="end" keepMounted={idle}>
                <MenuItem disabled={!other.enabled || other.pending} onClick={other.run}>
                  {other.pending ? other.busy : other.word}
                  {other.enabled ? null : (
                    <Text scale="body-small" tone="variant">
                      {' '}
                      · {other.why}
                    </Text>
                  )}
                </MenuItem>
                <MenuItem onClick={() => setDeleting(true)} tone="error">
                  Delete
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Delete
              onOpenChange={(next) => {
                setDeleting(next)
                if (!next) requestAnimationFrame(() => more.current?.focus())
              }}
              open={deleting}
              status={status}
              workspace={workspace}
            />
          </>
        }
        subtitle={
          <State state={mark}>
            {words}
            {started !== null ? <Num className="session__age"> · {ago(now / 1000 - started, now).text}</Num> : null}
          </State>
        }
        title={workspace.name}
      />
      <div className="session__meta">
        <Text render={<p />} scale="body-small" tone="variant" clip>
          {workspace.machine} · {home(workspace.repo)}
          {URL.test(workspace.repo) ? (
            <>
              {' '}
              ·{' '}
              <a className="m3-hit" href={workspace.repo} rel="noreferrer" target="_blank">
                {workspace.repo.replace(URL, '')}
              </a>
            </>
          ) : null}
        </Text>
        {status?.reached === 'no' ? <Unanswered error={status.error} machine={workspace.machine} /> : null}
        <Talk machine={workspace.machine} />
        {failed ? (
          <ErrorSurface.Inline
            className="session__refusal"
            error={failed}
            title={stop.error ? `${workspace.name} was not stopped` : `${workspace.name} was not resumed`}
          />
        ) : null}
      </div>
    </>
  )
}
