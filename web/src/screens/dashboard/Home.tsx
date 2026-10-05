import { Outlet, useRouterState } from '@tanstack/react-router'
import { useFormFactor } from '@/shell/formFactor'
import { Dashboard } from './Dashboard'

/** The dashboard, and whatever opens over it. On a phone `/new` is a full
 *  page, so the dashboard goes; the outlet keeps its place so a resize does not
 *  remount the form (Y-361). */
export function Home() {
  const phone = useFormFactor() === 'phone'
  const onNew = useRouterState({ select: (state) => state.location.pathname === '/new' })
  return (
    <>
      {phone && onNew ? null : <Dashboard />}
      <Outlet />
    </>
  )
}
