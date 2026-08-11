import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { Reading } from '@/useLooked'

/** D3 §7.2. Off the tailnet the service worker serves the shell and every fetch
 *  fails, and the page drew that as one failure per section — seven copies of
 *  one sentence. **When every read fails the same way, it is one fact about the
 *  connection to `yantrad` rather than N facts about the fleet.**
 *
 *  Identical text, not merely all-failed: the daemon's own envelopes differ per
 *  class, so two classes failing for two reasons is two problems and stays two. */
export function unreachable(reads: Reading<unknown>[]): string | null {
  const failures = reads.flatMap((read) =>
    read.looked === 'failed' ? [read.error] : [],
  )
  if (failures.length === 0 || failures.length !== reads.length) return null
  return failures.every((one) => one === failures[0]) ? failures[0]! : null
}

/** R-23 applied to the browser's own network. It says what it cannot tell, and
 *  it draws none of the data the page had a moment ago — old fleet state on
 *  screen during an outage is the failure this project spends the most effort
 *  avoiding. */
export function Unreachable({ error }: { error: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Nothing here can be reached.</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>
          Every read failed the same way, so this is the connection to `yantrad`
          rather than the fleet. Whether you are off the tailnet or the daemon is
          down is not something this page can tell.
        </span>
        <span className="font-mono text-xs whitespace-pre-wrap">{error}</span>
      </AlertDescription>
    </Alert>
  )
}
