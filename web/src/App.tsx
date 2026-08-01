import type { Machine, MachineSessions, Workspace } from '@/api'
import { machineColumns, sessionColumns, workspaceColumns } from '@/columns'
import { DataTable } from '@/components/DataTable'
import { Section } from '@/components/Section'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useLooked } from '@/useLooked'

export default function App() {
  // Three independent readings, so each section stamps its own age; one shared
  // "last updated" would be true of at most one of them.
  const machines = useLooked<Machine[]>('/api/machines')
  const workspaces = useLooked<Workspace[]>('/api/workspaces')
  const sessions = useLooked<MachineSessions[]>('/api/sessions')

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="font-heading text-2xl font-semibold">Yantra</h1>

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

      <Section title="Workspaces" query={workspaces}>
        {(rows) => (
          <DataTable
            columns={workspaceColumns}
            rows={rows}
            rowKey={(workspace) => workspace.name}
            empty="no workspaces yet — make one at ~/.config/yantra/workspaces/<name>.toml"
          />
        )}
      </Section>

      <Section title="Sessions" query={sessions}>
        {(answers) => <Sessions answers={answers} />}
      </Section>
    </main>
  )
}

/** The machines that did not answer are named, and the count says how many did
 *  — without which an unreachable machine reads as a machine with no sessions. */
function Sessions({ answers }: { answers: MachineSessions[] }) {
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
        columns={sessionColumns}
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
