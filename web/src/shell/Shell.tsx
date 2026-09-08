import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { HeadContent, Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router'
import { ArrowLeft, Plus } from 'lucide-react'
import { useResetOnRouteChange, useViewing } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { Fab } from '@/m3/fab/Fab'
import { IconButton } from '@/m3/icon-button/IconButton'
import { LiveRegion } from '@/m3/live/Live'
import { BarDestination, NavigationBar } from '@/m3/navigation-bar/NavigationBar'
import { NavigationRail, RailDestination } from '@/m3/navigation-rail/NavigationRail'
import { Pill, PillGroup } from '@/m3/pill/Pill'
import { Text } from '@/m3/text/Text'
import { TopAppBar } from '@/m3/top-app-bar/TopAppBar'
import { StatusAnnouncer } from './Announce'
import { DESTINATIONS, isDestination, isRailed } from './destinations'
import { useFormFactor } from './formFactor'
import { Bell } from './Bell'
import { Palette } from './Palette'
import { usePrefs } from './prefs'
import { NotReached } from './NotReached'
import { useReached } from './reached'
import { SessionsRail } from './SessionsRail'
import { useScreenTitle, useScreenTitleOverride } from './title'
import './Shell.css'

// The menu, the popover and the sheet carry Base UI's popup machinery, which
// the first paint of `/` never draws. Each loads after it, behind a 44 px slot.
const Account = lazy(() => import('./Account').then((it) => ({ default: it.Account })))
const BellPopover = lazy(() => import('./BellPopover').then((it) => ({ default: it.BellPopover })))
const NotificationsSheet = lazy(() =>
  import('./NotificationsSheet').then((it) => ({ default: it.NotificationsSheet })),
)
const slot = <span aria-hidden="true" className="shell__slot" />

const usePathname = () => useRouterState({ select: (state) => state.location.pathname })

/** The route's own name, off the `<title>` its `head` wrote. */
const useTitle = () => {
  const override = useScreenTitleOverride()
  const named = useRouterState({
    select: (state) => {
      const meta = state.matches.at(-1)?.meta?.find((one) => one?.title)
      return meta?.title?.replace(/ · Yantra$/, '') ?? 'Yantra'
    },
  })
  return override ?? named
}

/** The outlet, under one boundary that a navigation resets — or, when nothing
 *  reached the daemon, the one screen that says so in its place. */
function Page({ down }: { down: ReactNode }) {
  return (
    <main className="shell__main">
      <ErrorBoundary layout="page" {...useResetOnRouteChange()}>
        {down ?? <Outlet />}
      </ErrorBoundary>
    </main>
  )
}

function Guarded(props: { title: string; children: ReactNode }) {
  const { title, children } = props
  return (
    <ErrorBoundary layout="inline" title={title}>
      {children}
    </ErrorBoundary>
  )
}

function DesktopBar() {
  return (
    <header className="shell__bar">
      <Link className="shell__wordmark" to="/">
        <span aria-hidden="true" className="shell__disc" />
        Yantra
      </Link>
      <nav aria-label="Main">
        <PillGroup>
          {DESTINATIONS.map((one) => (
            <Pill
              key={one.to}
              role="link"
              render={<Link
                  activeOptions={{ exact: one.to === '/' }}
                  activeProps={{ 'aria-current': 'page' }}
                  to={one.to}
                />
              }
            >
              {one.label}
            </Pill>
          ))}
        </PillGroup>
      </nav>
      <div className="shell__actions">
        <Guarded title="Search could not be drawn">
          <Palette />
        </Guarded>
        <Guarded title="Notifications could not be drawn">
          <Suspense fallback={slot}>
            <BellPopover />
          </Suspense>
        </Guarded>
        <Suspense fallback={slot}>
          <Account />
        </Suspense>
      </div>
    </header>
  )
}

// The bell names the sheet, and the sheet is in the tree from the first paint
// so that the name resolves to something.
const SHEET = 'shell-notifications'

function TabletRail({ onToggle, open }: { onToggle: () => void; open: boolean }) {
  return (
    <NavigationRail
      fab={
        <Fab label="New session" role="link" render={<Link to="/new" />}>
          <Plus />
        </Fab>
      }
      trailing={
        <>
          <Guarded title="Notifications could not be drawn">
            <Bell
              aria-controls={SHEET}
              aria-expanded={open}
              aria-haspopup="dialog"
              onClick={onToggle}
            />
          </Guarded>
          <Suspense fallback={slot}>
            <Account />
          </Suspense>
        </>
      }
    >
      {DESTINATIONS.map((one) => (
        <RailDestination
          icon={one.icon}
          key={one.to}
          role="link"
          render={<Link
              activeOptions={{ exact: one.to === '/' }}
              activeProps={{ 'aria-current': 'page' }}
              to={one.to}
            />
          }
        >
          {one.label}
        </RailDestination>
      ))}
    </NavigationRail>
  )
}

/** The app bar is the page's h1 on the phone; Shell.css hides the screen's. */
function PhoneBar({ top }: { top: boolean }) {
  const title = useTitle()
  const router = useRouter()
  const back = () => {
    if (router.history.canGoBack()) router.history.back()
    else void router.navigate({ to: '/' })
  }
  return (
    <TopAppBar
      actions={
        top ? (
          <>
            <Guarded title="Notifications could not be drawn">
              <Bell role="link" render={<Link to="/notifications" />} />
            </Guarded>
            <Suspense fallback={slot}>
              <Account />
            </Suspense>
          </>
        ) : undefined
      }
      leading={
        top ? undefined : (
          <IconButton label="Back" onClick={back}>
            <ArrowLeft />
          </IconButton>
        )
      }
      title={title}
    />
  )
}

function PhoneBottom() {
  return (
    <>
      <Fab className="shell__fab" label="New session" role="link" render={<Link to="/new" />}>
        <Plus />
      </Fab>
      <NavigationBar>
        {DESTINATIONS.map((one) => (
          <BarDestination
            icon={one.icon}
            key={one.to}
            role="link"
            render={<Link
                activeOptions={{ exact: one.to === '/' }}
                activeProps={{ 'aria-current': 'page' }}
                to={one.to}
              />
            }
          >
            {one.label}
          </BarDestination>
        ))}
      </NavigationBar>
    </>
  )
}

// The box between the chrome and the page. It is one <div> at every width, so
// a form-factor change reconciles the tree under it instead of remounting and
// losing what a screen holds (Y-361); on the phone it lays nothing out.
const CONTENTS = {
  desktop: 'shell__body',
  tablet: 'shell__column',
  phone: 'shell__contents',
} as const

// Whether a seed is on the root, so going back to sage clears it once. Outside
// the component because the compiler declines a function holding `import()`.
let seeded = false

function reseed(seed: string | null) {
  if (seed === null && !seeded) return
  let stale = false
  void import('@/m3/theme/scheme').then(({ applyScheme, clearScheme, schemeFor }) => {
    if (stale) return
    if (seed) applyScheme(schemeFor(seed, false), schemeFor(seed, true))
    else clearScheme()
    seeded = seed !== null
  })
  return () => {
    stale = true
  }
}

export function Shell() {
  // Here rather than on a page: every route is the dashboard being open, and
  // D3 §13 suppresses the push for as long as one is.
  useViewing()
  const { theme, density, seed } = usePrefs()
  const factor = useFormFactor()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  // One screen, owned here: the daemon is down for Settings as much as for the
  // fleet, and seven inline surfaces saying so are seven copies of one fact.
  const { why, since } = useReached()

  // index.html applied these before the first paint; this keeps them live
  // when Appearance writes. The colour engine loads for a seed other than sage
  // and never otherwise (ADR-0024 §2).
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    if (density === 'compact') root.dataset.density = 'compact'
    else delete root.dataset.density
  }, [theme, density])

  useEffect(() => reseed(seed), [seed])

  const down = why === null ? null : <NotReached since={since} why={why} />
  const top = isDestination(pathname)
  return (
    <>
      <HeadContent />
      <div className="shell" data-shell={factor}>
        {factor === 'desktop' ? (
          <DesktopBar />
        ) : factor === 'tablet' ? (
          <TabletRail onToggle={() => setOpen((was) => !was)} open={open} />
        ) : (
          <PhoneBar top={top} />
        )}
        <div className={CONTENTS[factor]}>
          {factor === 'desktop' && down === null && isRailed(pathname) ? (
            <Guarded title="Sessions could not be drawn">
              <SessionsRail />
            </Guarded>
          ) : null}
          <Page down={down} />
        </div>
        {factor === 'tablet' ? (
          <Guarded title="Notifications could not be drawn">
            <Suspense fallback={null}>
              <NotificationsSheet id={SHEET} onClose={() => setOpen(false)} open={open} />
            </Suspense>
          </Guarded>
        ) : factor === 'phone' && top ? (
          <PhoneBottom />
        ) : null}
      </div>
      <StatusAnnouncer />
      <LiveRegion />
    </>
  )
}

/** [`web.rs`](../../../crates/yantrad/src/web.rs) answers every unknown path
 *  with `index.html`, so a mistyped URL arrives here as a page rather than a
 *  404 — and drawing the dashboard under it would make the address bar a lie. */
export function Nowhere() {
  useScreenTitle('Nowhere')
  return (
    <div className="shell__nowhere">
      <Text render={<h1 />} scale="headline-small">
        Nowhere
      </Text>
      <Text render={<p />} scale="body-medium" tone="variant">
        Nothing is at {location.pathname}. The dashboard is where the sessions and machines are.
      </Text>
      <Button role="link" render={<Link to="/" />} variant="tonal">
        Dashboard
      </Button>
    </div>
  )
}
