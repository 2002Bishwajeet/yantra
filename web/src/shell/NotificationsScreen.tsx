import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { NotificationsList } from './Notifications'

/** `/notifications`: the phone's pushed screen. Any width can open it; the
 *  desktop and the tablet reach the same list from the bell instead. */
export function NotificationsScreen() {
  return (
    <>
      <h1>Notifications</h1>
      <ErrorBoundary layout="card" title="Notifications could not be drawn">
        <NotificationsList />
      </ErrorBoundary>
    </>
  )
}
