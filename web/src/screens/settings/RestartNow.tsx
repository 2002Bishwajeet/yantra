import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useApplyUpdate } from '@/api/mutations'
import { aboutQuery } from '@/api/queries'
import type { ApiError } from '@/api/errors'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mono, Text } from '@/m3/text/Text'

const RESTART_POLL_MS = 2_000

/** Y-479. A saved relay or GitHub app id is read when systemd starts yantrad,
 *  so this asks for the Y-368 trigger (ADR-0027 §3). The trigger carries no
 *  version: a newer published release is installed as well. State lives in
 *  the mutation, so closing the sheet that holds this resets it. The page
 *  says before the click that a newer release comes with it, and offers a
 *  reload once the running version moved (ADR-0027 §2, §5). */
export function RestartNow() {
  const restart = useApplyUpdate()
  // The version this page saw when the person asked.
  const [asked, setAsked] = useState<string | null>(null)
  const about = useQuery({ ...aboutQuery(), ...(asked === null ? {} : { refetchInterval: RESTART_POLL_MS }) })
  const published = about.data?.published
  const newer = published?.looked === 'ok' && published.data.newer ? published.data.version : null

  if (restart.isSuccess) {
    const running = about.data?.version
    if (asked !== null && running !== undefined && running !== asked) {
      return (
        <div role="status">
          <Text render={<p />} scale="body-medium" emphasized>
            yantrad <Mono>{running}</Mono> is running. This page is still the <Mono>{asked}</Mono> dashboard.
          </Text>
          <Button onClick={() => location.reload()} type="button" variant="tonal">
            Reload
          </Button>
        </div>
      )
    }
    return (
      <div role="status">
        <Text render={<p />} scale="body-medium" emphasized>
          yantrad is restarting. The page reconnects on its own.
        </Text>
        <Text render={<p />} scale="body-small" tone="variant">
          {newer ? <>v{newer} is installed too.</> : 'If a newer release is published, it is installed too.'}
        </Text>
      </div>
    )
  }

  return (
    <div>
      <Button disabled={restart.isPending} onClick={() => restart.mutate(undefined, { onSuccess: () => setAsked(about.data?.version ?? null) })} type="button" variant="tonal">
        {restart.isPending ? 'Restarting…' : 'Restart now'}
      </Button>
      <Text render={<p />} scale="body-small" tone="variant">
        {newer
          ? `The box installs v${newer} as it restarts, and a chat turn in flight dies with it.`
          : 'The box fetches the current release again, so it needs the network.'}
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
