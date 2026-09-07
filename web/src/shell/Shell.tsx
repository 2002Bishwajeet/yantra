import { useEffect, useState, type ReactNode } from 'react'
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
import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { SideSheet } from '@/m3/side-sheet/SideSheet'
import { Text } from '@/m3/text/Text'
import { TopAppBar } from '@/m3/top-app-bar/TopAppBar'
import { Account } from './Account'
import { DESTINATIONS, isDestination } from './destinations'
import { useFormFactor } from './formFactor'
import { Bell, NotificationsList } from './Notifications'
import { Palette } from './Palette'
import { usePrefs } from './prefs'
import { SessionsRail } from './SessionsRail'
import './Shell.css'

const usePathname = () => useRouterState({ select: (state) => state.location.pathname })

/** The route's own name, off the `<title>` its `head` wrote. */
const useTitle = () =>
  useRouterState({
    select: (state) => {
      const meta = state.matches.at(-1)?.meta?.find((one) => one?.title)
      return meta?.title?.replace(/ · Yantra$/, '') ?? 'Yantra'
    },
  })

/** The outlet, under one boundary that a navigation resets. */
function Page() {
  return (
    <main className="shell__main">
      <ErrorBoundary layout="page" {...useResetOnRouteChange()}>
        <Outlet />
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

function DesktopShell() {
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
                render={
                  <Link
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
            <Popover>
              <PopoverTrigger render={<Bell />} />
              <PopoverPopup showTitle title="Notifications">
                <NotificationsList />
              </PopoverPopup>
            </Popover>
          </Guarded>
          <Account />
        </div>
      </header>
      <div className="shell__body">
        {pathname === '/' || pathname === '/new' ? (
          <Guarded title="Sessions could not be drawn">
            <SessionsRail />
          </Guarded>
        ) : null}
        <Page />
      </div>
    </div>
  )
}

function TabletShell() {
  const [open, setOpen] = useState(false)
  return (
    <div className="shell" data-shell="tablet">
      <NavigationRail
        fab={
          <Fab label="New session" render={<Link to="/new" />}>
            <Plus />
          </Fab>
        }
      >
        {DESTINATIONS.map((one) => (
          <RailDestination
            icon={one.icon}
            key={one.to}
            render={
              <Link
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
            <Bell aria-expanded={open} onClick={() => setOpen((was) => !was)} />
          </Guarded>
          <Account />
        </div>
        <Page />
      </div>
      <Guarded title="Notifications could not be drawn">
        <SideSheet className="shell__sheet" onClose={() => setOpen(false)} open={open} title="Notifications">
          <NotificationsList onOpen={() => setOpen(false)} />
        </SideSheet>
      </Guarded>
    </div>
  )
}

function PhoneShell() {
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
                <Bell render={<Link to="/notifications" />} />
              </Guarded>
              <Account />
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
      <Page />
      {top ? (
        <>
          <Fab className="shell__fab" label="New session" render={<Link to="/new" />}>
            <Plus />
          </Fab>
          <NavigationBar>
            {DESTINATIONS.map((one) => (
              <BarDestination
                icon={one.icon}
                key={one.to}
                render={
                  <Link
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

const shells = { desktop: DesktopShell, tablet: TabletShell, phone: PhoneShell }

// Whether a seed is on the root, so going back to sage clears it once.
let seeded = false

export function Shell() {
  // Here rather than on a page: every route is the dashboard being open, and
  // D3 §13 suppresses the push for as long as one is.
  useViewing()
  const { theme, density, seed } = usePrefs()
  const factor = useFormFactor()

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

  useEffect(() => {
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
  }, [seed])

  const Chosen = shells[factor]
  return (
    <>
      <HeadContent />
      <Chosen />
    </>
  )
}

/** [`web.rs`](../../../crates/yantrad/src/web.rs) answers every unknown path
 *  with `index.html`, so a mistyped URL arrives here as a page rather than a
 *  404 — and drawing the dashboard under it would make the address bar a lie. */
export function Nowhere() {
  return (
    <div className="shell__nowhere">
      <Text as="h1" scale="headline-small">
        Nothing is at {location.pathname}.
      </Text>
      <Text as="p" scale="body-medium" tone="variant">
        The dashboard is where the sessions and machines are.
      </Text>
      <Button render={<Link to="/" />} variant="tonal">
        Dashboard
      </Button>
    </div>
  )
}
