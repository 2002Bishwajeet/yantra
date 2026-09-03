import { useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import type { Listed } from '@/api'
import { Section } from '@/components/Section'
import { Terminal } from '@/components/Terminal'
import { Title } from '@/components/Title'
import { Transcript } from '@/components/Transcript'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { useLooked } from '@/useLooked'
import { useTranscript } from '@/useTranscript'
import { VIEWS } from '@/views'

/** `getRouteApi` rather than the route object: this module is loaded *by* the
 *  route, so importing it back would be a cycle. */
const route = getRouteApi('/w/$name')

/** The width at which the terminal stops lying: eighty columns of about 8.7 px
 *  want some 700 px, so 640 px is short and 768 px is clear (D5 §3.3). It is
 *  Tailwind's `md` and the dashboard breaks at `sm` — a later change to those
 *  breakpoints must leave this number alone. */
const WIDE = '(min-width: 768px)'

/** One workspace, as three tabs the URL carries (D5 §3) — the terminal's socket
 *  reopens on its own, so the URL survives a reload (Y-132).
 *
 *  **The list is read before the socket is opened.** A round trip to the daemon
 *  is cheap and an attach is not: it is an `ssh` to a machine that may be
 *  asleep, and a mistyped name should never cost one. */
export function OneWorkspace() {
  const { name } = route.useParams()
  const { view } = route.useSearch()
  const listed = useLooked<Listed[]>('/api/workspaces')
  const navigate = useNavigate()

  // Read once in a state initialiser rather than subscribed to: a tab that
  // moved under a resize would move under a phone rotating (D5 §3.3).
  const [wide] = useState(() => window.matchMedia(WIDE).matches)
  const tab = view ?? (wide ? 'terminal' : 'transcript')

  // Held by the page rather than by the tab: only the open tab is mounted, and
  // switching to the terminal and back may not spend a second ssh (D5 §4.3).
  // It reads nothing until the transcript tab asks it to.
  const transcript = useTranscript(name)

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
      {/* Links rather than a tab widget: a tab here changes the URL, and that
          is navigation — middle-click and copy-link come free (D5 §3.2). */}
      <nav aria-label="Views">
        <ul className="flex gap-4 text-sm">
          {VIEWS.map((one) => (
            <li key={one}>
              <Link
                aria-current={one === tab ? 'page' : undefined}
                className="text-muted-foreground aria-[current]:text-foreground"
                params={{ name }}
                replace
                search={{ view: one }}
                to="/w/$name"
              >
                {one}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {/* Only the open tab is mounted: mounting the terminal opens an ssh, and
          tmux redraws the pane for whoever attaches next (D5 §3.5). */}
      {tab === 'terminal' && (
        <Terminal name={name} onClose={() => void navigate({ to: '/' })} />
      )}
      {tab === 'transcript' && (
        <Transcript
          machine={entry.machine}
          name={name}
          onRead={(lines, before) => void transcript.read(lines, before)}
          said={transcript.said}
        />
      )}
      {tab === 'spend' && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Spend is not built yet.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </>
  )
}
