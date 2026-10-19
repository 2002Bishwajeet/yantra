import { useApplyUpdate } from '@/api/mutations'
import type { ApiError } from '@/api/errors'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mono, Text } from '@/m3/text/Text'

/** Y-479. A saved relay or GitHub app id is read when systemd starts yantrad,
 *  so this asks for the Y-368 trigger (ADR-0027 §3). The trigger carries no
 *  version: a newer published release is installed as well. State lives in
 *  the mutation, so closing the sheet that holds this resets it. */
export function RestartNow() {
  const restart = useApplyUpdate()

  if (restart.isSuccess) {
    return (
      <div role="status">
        <Text render={<p />} scale="body-medium" emphasized>
          yantrad is restarting. The page reconnects on its own.
        </Text>
        <Text render={<p />} scale="body-small" tone="variant">
          If a newer release is published, it is installed too.
        </Text>
      </div>
    )
  }

  return (
    <div>
      <Button disabled={restart.isPending} onClick={() => restart.mutate()} type="button" variant="tonal">
        {restart.isPending ? 'Restarting…' : 'Restart now'}
      </Button>
      <Text render={<p />} scale="body-small" tone="variant">
        The box fetches the current release again, so it needs the network.
      </Text>
      {restart.error ? (
        <>
          <ErrorSurface.Inline error={restart.error} title={refused(restart.error)} />
          <Text render={<p />} scale="body-small" tone="variant">
            On the appliance, <Mono>sudo systemctl restart yantrad</Mono> does the same.
          </Text>
        </>
      ) : null}
    </div>
  )
}

function refused(error: ApiError): string {
  if (error.kind === 'network') return 'The daemon did not answer, so it was not restarted'
  if (error.status === 409) return 'This box cannot restart itself from here. install.sh did not install its updater'
  return 'The restart was refused'
}
