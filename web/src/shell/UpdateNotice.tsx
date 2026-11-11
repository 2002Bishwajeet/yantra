import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { aboutQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Text } from '@/m3/text/Text'
import { usePrefs, writePrefs } from './prefs'
import './UpdateNotice.css'

const ABOUT = '/settings/about'

/** Y-712: says on every page when the box can update. It shares About's query,
 *  so it adds no request, and a failed read draws nothing: the shell's
 *  NotReached owns a daemon that cannot be reached. */
export function UpdateNotice() {
  const { updateDismissed } = usePrefs()
  const onAbout = useRouterState({ select: (state) => state.location.pathname === ABOUT })
  const { data } = useQuery(aboutQuery())
  const { published, update, channel } = data ?? {}
  if (onAbout || published?.looked !== 'ok' || !published.data.newer) return null
  if (update && update.step !== 'failed') return null
  const { version } = published.data
  if (version === updateDismissed) return null
  return (
    <section aria-label="Update available" className="update-notice">
      <div className="update-notice__text">
        <Text scale="title-medium" emphasized>
          Update to v{version}
        </Text>
        <Text scale="body-medium" tone="variant">
          A newer yantrad is out on the {channel ?? 'release'} channel
        </Text>
      </div>
      <Button role="link" render={<Link params={{ category: 'about' }} to="/settings/$category" />} variant="tonal">
        Update
      </Button>
      <IconButton label="Dismiss" onClick={() => writePrefs({ updateDismissed: version })}>
        <X />
      </IconButton>
    </section>
  )
}
