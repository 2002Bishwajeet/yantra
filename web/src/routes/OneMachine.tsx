import { getRouteApi } from '@tanstack/react-router'
import type {
  Listed,
  Looked,
  Machine,
  MachineSessions,
  Readiness as Report,
  Workspace,
} from '@/api'
import { machineColumns, sessionColumns } from '@/columns'
import { DataTable } from '@/components/DataTable'
import { Readiness } from '@/components/Readiness'
import { Section } from '@/components/Section'
import { Title } from '@/components/Title'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Workspaces } from '@/routes/Fleet'
import { loaded, sessionsWaiting, useAgents, useLooked } from '@/useLooked'

const route = getRouteApi('/m/$machine')

/** One machine, out of the fleet's own readings filtered to it, plus D2.3's
 *  readiness — the one thing on this page the fleet does not already draw.
 *
 *  **No EDIT column.** A workspace is edited where it is listed; this page is
 *  what a machine is doing. */
export function OneMachine() {
  const { machine } = route.useParams()
  const machines = useLooked<Machine[]>('/api/machines')
  const listed = useLooked<Listed[]>('/api/workspaces')
  const sessions = useLooked<MachineSessions[]>('/api/sessions')
  // Filtered before it is asked, not after: the agent class costs one ssh round
  // trip per workspace, and this page draws none of the others.
  const all = loaded(listed)
  const mine: Looked<Workspace[]> =
    all.looked === 'ok'
      ? { ...all, data: all.data.filter((one) => one.machine === machine) }
      : all
  const agents = useAgents(mine)
  const readiness = useLooked<Report>(
    `/api/machines/${encodeURIComponent(machine)}/readiness`,
  )
  // The sweep asks the machines a workspace names, so this route 404s for the
  // rest — which `useLooked` reads as a failed look. Answering it from the
  // workspaces reading says *not asked* rather than *the look broke*, which is
  // the same distinction the sessions section below already draws.
  const asked =
    all.looked !== 'ok' || all.data.some((one) => one.machine === machine)

  return (
    <>
      <Title>{machine}</Title>

      <Section title="Machine" query={machines}>
        {(rows) => {
          const one = rows.find((each) => each.name === machine)
          // A name that is not in the netmap is the URL being wrong or the
          // machine being gone, and both are worth saying rather than drawing
          // an empty table under a title that looks like a machine.
          return one ? (
            <DataTable
              columns={machineColumns}
              rows={[one]}
              rowKey={(each) => each.name}
              empty=""
            />
          ) : (
            <Alert variant="destructive">
              <AlertTitle>
                This tailnet has no machine called {machine}.
              </AlertTitle>
              <AlertDescription>
                Tailscale lists the machines, so a name it does not carry is one
                Yantra cannot reach either.
              </AlertDescription>
            </Alert>
          )
        }}
      </Section>

      {asked ? (
        <Section title="Readiness" query={readiness}>
          {(report) => (
            <Readiness
              machine={
                machines.looked === 'ok'
                  ? machines.data.find((one) => one.name === machine)
                  : undefined
              }
              report={report}
            />
          )}
        </Section>
      ) : (
        // The workspaces reading is what decided this, so it is the one whose
        // age the section stamps.
        <Section title="Readiness" query={listed}>
          {() => (
            <Alert>
              <AlertTitle>
                No workspace names this machine, so nothing has asked it
                anything.
              </AlertTitle>
              <AlertDescription>
                The sweep asks the machines a workspace names. Give this one a
                workspace and the next pass covers it; `yantra doctor
                &lt;machine&gt;` asks it now without one.
              </AlertDescription>
            </Alert>
          )}
        </Section>
      )}

      <Section title="Workspaces" query={listed}>
        {(entries) => (
          <Workspaces
            entries={entries.filter(
              (one) => one.loaded === 'yes' && one.machine === machine,
            )}
            sessions={sessions}
            machines={machines}
            agents={agents}
            edit={null}
          />
        )}
      </Section>

      <Section
        title="Sessions"
        query={sessions}
        waiting={sessionsWaiting(sessions).filter((one) => one === machine)}
      >
        {(answers) => {
          const answer = answers.find((each) => each.machine === machine)
          if (answer?.reached === 'no') {
            return (
              <Alert variant="destructive">
                <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                  {`${machine} unreachable: ${answer.error}`}
                </AlertDescription>
              </Alert>
            )
          }
          // The sessions class is swept per machine named by a workspace, so a
          // machine no workspace names is absent rather than empty.
          return (
            <DataTable
              columns={sessionColumns(loaded(listed))}
              rows={(answer?.sessions ?? []).map((session) => ({
                machine,
                session,
              }))}
              rowKey={(row) => `${row.machine} ${row.session.name}`}
              empty={
                answer
                  ? 'no tmux sessions on this machine'
                  : 'no workspace names this machine, so nothing has looked at it'
              }
            />
          )
        }}
      </Section>
    </>
  )
}
