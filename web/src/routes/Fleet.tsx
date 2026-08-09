import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type {
  Listed,
  Looked,
  Machine,
  MachineSessions,
  Readiness as Report,
  Workspace,
} from '@/api'
import {
  type AgentRow,
  agentColumns,
  agentCommand,
  awaitingTrust,
  machineColumns,
  sessionColumns,
  workspaceColumns,
} from '@/columns'
import { Command } from '@/components/Command'
import { DataTable } from '@/components/DataTable'
import { EditWorkspace } from '@/components/EditWorkspace'
import { NewWorkspace } from '@/components/NewWorkspace'
import { Readiness } from '@/components/Readiness'
import { Section } from '@/components/Section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  agentsWaiting,
  loaded,
  sessionsWaiting,
  useAgents,
  useLooked,
} from '@/useLooked'

export function Fleet() {
  // Four independent readings, so each section stamps its own age; one shared
  // "last updated" would be true of at most one of them.
  const machines = useLooked<Machine[]>('/api/machines')
  const listed = useLooked<Listed[]>('/api/workspaces')
  const workspaces = loaded(listed)
  const sessions = useLooked<MachineSessions[]>('/api/sessions')
  const agents = useAgents(workspaces)
  const readiness = useLooked<Report[]>('/api/readiness')
  // The name, not the row: the workspace the form edits comes from the reading
  // every 30 s, so holding the row would edit against a copy of it.
  const [editing, setEditing] = useState<string | null>(null)
  const chosen =
    workspaces.looked === 'ok'
      ? workspaces.data.find((one) => one.name === editing)
      : undefined

  return (
    <>
      <Section title="Machines" query={machines}>
        {(rows) => (
          <DataTable
            columns={machineColumns}
            rows={rows}
            rowKey={(machine) => machine.name}
            empty="no machines on this tailnet"
          />
        )}
      </Section>

      <Section title="Readiness" query={readiness}>
        {(reports) => <Ready reports={reports} machines={machines} />}
      </Section>

      {/* Each section's command reads the *other* class, so a look that failed
          costs the command its precision and never its honesty. The machines
          reading is read the same way, to say what a button is about to touch. */}
      <Section title="Workspaces" query={listed}>
        {(entries) => (
          <Workspaces
            entries={entries}
            sessions={sessions}
            machines={machines}
            agents={agents}
            edit={setEditing}
          />
        )}
      </Section>

      {/* Beside the create form rather than inside the row it was opened from:
          the fields are the same fields, and a phone gives them the width. */}
      {chosen && (
        <Section title={`Edit ${chosen.name}`} query={machines}>
          {(rows) => (
            <EditWorkspace
              key={chosen.name}
              workspace={chosen}
              machines={rows}
              onClose={() => setEditing(null)}
            />
          )}
        </Section>
      )}

      {/* The machines reading is the picker, so the form draws only where there
          is really something to choose from. */}
      <Section title="New workspace" query={machines}>
        {(rows) => <NewWorkspace machines={rows} />}
      </Section>

      <Section
        title="Sessions"
        query={sessions}
        waiting={sessionsWaiting(sessions)}
      >
        {(answers) => <Sessions answers={answers} workspaces={workspaces} />}
      </Section>

      <Section title="Agents" query={agents} waiting={agentsWaiting(agents)}>
        {(rows) => <Agents rows={rows} />}
      </Section>
    </>
  )
}

/** One card per machine the sweep covered, which is the machines a workspace
 *  names rather than the whole tailnet — a machine none of them names has not
 *  been asked, and saying so is D2's own distinction between *not ready* and
 *  *not looked at*. */
