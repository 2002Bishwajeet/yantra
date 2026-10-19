import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useApplyUpdate } from '@/api/mutations'
import { aboutQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mono, Text } from '@/m3/text/Text'
import { Reload, refused } from './update'

const RESTART_POLL_MS = 2_000
const STALLED_MS = 180_000

type Asked = { version: string; uptime: number }

/** Y-479. A saved relay or GitHub app id is read when systemd starts yantrad, so this
 *  asks for the Y-368 trigger (ADR-0027 §3), which also installs a newer published release. */
export function RestartNow() {
  const restart = useApplyUpdate()
  const [confirming, setConfirming] = useState(false)
  const [asked, setAsked] = useState<Asked | null>(null)
  const [stalled, setStalled] = useState(false)
  const about = useQuery({ ...aboutQuery(), ...(asked === null ? {} : { refetchInterval: RESTART_POLL_MS }) })
  const running = about.data
  // Uptime only resets on a restart (the same proof Notifications uses).
  const moved = asked !== null && running !== undefined && running.version !== asked.version
  const seen = moved || (asked !== null && running !== undefined && running.uptime_seconds < asked.uptime)
  const polling = asked !== null && !seen

  useEffect(() => {
    if (!polling) return
    const timer = setTimeout(() => setStalled(true), STALLED_MS)
    return () => clearTimeout(timer)
  }, [polling])

  const published = running?.published
  const newer = published?.looked === 'ok' && published.data.newer ? published.data.version : null
  const ask = () =>
    restart.mutate(undefined, {
      onSuccess: () => setAsked({ version: running?.version ?? '', uptime: running?.uptime_seconds ?? 0 }),
    })

  if (restart.isSuccess) {
    if (moved) return <Reload asked={asked.version} running={running.version} />
    return (
      <div role="status">
        <Text render={<p />} scale="body-medium" emphasized>
          {seen ? 'yantrad restarted.' : 'yantrad is restarting. The page reconnects on its own.'}
        </Text>
        {stalled && !seen ? (
          <Text render={<p />} scale="body-small" tone="variant">
            Nothing changed in a few minutes, so the install failed: <Mono>journalctl -u yantra-update</Mono> on the box
            says why.
          </Text>
        ) : null}
      </div>
    )
  }

  return (
    <div>
      {confirming ? (
        <>
          <Text render={<p />} scale="body-small" tone="variant">
            A chat turn in flight dies with the restart. The box installs{' '}
            {newer ? `v${newer}` : 'a newer published release, if there is one,'} as it restarts, so it needs the
            network.
          </Text>
          <Button onClick={() => setConfirming(false)} type="button" variant="text">
            Cancel
          </Button>
          <Button disabled={restart.isPending} onClick={ask} type="button" variant="tonal">
            {restart.isPending ? 'Restarting…' : 'Restart'}
          </Button>
        </>
      ) : (
        <Button onClick={() => setConfirming(true)} type="button" variant="tonal">
          Restart now
        </Button>
      )}
      {restart.error ? (
        <>
          <ErrorSurface.Inline
            error={restart.error}
            title={refused(restart.error, 'The daemon did not answer, so it was not restarted')}
          />
          <Text render={<p />} scale="body-small" tone="variant">
            To restart without installing a release, run <Mono>sudo systemctl restart yantrad</Mono> on the box.
          </Text>
        </>
      ) : null}
    </div>
  )
}
