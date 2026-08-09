import type { Check, Machine, Readiness as Report } from '@/api'
import { reporting } from '@/columns'
import { Status, type Tone } from '@/components/Status'

/** R-23 is the whole reason there are three tones rather than two: a question
 *  that could not be asked is not a thing that is missing, and painting it like
 *  one sends someone to install what is already there. */
function tone(state: Check['state']): Tone {
  switch (state) {
    case 'present':
      return 'ok'
    case 'absent':
      return 'bad'
    case 'unknown':
      return 'unknown'
  }
}

/** The daemon answers `heartbeat` *present* for any beat that ever arrived — it
 *  serves the reading and names none of ADR-0013 §7's states, which are this
 *  page's. So the page names this one too, out of the machines reading it
 *  already has, rather than parsing the detail or writing the 30 s threshold
 *  down a third time. Without it a machine whose agent died an hour ago reads
 *  *ready* here and *asleep or off* in the table above. */
function beating(machine: Machine | undefined): { tone: Tone; detail: string } {
  if (!machine) {
    return {
      tone: 'unknown',
      detail: 'the tailnet lists no machine of that name, so nothing here is keyed to a beat',
    }
  }
  const said = reporting(machine)
  return { tone: said.tone, detail: said.detail }
}

function reading(check: Check, machine: Machine | undefined) {
  return check.check === 'heartbeat'
    ? beating(machine)
    : { tone: tone(check.state), detail: check.detail }
}

/** [D2](../../docs/design/02-setup.md) §3.1's checks, read rather than run.
 *  Every check is named even where ssh answered nothing, so a short list is
 *  never something a reader has to interpret — the reason is on `reachable`. */
export function Readiness({
  report,
  machine,
}: {
  report: Report
  machine: Machine | undefined
}) {
  return (
    <dl className="flex flex-col gap-2">
      {report.checks.map((check) => {
        const said = reading(check, machine)
        return (
          <div className="flex flex-col gap-0.5" key={check.check}>
            <dt>
              <Status label={check.check} tone={said.tone} />
            </dt>
            <dd className="text-muted-foreground text-xs">{said.detail}</dd>
          </div>
        )
      })}
    </dl>
  )
}
