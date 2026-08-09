import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'

/** `useLooked` reads its client out of context, the way a `<Link>` reads its
 *  router — `inRouter.tsx` is the same helper for the other half of the page.
 *
 *  A client per call, since one shared between tests would answer the second
 *  from the first's cache; and `retry: false`, so a fetch that rejects is one
 *  fetch and the assertion is about what this hook did with it. */
export function renderHookQueried<T>(hook: () => T) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderHook(hook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}
