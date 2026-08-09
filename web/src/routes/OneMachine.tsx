import { getRouteApi } from '@tanstack/react-router'
import type { Listed, Machine, MachineSessions } from '@/api'
import { machineColumns, sessionColumns } from '@/columns'
import { DataTable } from '@/components/DataTable'
import { Section } from '@/components/Section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Workspaces } from '@/routes/Fleet'
import { loaded, sessionsWaiting, useLooked } from '@/useLooked'

const route = getRouteApi('/m/$machine')

/** One machine, out of the same three readings the fleet draws. Nothing here
 *  asks the daemon anything new — readiness (D2.1) is what will.
 *
 *  **No EDIT column.** A workspace is edited where it is listed; this page is
 *  what a machine is doing. */
export function OneMachine() {
  const { machine } = route.useParams()
  const machines = useLooked<Machine[]>('/api/machines')
  const listed = useLooked<Listed[]>('/api/workspaces')
  const sessions = useLooked<MachineSessions[]>('/api/sessions')

  return (
    <>
      <Section title={machine} query={machines}>
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

      <Section title="Workspaces" query={listed}>
        {(entries) => (
          <Workspaces
            entries={entries.filter(
              (one) => one.loaded === 'yes' && one.machine === machine,
            )}
            sessions={sessions}
            machines={machines}
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
