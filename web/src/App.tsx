import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserHistory, RouterProvider } from '@tanstack/react-router'
import { type AppRouter, getRouter } from '@/router'

/** The page is the router's — `Shell` in `routes/` is the heading and the
 *  `<Outlet/>`. A router is made per mount rather than once per module: it holds
 *  the history subscription and the match state, and a test that reused them
 *  would start where the last one finished. The query cache is the same kind of
 *  thing, so it is made the same way. */
export default function App({ router }: { router?: AppRouter }) {
  const [made] = useState(() => router ?? getRouter(createBrowserHistory()))
  const [client] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={made} />
    </QueryClientProvider>
  )
}
