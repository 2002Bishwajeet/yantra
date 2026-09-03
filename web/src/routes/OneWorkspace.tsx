import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import type { Listed } from '@/api'
import { Section } from '@/components/Section'
import { Terminal } from '@/components/Terminal'
import { Title } from '@/components/Title'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useLooked } from '@/useLooked'

/** `getRouteApi` rather than the route object: this module is loaded *by* the
 *  route, so importing it back would be a cycle. */
const route = getRouteApi('/w/$name')

/** The workspace, which is its terminal — the socket reopens on its own, so the
 *  URL survives a reload (Y-132).
 *
 *  **The list is read before the socket is opened.** A round trip to the daemon
 *  is cheap and an attach is not: it is an `ssh` to a machine that may be
 *  asleep, and a mistyped name should never cost one. */
export function OneWorkspace() {
  const { name } = route.useParams()
  const listed = useLooked<Listed[]>('/api/workspaces')
  const navigate = useNavigate()

  // The `h1` is the route's, so it is drawn before the list decides whether
  // there is anything under it — D3 §5.2 wants one on every branch.
  const heading = <Title>{name}</Title>

  // `children` is called only in the `ok` branch, so this draws the two states
  // that are not a workspace in the same words every other section uses.
  if (listed.looked !== 'ok') {
    return (
      <>
        {heading}
        <Section title="Workspace" query={listed}>
          {() => null}
        </Section>
      </>
    )
  }

  const entry = listed.data.find((one) => one.name === name)

  if (!entry) {
    return (
      <>
        {heading}
        <Alert variant="destructive">
          <AlertTitle>No workspace is called {name}.</AlertTitle>
          <AlertDescription>
            <Link to="/">The fleet</Link> lists the ones there are.
          </AlertDescription>
        </Alert>
      </>
    )
  }

  if (entry.loaded === 'no') {
    return (
      <>
        {heading}
        <Alert variant="destructive">
          <AlertTitle>{name} is not usable.</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span className="font-mono text-xs whitespace-pre-wrap">
              {entry.error}
            </span>
            {/* D3 §7.5: naming the error and offering nothing is what sent
                people to a terminal. `edit` cannot repair this file, so the
                bytes are the only fix (ADR-0020). */}
            <Link params={{ name }} to="/w/$name/repair">
              Repair the file
            </Link>
          </AlertDescription>
        </Alert>
      </>
    )
  }

  return (
    <>
      {heading}
      <p className="text-muted-foreground text-sm">
        on{' '}
        <Link to="/m/$machine" params={{ machine: entry.machine }}>
          {entry.machine}
        </Link>
      </p>
      <Terminal name={name} onClose={() => void navigate({ to: '/' })} />
    </>
  )
}
