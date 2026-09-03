import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ToolCall, Turn } from '@/api'
import { Stamp } from '@/components/Age'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTick } from '@/useTick'
import { LINES, type Said } from '@/useTranscript'

/** D5 §8's four verbs. A tool this list does not name reads as its own name,
 *  which is the honest fallback and what the far side sent. */
const VERBS: Record<string, string> = {
  Bash: 'ran',
  Edit: 'edited',
  Write: 'edited',
  Read: 'read',
  WebFetch: 'read',
  Grep: 'searched',
  Glob: 'searched',
  WebSearch: 'searched',
}

// Six digits unseparated cannot be compared at a glance, which is the only
// thing anyone does with a record count.
const count = (of: number) => of.toLocaleString()

/** What the agent in this workspace has been saying (D5 §4).
 *
 *  **Mounting it is the request.** Only the open tab is mounted (§3.5), so this
 *  component exists exactly when a person opened the transcript — and a read is
 *  an ssh, which is why nothing here polls (§4.3). */
export function Transcript({
  machine,
  name,
  said,
  onRead,
}: {
  machine: string
  name: string
  said: Said
  onRead: (lines: number, before: number) => void
}) {
  useEffect(() => {
    if (said.said === 'no') onRead(LINES, 0)
  }, [said.said, onRead])

  const now = useTick(said.said === 'held')

  const refresh = () => onRead(LINES, 0)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {/* Records, never turns: the far side counts what it selected and the
            projection drops some of it (D5 §2.3). */}
        <span className="text-muted-foreground text-xs">
          {said.said === 'held' &&
            `the last ${count(said.asked)} of ${count(said.total)} records`}
        </span>
        <span className="flex items-center gap-3 text-xs">
          {said.said === 'held' && (
            <span className="text-muted-foreground">
              read <Stamp now={now} stamp={said.at} />
            </span>
          )}
          {/* D5 §4.6: on a narrow screen this is the only thing that reaches
              the pane without going through the tab bar. */}
          <Link params={{ name }} replace search={{ view: 'terminal' }} to="/w/$name">
            Take control
          </Link>
          {said.said !== 'no' && said.said !== 'reading' && (
            <Button onClick={refresh} size="xs" variant="outline">
              Refresh
            </Button>
          )}
        </span>
      </div>

      <div aria-live="polite">
        {/* §4.3: a POST that spends an ssh round trip must not look like a page
            that has finished. `/usage`'s sentence, since it is the same read. */}
        {said.said === 'reading' && (
          <div className="flex flex-col gap-2" data-slot="reading">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
            <span className="text-muted-foreground text-xs">
              reading the transcript on {machine} over ssh
            </span>
          </div>
        )}

        {said.said === 'nothing' && (
          <Alert>
            <AlertTitle>No agent has written a turn here.</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>
                A transcript appears on the agent's first message, not when it
                launches.
              </span>
              {/* The daemon's own sentence, which names the session where there
                  is one — D5 §4.5's second row. */}
              <span className="font-mono text-xs whitespace-pre-wrap">
                {said.because}
              </span>
            </AlertDescription>
          </Alert>
        )}

        {said.said === 'refused' && (
          <Alert variant="destructive">
            <AlertTitle>The transcript could not be read.</AlertTitle>
            {/* The daemon's whole chain: it names the machine, the command and
                what ssh said, which is the actionable half. */}
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
              {said.because}
            </AlertDescription>
          </Alert>
        )}

        {said.said === 'held' && (
          <div className="flex flex-col gap-3">
            {said.asked < said.total && (
              <Button
                disabled={said.paging}
                onClick={() =>
                  onRead(
                    // The last window asks for what is left rather than for a
                    // full one: past the start of the file `tail` stops
                    // skipping, so a full window would repeat what is drawn.
                    Math.min(LINES, said.total - said.asked),
                    said.asked,
                  )
                }
                size="xs"
                variant="outline"
              >
                {said.paging ? 'reading…' : 'Older'}
              </Button>
            )}

            {said.turns.map((turn, index) => (
              <OneTurn key={index} turn={turn} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function OneTurn({ turn }: { turn: Turn }) {
  return (
    <article className="flex flex-col gap-1 border-t pt-3">
      <header className="flex items-baseline gap-2 text-xs">
        <span className="font-medium">{turn.who}</span>
        {/* A few records carry no timestamp, and a turn with none prints none
            rather than *unknown* (D5 §4.1). */}
        {turn.at !== null && (
          <span className="text-muted-foreground">
            <Stamp stamp={turn.at} />
          </span>
        )}
      </header>
      {/* Text, never Markdown: a parser inside a held budget, an XSS surface on
          text a machine wrote, and code fences that want a highlighter next
          (D5 §4.1). Whitespace is kept and long lines wrap. */}
      {turn.text !== '' && (
        <p className="text-sm break-words whitespace-pre-wrap">{turn.text}</p>
      )}
      {turn.tools.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {turn.tools.map((call, index) => (
            <li key={index}>
              <Call call={call} />
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/** One line: the tool as a verb and the one string it acted on (D5 §4.2).
 *  Expanded, it is the target as the daemon sent it — up to the far side's
 *  120-character cap, which marks a target it cut. The whole command is in the
 *  terminal and in the file, and this page never claims to be either. */
function Call({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const verb = VERBS[call.name] ?? call.name

  // Nothing to expand to: a call whose input names none of the eight keys is
  // its name alone (D5 §4.2).
  if (call.target === null) {
    return <span className="text-muted-foreground text-xs">{verb}</span>
  }

  return (
    <button
      aria-expanded={open}
      className="text-muted-foreground flex w-full items-baseline gap-1.5 text-left text-xs"
      onClick={() => setOpen(!open)}
      type="button"
    >
      <span className="shrink-0">{verb}</span>
      {/* The same string either way — only its wrapping changes, which is why
          this is not `ui/collapsible`: there is no panel to mount. */}
      <span
        className={
          open ? 'font-mono break-all whitespace-pre-wrap' : 'truncate font-mono'
        }
      >
        {call.target}
      </span>
    </button>
  )
}