export function Ready({
  reports,
  machines,
}: {
  reports: Report[]
  machines: Looked<Machine[]>
}) {
  const listed = machines.looked === 'ok' ? machines.data : []

  return (
    <div className="flex flex-col gap-4">
      {reports.length === 0 && (
        <p className="text-muted-foreground text-sm">
          no workspace names a machine, so nothing has been asked
        </p>
      )}
      {reports.map((report) => (
        <div className="flex flex-col gap-2" key={report.machine}>
          <Link
            className="text-sm font-medium"
            params={{ machine: report.machine }}
            to="/m/$machine"
          >
            {report.machine}
          </Link>
          <Readiness
            machine={listed.find((one) => one.name === report.machine)}
            report={report}
          />
        </div>
      ))}
    </div>
  )
}

/** A file that did not load is named below the table rather than given a row in
 *  it: `MACHINE` and `ACT` have nothing to put in one, and the edit form could
 *  not repair it anyway — `update` loads before it writes, so the file is the
 *  fix. R-23 is met by naming it loudly with its reason. */
export function Workspaces({
  entries,
  sessions,
  machines,
  agents,
  edit,
}: {
  entries: Listed[]
  sessions: Looked<MachineSessions[]>
  machines: Looked<Machine[]>
  agents: Looked<AgentRow[]>
  edit: ((name: string) => void) | null
}) {
  const rows = entries.flatMap((one) => (one.loaded === 'yes' ? [one] : []))
  const unusable = entries.flatMap((one) => (one.loaded === 'no' ? [one] : []))

  return (
    <div className="flex flex-col gap-2">
      <DataTable
        columns={workspaceColumns(sessions, machines, agents, edit)}
        rows={rows}
        rowKey={(workspace) => workspace.name}
        empty={
          unusable.length === 0
            ? 'no workspaces yet — make one below, or at ~/.config/yantra/workspaces/<name>.toml'
            : 'no file in that directory is a workspace'
        }
      />
      {unusable.map((one) => (
        <Alert key={one.name} variant="destructive">
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {`${one.name} unusable: ${one.error}`}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  )
}

/** I-49 is said twice because it is the only state waiting on a person, and
 *  handed over as a command because ADR-0011 says Yantra never answers it. */
export function Agents({ rows }: { rows: AgentRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        columns={agentColumns}
        rows={rows}
        rowKey={(row) => row.workspace.name}
        empty="no workspaces yet, so there is nothing for an agent to run in"
      />
      {rows.filter(awaitingTrust).map((row) => {
        const attach = agentCommand(row)
        return (
          <Alert key={row.workspace.name}>
            <AlertTitle>
              {row.workspace.name} is holding at claude's trust prompt on{' '}
              {row.workspace.machine}.
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>
                It has done no work and will do none until a person answers the
                dialog, which Yantra never does for you.
              </span>
              {attach && <Command command={attach} />}
            </AlertDescription>
          </Alert>
        )
      })}
    </div>
  )
}

/** The machines that did not answer are named, and the count says how many did
 *  — without which an unreachable machine reads as a machine with no sessions. */
export function Sessions({
  answers,
  workspaces,
}: {
  answers: MachineSessions[]
  workspaces: Looked<Workspace[]>
}) {
  const rows = answers.flatMap((answer) =>
    answer.reached === 'yes'
      ? answer.sessions.map((session) => ({ machine: answer.machine, session }))
      : [],
  )
  const unreachable = answers.filter((answer) => answer.reached === 'no')
  const answered = answers.length - unreachable.length

  return (
    <div className="flex flex-col gap-2">
      <DataTable
        columns={sessionColumns(workspaces)}
        rows={rows}
        rowKey={(row) => `${row.machine} ${row.session.name}`}
        empty="no tmux sessions on the machines that answered"
      />
      <p className="text-muted-foreground text-sm">
        {rows.length} session{rows.length === 1 ? '' : 's'} on {answered} of{' '}
        {answers.length} machines
      </p>
      {unreachable.map((answer) => (
        <Alert key={answer.machine} variant="destructive">
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {`${answer.machine} unreachable: ${answer.error}`}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  )
}
