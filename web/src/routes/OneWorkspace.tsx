import type { Listed } from '@/api'
import { Link } from '@/components/Link'
import { Section } from '@/components/Section'
import { Terminal } from '@/components/Terminal'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { go, machinePath } from '@/router'
import { useLooked } from '@/useLooked'

/** The workspace, which is its terminal — the socket reopens on its own, so the
 *  URL survives a reload (Y-132).
 *
 *  **The list is read before the socket is opened.** A round trip to the daemon
 *  is cheap and an attach is not: it is an `ssh` to a machine that may be
 *  asleep, and a mistyped name should never cost one. */
export function OneWorkspace({ name }: { name: string }) {
  const listed = useLooked<Listed[]>('/api/workspaces')

  // `children` is called only in the `ok` branch, so this draws the two states
  // that are not a workspace in the same words every other section uses.
  if (listed.looked !== 'ok') {
    return (
      <Section title={name} query={listed}>
        {() => null}
      </Section>
    )
  }

  const entry = listed.data.find((one) => one.name === name)

  if (!entry) {
    return (
      <Alert variant="destructive">
        <AlertTitle>No workspace is called {name}.</AlertTitle>
        <AlertDescription>
          <Link to="/">The fleet</Link> lists the ones there are.
        </AlertDescription>
      </Alert>
    )
  }

  if (entry.loaded === 'no') {
    return (
      <Alert variant="destructive">
        <AlertTitle>{name} is not usable.</AlertTitle>
        <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
          {entry.error}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <>
      <p className="text-muted-foreground text-sm">
        on <Link to={machinePath(entry.machine)}>{entry.machine}</Link>
      </p>
      <Terminal name={name} onClose={() => go('/')} />
    </>
  )
}
