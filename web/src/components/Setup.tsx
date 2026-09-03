import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Looked, Machine, Readiness as Report } from '@/api'
import { Readiness } from '@/components/Readiness'
import { Section } from '@/components/Section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { Reading } from '@/useLooked'

/** What a tap produced. `no` is not *nothing is missing*: it is a question
 *  nobody has asked, which R-23 keeps distinct from an answer. */
type Asked =
  | { asked: 'no' }
  | { asked: 'asking' }
  | { asked: 'ok'; report: Report }
  | { asked: 'refused'; said: string }

/** `POST /api/machines/{name}/readiness`, which is the only thing that can fill
 *  this page. The readiness **sweep** takes its machine list from the
 *  workspaces, so a fresh install asks nobody: `GET /api/readiness` answers
 *  `[]` and the per-machine `GET` 404s for every name. The `POST` was built
 *  with no 404 for exactly this case (Y-197), and it answers the same envelope.
 *
 *  Outside the component for `useLooked`'s reason: the React Compiler bails out
 *  of any function whose try/catch holds a conditional. */
async function ask(machine: string): Promise<Asked> {
  const path = `/api/machines/${encodeURIComponent(machine)}/readiness`
  try {
    const response = await fetch(path, { method: 'POST' })
    if (!response.ok) {
      return { asked: 'refused', said: `${path} answered ${response.status}` }
    }
    const answer = (await response.json()) as Looked<Report>
    if (answer.looked === 'ok') return { asked: 'ok', report: answer.data }
    return {
      asked: 'refused',
      said:
        answer.looked === 'failed'
          ? answer.error
          : 'The daemon answered that it has not looked, which this route cannot say.',
    }
  } catch (cause) {
    return { asked: 'refused', said: String(cause) }
  }
}

/** One machine, asked only when you tap. **The cost is why**: each check is an
 *  ssh round trip at `ConnectTimeout=10`, paid while you wait, and a machine
 *  that is asleep costs the whole ten seconds before it answers unknowns. A
 *  tailnet also carries phones and tablets that will never hold a workspace, so
 *  asking all of them on open would spend most of that on nobody's question —
 *  D3 §11.4's rule, on the page §4.8 applies it to. */
function One({ machine }: { machine: Machine }) {
  const [asked, setAsked] = useState<Asked>({ asked: 'no' })
  const asking = asked.asked === 'asking'

  const tap = async () => {
    setAsked({ asked: 'asking' })
    setAsked(await ask(machine.name))
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">{machine.name}</h3>
        <span className="text-muted-foreground text-xs">{machine.os}</span>
        <div className="ms-auto">
          <Button disabled={asking} onClick={tap} size="sm" variant="outline">
            {asking ? 'asking…' : asked.asked === 'no' ? 'Check' : 'Check again'}
          </Button>
        </div>
      </div>

      {/* D3 §7: an ssh round trip that takes ten seconds may not look like a
          page that has finished. */}
      <div aria-live="polite" className="flex flex-col gap-2">
        {asked.asked === 'no' && (
          <p className="text-muted-foreground text-xs">
            Not asked yet. A check costs one ssh round trip, so this page asks a
            machine when you tap and never on its own.
          </p>
        )}
        {asking && (
          <p className="text-muted-foreground text-xs">
            waiting on {machine.name} — ssh gives it ten seconds
          </p>
        )}
        {asked.asked === 'refused' && (
          <Alert variant="destructive">
            <AlertTitle className="text-xs">
              The machine was not asked.
            </AlertTitle>
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
              {asked.said}
            </AlertDescription>
          </Alert>
        )}
        {asked.asked === 'ok' && (
          <Readiness machine={machine} report={asked.report} />
        )}
      </div>
    </section>
  )
}

/** D3 §4.8: when no workspace exists, `/` is the setup checklist rather than the
 *  work page. The alternative sends a fresh install to a form whose `up` will
 *  fail, because `claude` is not installed on the target and nothing said so —
 *  the gap R13 §6 named as *the interface has never been given a way to say what
 *  is still missing*.
 *
 *  The machine list is the tailnet's, since the readiness sweep has none to
 *  give here (see [`ask`]). It returns to the work page on the first workspace. */
export function Setup({ machines }: { machines: Reading<Machine[]> }) {
  return (
    <>
      <Alert>
        <AlertTitle>No workspace exists yet.</AlertTitle>
        <AlertDescription>
          A workspace names a machine and a directory, and `up` opens an agent
          there. Check a machine first: `up` fails on one that has no tmux and no
          agent CLI, and nothing else here would tell you that.
        </AlertDescription>
      </Alert>

      <Section query={machines} title="Machines">
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              this tailnet lists no machine, so there is nothing to set up yet
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {rows.map((machine) => (
                <One key={machine.name} machine={machine} />
              ))}
            </div>
          )
        }
      </Section>

      <div>
        <Button render={<Link to="/new" />} size="sm" variant="outline">
          ＋ New workspace
        </Button>
      </div>
    </>
  )
}
