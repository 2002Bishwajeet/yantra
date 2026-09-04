import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryHistory } from '@tanstack/react-router'
import '@/index.css'
import App from '@/App'
import { getRouter } from '@/router'
import { answer } from './fixtures'
import { Switcher } from './switcher'

// The real page, fed by fixtures: every `/api` request is answered here, and
// nothing else is touched. A write lands as a 404, which the page draws.
const real = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    location.href,
  )
  if (!url.pathname.startsWith('/api/')) return real(input, init)
  const { status, body } = answer(url.pathname)
  return Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

const router = getRouter(createMemoryHistory({ initialEntries: ['/'] }))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} />
    <Switcher />
  </StrictMode>,
)
