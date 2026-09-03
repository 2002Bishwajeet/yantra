import { Link } from '@tanstack/react-router'

/** The machine, as the link to its own page.
 *
 *  **A machine that cannot be reached is still a machine you can go and look
 *  at** (D5 §7), and `/m/{machine}` is where its heartbeat, its readiness and
 *  its last-seen age are — which is the next thing anyone wants once a tab has
 *  said what it could not reach. */
export function Machine({ name }: { name: string }) {
  return (
    <Link params={{ machine: name }} to="/m/$machine">
      {name}
    </Link>
  )
}
