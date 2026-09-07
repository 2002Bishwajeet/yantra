import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { HeadContent, Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router'
import { ArrowLeft, Plus } from 'lucide-react'
import { useResetOnRouteChange, useViewing } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { Fab } from '@/m3/fab/Fab'
import { IconButton } from '@/m3/icon-button/IconButton'
import { BarDestination, NavigationBar } from '@/m3/navigation-bar/NavigationBar'
import { NavigationRail, RailDestination } from '@/m3/navigation-rail/NavigationRail'
import { Pill, PillGroup } from '@/m3/pill/Pill'
import { Text } from '@/m3/text/Text'
import { TopAppBar } from '@/m3/top-app-bar/TopAppBar'
import { DESTINATIONS, isDestination } from './destinations'
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

function DesktopShell({ down }: Shells) {
  const pathname = usePathname()
  return (
    <div className="shell" data-shell="desktop">
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
      <div className="shell__body">
        {down === null && (pathname === '/' || pathname === '/new') ? (
          <Guarded title="Sessions could not be drawn">
            <SessionsRail />
          </Guarded>
        ) : null}
        <Page down={down} />
      </div>
    </div>
  )
}

function TabletShell({ down }: Shells) {
  const [open, setOpen] = useState(false)
  const [touched, setTouched] = useState(false)
  return (
    <div className="shell" data-shell="tablet">
      <NavigationRail
        fab={
          <Fab label="New session" role="link" render={<Link to="/new" />}>
            <Plus />
          </Fab>
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
      <div className="shell__column">
        <div className="shell__actions">
          <Guarded title="Search could not be drawn">
            <Palette />
          </Guarded>
          <Guarded title="Notifications could not be drawn">
            <Bell
              aria-expanded={open}
              onClick={() => {
                setTouched(true)
                setOpen((was) => !was)
              }}
            />
          </Guarded>
          <Suspense fallback={slot}>
            <Account />
          </Suspense>
        </div>
        <Page down={down} />
      </div>
      {touched ? (
        <Guarded title="Notifications could not be drawn">
          <Suspense fallback={null}>
            <NotificationsSheet onClose={() => setOpen(false)} open={open} />
          </Suspense>
        </Guarded>
      ) : null}
    </div>
  )
}

function PhoneShell({ down }: Shells) {
  const pathname = usePathname()
  const title = useTitle()
  const router = useRouter()
  const top = isDestination(pathname)
  const back = () => {
    if (router.history.canGoBack()) router.history.back()
    else void router.navigate({ to: '/' })
  }
  return (
    <div className="shell" data-shell="phone">
      {/* The app bar is the page's h1 here; Shell.css hides the screen's. */}
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
      <Page down={down} />
      {top ? (
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
      ) : null}
    </div>
  )
}

type Shells = { down: ReactNode }

const shells = { desktop: DesktopShell, tablet: TabletShell, phone: PhoneShell }

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

  const Chosen = shells[factor]
  return (
    <>
      <HeadContent />
      <Chosen down={why === null ? null : <NotReached since={since} why={why} />} />
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
      <Text as="h1" scale="headline-small">
        Nowhere
      </Text>
      <Text as="p" scale="body-medium" tone="variant">
        Nothing is at {location.pathname}. The dashboard is where the sessions and machines are.
      </Text>
      <Button role="link" render={<Link to="/" />} variant="tonal">
        Dashboard
      </Button>
    </div>
  )
}
