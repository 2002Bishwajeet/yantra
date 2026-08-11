import { Command } from '@/components/Command'
import { Title } from '@/components/Title'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/** Nav's third item, and it has to exist for the other two to be a set. What it
 *  will hold is D3 §11.4 — one machine at a time, on request, `AS_OF` beside the
 *  figure — and that waits on **Y-199**, because the daemon publishes no spend
 *  route yet. Naming the gap and the command that closes it is what this page
 *  can honestly do today. */
export function Usage() {
  return (
    <>
      <Title>Usage</Title>
      <Alert>
        <AlertTitle>The daemon does not answer spend yet.</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>
            `tokens` reads a session's transcript on the machine that ran it, and
            no HTTP route publishes the figure. Until one does, the CLI is the
            only thing that can add it up.
          </span>
          <Command command="yantra tokens <workspace>" />
        </AlertDescription>
      </Alert>
    </>
  )
}
