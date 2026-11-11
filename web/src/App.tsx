import { lazy, Suspense, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createBrowserHistory, RouterProvider } from '@tanstack/react-router'
import { makeQueryClient } from '@/api/client'
import { useSignedOut } from '@/api/signedIn'
import { type AppRouter, getRouter } from '@/router'

/** The page is the router's — `Shell` in `shell/` is the chrome and the
 *  `<Outlet/>`. A router is made per mount rather than once per module: it holds
 *  the history subscription and the match state, and a test that reused them
 *  would start where the last one finished. The query cache is the same kind of
 *  thing, so it is made the same way, and the router carries it as context so
 *  a loader can warm a read. */
const SignIn = lazy(() => import('@/screens/sign-in/SignIn').then((module) => ({ default: module.SignIn })))

export default function App({ router }: { router?: AppRouter }) {
  const [client] = useState(makeQueryClient)
  const [made] = useState(() => router ?? getRouter(createBrowserHistory(), client))
  const out = useSignedOut()
  return (
    <QueryClientProvider client={client}>
      {/* ADR-0044: while the daemon says 401, the sign-in screen takes the page.
          The router stays made, so a sign-in lands back where it was. */}
      {out ? (
        <Suspense fallback={null}>
          <SignIn />
        </Suspense>
      ) : (
        <RouterProvider router={made} />
      )}
    </QueryClientProvider>
  )
}
