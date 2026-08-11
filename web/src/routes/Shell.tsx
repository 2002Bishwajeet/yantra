import { HeadContent, Link, Outlet } from '@tanstack/react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/** D3 §3: three items, and the other routes are reached from the thing that
 *  needs them. */
const NAV = [
  { to: '/', label: 'fleet' },
  { to: '/machines', label: 'machines' },
  { to: '/usage', label: 'usage' },
] as const

export function Shell() {
  return (
    <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-6 px-4 py-6 md:gap-8 md:px-8">
      <HeadContent />
      {/* The wordmark is not the page's heading — D3 §5.2 gives the `h1` to the
          route, so an outline says where you are rather than what the app is. */}
      <header className="flex items-baseline gap-6">
        <Link className="font-heading text-base font-semibold" to="/">
          Yantra
        </Link>
        <nav aria-label="Sections">
          <ul className="flex gap-4 text-sm">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link
                  activeOptions={{ exact: item.to === '/' }}
                  activeProps={{ 'aria-current': 'page' }}
                  className="text-muted-foreground aria-[current]:text-foreground"
                  to={item.to}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="flex flex-col gap-6 md:gap-8">
        <Outlet />
      </main>
    </div>
  )
}

/** [`web.rs`](../../../crates/yantrad/src/web.rs) answers every unknown path
 *  with `index.html`, so a mistyped URL arrives here as a page rather than a
 *  404 — and drawing the fleet under it would make the address bar a lie. */
export function Nowhere() {
  return (
    <Alert variant="destructive">
      <AlertTitle>
        <h1>Nothing is at {location.pathname}.</h1>
      </AlertTitle>
      <AlertDescription>
        <Link to="/">The fleet</Link> is where the machines and workspaces are.
      </AlertDescription>
    </Alert>
  )
}
