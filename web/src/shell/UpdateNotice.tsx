import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { aboutQuery } from '@/api/queries'
import { Snackbar } from '@/m3/snackbar/Snackbar'
import { usePrefs, writePrefs } from './prefs'
import './UpdateNotice.css'

const ABOUT = '/settings/about'
// Chat and Terminal: the owner is mid-thought there, so nothing slides in.
const SESSION_ROUTES = new Set(['/w/$name', '/m/$machine/s/$session', '/m/$machine/home'])
const SHOWN_MS = 10_000

/** The release About offers, or null while an update runs. It shares About's
 *  query, so it adds no request; a failed read gives null, and the shell's
 *  NotReached owns a daemon that cannot be reached. A failed update still
 *  offers the release again. */
function useOffered(): { version: string; nightly: boolean } | null {
  const { data } = useQuery(aboutQuery())
  const { published, update, channel } = data ?? {}
  if (published?.looked !== 'ok' || !published.data.newer) return null
  if (update && update.step !== 'failed') return null
  return { version: published.data.version, nightly: channel === 'nightly' }
}

/** Y-752: true from the moment a release is out until About has been opened for it. */
export function useUpdateBadge(): boolean {
  const { updateOpened } = usePrefs()
  const offered = useOffered()
  return offered !== null && offered.version !== updateOpened
}

/** Y-752: says once per release, on a page that is not About, Chat or Terminal. */
export function UpdateSnackbar() {
  const { updateDismissed } = usePrefs()
  const offered = useOffered()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const onSession = useRouterState({ select: (state) => state.matches.some((it) => SESSION_ROUTES.has(it.routeId)) })
  // The pref is written on first sight, so a reload never shows it again;
  // this state keeps it drawn on the page where it appeared.
  const [shown, setShown] = useState<{ version: string; path: string } | null>(null)
  const version = offered?.version ?? null
  const onAbout = pathname === ABOUT

  useEffect(() => {
    if (onAbout && version !== null) writePrefs({ updateOpened: version, updateDismissed: version })
  }, [onAbout, version])

  if (shown && shown.path !== pathname) setShown(null)
  else if (version !== null && !onAbout && !onSession && version !== updateDismissed && shown?.version !== version) {
    setShown({ version, path: pathname })
  }

  const shownVersion = shown?.version
  useEffect(() => {
    if (shownVersion) writePrefs({ updateDismissed: shownVersion })
  }, [shownVersion])

  useEffect(() => {
    if (shown === null) return
    const timer = setTimeout(() => setShown(null), SHOWN_MS)
    return () => clearTimeout(timer)
  }, [shown])

  if (!offered || shown?.version !== offered.version || onAbout || onSession) return null
  return (
    <Snackbar
      action={{
        label: 'Update',
        onClick: () => {
          setShown(null)
          void navigate({ to: '/settings/$category', params: { category: 'about' } })
        },
      }}
      className="update-snackbar"
      onClose={() => setShown(null)}
      tone="status"
    >
      {offered.nightly ? 'A new Yantra Nightly is out' : `Yantra v${offered.version} is out`}
    </Snackbar>
  )
}
