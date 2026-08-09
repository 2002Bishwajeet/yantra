import { Link, Outlet } from '@tanstack/react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export function Shell() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="font-heading text-2xl font-semibold">
        <Link to="/">Yantra</Link>
      </h1>
      <Outlet />
    </main>
  )
}

/** [`web.rs`](../../../crates/yantrad/src/web.rs) answers every unknown path
 *  with `index.html`, so a mistyped URL arrives here as a page rather than a
 *  404 — and drawing the fleet under it would make the address bar a lie. */
export function Nowhere() {
  return (
    <Alert variant="destructive">
      <AlertTitle>Nothing is at {location.pathname}.</AlertTitle>
      <AlertDescription>
        <Link to="/">The fleet</Link> is where the machines and workspaces are.
      </AlertDescription>
    </Alert>
  )
}
