import { useQueryClient } from '@tanstack/react-query'
import { POLL_MS } from '@/api/client'
import { ApiError } from '@/api/errors'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { useTick } from '@/useTick'

const SENTENCE =
  'Every read failed before the daemon answered. This is the connection to yantrad, not the fleet.'

/** The one screen a daemon that cannot be reached draws, in place of whichever
 *  route is open. The reads are swept and keep their own cadence (ADR-0019
 *  bans a timer on a read a person asked for, not on these), so it clears
 *  itself when the daemon comes back. */
export function NotReached(props: { why: string; since: number | null }) {
  const { why, since } = props
  const client = useQueryClient()
  const now = useTick(since !== null)
  const every = `retrying every ${POLL_MS / 1000} s`
  return (
    <ErrorSurface.Page
      action={
        <Button
          render={<a href="https://login.tailscale.com/admin/machines" rel="noreferrer" target="_blank" />}
          role="link"
          variant="text"
        >
          Open Tailscale
        </Button>
      }
      error={new ApiError('network', why, { sentence: SENTENCE })}
      eyebrow="Yantra"
      meta={
        since === null
          ? every
          : `${every} · last good look ${ago((now - since) / 1000, now).text} ago`
      }
      reset={() => void client.invalidateQueries()}
      title="Yantra cannot be reached"
      unknowns={['off the tailnet', 'yantrad down']}
    />
  )
}
