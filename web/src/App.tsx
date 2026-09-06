import { useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createBrowserHistory, RouterProvider } from '@tanstack/react-router'
import { makeQueryClient } from '@/api/client'
import { type AppRouter, getRouter } from '@/router'

/** The page is the router's — `Shell` in `shell/` is the chrome and the
 *  `<Outlet/>`. A router is made per mount rather than once per module: it holds
 *  the history subscription and the match state, and a test that reused them
 *  would start where the last one finished. The query cache is the same kind of
 *  thing, so it is made the same way, and the router carries it as context so
 *  a loader can warm a read. */
export default function App({ router }: { router?: AppRouter }) {
  const [client] = useState(makeQueryClient)
  const [made] = useState(() => router ?? getRouter(createBrowserHistory(), client))
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={made} />
    </QueryClientProvider>
  )
}
