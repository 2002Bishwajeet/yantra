import { useQueryClient } from '@tanstack/react-query'
import { POLL_MS, REFUSED } from '@/api/client'
import { ApiError, isOwnAddress } from '@/api/errors'
import { readAgain } from '@/api/queries'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { useTick } from '@/useTick'

/** The daemon refused this device, so the cause is the address it came from;
 *  the proxy answered for the daemon, so the cause is the daemon; anything
 *  else failed before an answer, so the cause is this device's way there. */
export function causeOf(why: string) {
  if (why.startsWith(REFUSED)) {
    const said = why.slice(REFUSED.length + 2)
    return isOwnAddress(403, said)
      ? {
          daemon: true,
          said,
          title: 'Open Yantra at its HTTPS address',
          sentence:
            "This page reaches Yantra from the Yantra machine's own address, where no one can sign in. Open the dashboard's https:// address instead.",
        }
      : {
          daemon: true,
          said,
          title: 'Yantra refused this device',
          sentence: 'The Yantra machine answered, and it will not serve this device. Details say why.',
        }
  }
  if (/HTTP 50[234]\b/.test(why)) {
    return {
      daemon: true,
      said: why,
      title: 'yantrad is not answering',
      sentence: `The Yantra machine answered, but its daemon did not. Yantra tries again every ${POLL_MS / 1000} s.`,
    }
  }
  return {
    daemon: false,
    said: why,
    title: 'This device cannot reach Yantra',
    sentence: `It may be off the tailnet. Turn Tailscale on and Yantra tries again every ${POLL_MS / 1000} s.`,
  }
}

/** The one screen a daemon that cannot be reached draws, in place of whichever
 *  route is open. The reads are swept and keep their own cadence (ADR-0019
 *  bans a timer on a read a person asked for, not on these), so it clears
 *  itself when the daemon comes back. Try again is the dashboard's, so the status
 *  reads the workspace list unlocks are asked again too. */
export function NotReached(props: { why: string; since: number | null }) {
  const { why, since } = props
  const client = useQueryClient()
  const now = useTick(since !== null)
  const every = `retrying every ${POLL_MS / 1000} s`
  const cause = causeOf(why)
  return (
    <ErrorSurface.Page
      action={
        cause.daemon ? undefined : (
          <Button
            render={<a href="https://login.tailscale.com/admin/machines" rel="noreferrer" target="_blank" />}
            role="link"
          >
            Open Tailscale
          </Button>
        )
      }
      error={new ApiError('network', cause.said, { sentence: cause.sentence })}
      eyebrow="Yantra"
      meta={
        since === null
          ? every
          : `${every} · last good look ${ago((now - since) / 1000, now).text} ago`
      }
      reset={() => void readAgain(client)}
      title={cause.title}
    />
  )
}
