import type { ReactNode } from 'react'
import { BarChart3, Cpu, Layers, LayoutDashboard } from 'lucide-react'

/** The four destinations every shell draws (inventory §B). `/new`, `/settings`
 *  and the rest are reached from a FAB, a menu or the palette. */
export const DESTINATIONS: readonly {
  to: '/' | '/fleet' | '/machines' | '/usage'
  label: string
  icon: ReactNode
}[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard /> },
  { to: '/fleet', label: 'Fleet', icon: <Layers /> },
  { to: '/machines', label: 'Machines', icon: <Cpu /> },
  { to: '/usage', label: 'Usage', icon: <BarChart3 /> },
]

/** A phone pushes everything that is not a destination: the app bar gains a
 *  back arrow and the navigation bar and FAB go. */
export const isDestination = (pathname: string) =>
  DESTINATIONS.some((one) => one.to === pathname)

/** Where the desktop draws the sessions rail: the dashboard, New session and
 *  the session screen, which five boards draw beside it (finding 112). Repair
 *  is under a session and draws none, so the match stops at the name. */
export const isRailed = (pathname: string) =>
  pathname === '/' || pathname === '/new' || /^\/w\/[^/]+$/.test(pathname)
