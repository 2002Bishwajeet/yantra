import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'

/** Router and Query together, for what reads both: a boundary, a shell. One
 *  route drawing the subject, and a client per call as `inQuery.tsx` makes. */
export async function renderInApp(ui: ReactNode, client = new QueryClient()) {
  const root = createRootRoute({ component: () => ui })
  const router = createRouter({ routeTree: root, history: createMemoryHistory() })
  await router.load()
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}
