import { useState } from 'react'
import { createBrowserHistory, RouterProvider } from '@tanstack/react-router'
import { type AppRouter, getRouter } from '@/router'

/** The page is the router's — `Shell` in `routes/` is the heading and the
 *  `<Outlet/>`. A router is made per mount rather than once per module: it holds
 *  the history subscription and the match state, and a test that reused them
 *  would start where the last one finished. */
export default function App({ router }: { router?: AppRouter }) {
  const [made] = useState(() => router ?? getRouter(createBrowserHistory()))
  return <RouterProvider router={made} />
}
