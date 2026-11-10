import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { onCaughtError } from './shell/caught'
import { boot, type Arrived } from './lib/secure'
import { CarryNotice } from './shell/CarryNotice'

const render = (landed: Arrived = { kind: 'none' }) =>
  createRoot(document.getElementById('root')!, { onCaughtError }).render(
    <StrictMode>
      <App />
      <CarryNotice landed={landed} />
    </StrictMode>,
  )

// Not in dev: `vite` serves localhost, which is already a secure context.
if (import.meta.env.PROD) void boot(render)
else render()

// Not in dev: the worker caches what it is served, and what `vite` serves is
// unbundled modules it expects to replace under the page.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js')
}
