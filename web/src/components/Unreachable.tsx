import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

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
