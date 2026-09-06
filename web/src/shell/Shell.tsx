import { HeadContent, Link, Outlet } from '@tanstack/react-router'
import { useResetOnRouteChange, useViewing } from '@/api/hooks'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/fleet', label: 'Fleet' },
  { to: '/machines', label: 'Machines' },
  { to: '/usage', label: 'Usage' },
] as const

/** The route skeleton's shell; the M14 shell replaces this in the same row. */
export function Shell() {
  // Here rather than on a page: every route is the dashboard being open, and
  // D3 §13 suppresses the push for as long as one is.
  useViewing()
  return (
    <>
      <HeadContent />
      <nav aria-label="Main">
        <ul>
          {NAV.map((item) => (
            <li key={item.to}>
              <Link
                activeOptions={{ exact: item.to === '/' }}
                activeProps={{ 'aria-current': 'page' }}
                to={item.to}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main>
        <ErrorBoundary layout="page" {...useResetOnRouteChange()}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </>
  )
}

/** [`web.rs`](../../../crates/yantrad/src/web.rs) answers every unknown path
 *  with `index.html`, so a mistyped URL arrives here as a page rather than a
 *  404 — and drawing the dashboard under it would make the address bar a lie. */
export function Nowhere() {
  return (
    <>
      <h1>Nothing is at {location.pathname}.</h1>
      <p>
        <Link to="/">The dashboard</Link> is where the sessions and machines are.
      </p>
    </>
  )
}
