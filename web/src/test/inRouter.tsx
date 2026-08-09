import type { ReactNode } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'

/** A `<Link>` reads the router out of context and throws without one, so a test
 *  that renders a column or a card on its own has to supply what the page
 *  supplies. One route, drawing exactly the subject and nothing else. */
export async function renderRouted(ui: ReactNode) {
  const root = createRootRoute({ component: () => ui })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory(),
  })
  // A router resolves its first match asynchronously, so rendering without this
  // draws an empty document and every assertion below it reads as a missing
  // element rather than as a race.
  await router.load()
  return render(<RouterProvider router={router} />)
}
