import type { Looked, Machine, MachineSessions, Workspace } from '@/api'
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
import { Section } from '@/components/Section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useAgents, useLooked } from '@/useLooked'

export default function App() {
  // Four independent readings, so each section stamps its own age; one shared
  // "last updated" would be true of at most one of them.
  const machines = useLooked<Machine[]>('/api/machines')
  const workspaces = useLooked<Workspace[]>('/api/workspaces')
  const sessions = useLooked<MachineSessions[]>('/api/sessions')
  const agents = useAgents(workspaces)

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

      {/* Each section's command reads the *other* class, so a look that failed
          costs the command its precision and never its honesty. */}
      <Section title="Workspaces" query={workspaces}>
        {(rows) => (
          <DataTable
            columns={workspaceColumns(sessions)}
            rows={rows}
            rowKey={(workspace) => workspace.name}
            empty="no workspaces yet — make one at ~/.config/yantra/workspaces/<name>.toml"
          />
        )}
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
    </main>
  )
}

/** The machines the next sweep will pay an ssh timeout for — Y-100's evidence
 *  that an age near the threshold is ordinary rather than a refresh that died. */
function sessionsWaiting(sessions: Looked<MachineSessions[]>): string[] {
  return sessions.looked === 'ok'
    ? sessions.data.flatMap((answer) =>
        answer.reached === 'no' ? [answer.machine] : [],
      )
    : []
}

/** The same for the agent class, which reaches the same machines and pays the
 *  same timeout — deduplicated, since it answers per workspace. */
function agentsWaiting(agents: Looked<AgentRow[]>): string[] {
  if (agents.looked !== 'ok') return []
  return [
    ...new Set(
      agents.data.flatMap((row) =>
        row.status?.reached === 'no' ? [row.status.machine] : [],
      ),
    ),
  ]
}

/** I-49 is said twice because it is the only state waiting on a person, and
 *  handed over as a command because ADR-0011 says Yantra never answers it. */
function Agents({ rows }: { rows: AgentRow[] }) {
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
function Sessions({
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
