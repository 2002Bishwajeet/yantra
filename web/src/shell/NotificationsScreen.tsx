import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { Text } from '@/m3/text/Text'
import { NotificationsList } from './Notifications'

/** `/notifications`: the phone's pushed screen. Any width can open it; the
 *  desktop and the tablet reach the same list from the bell instead. Phone's
 *  own `h1` is the app bar; Shell.css hides this one there. */
export function NotificationsScreen() {
  return (
    <>
      <Text render={<h1 />} emphasized scale="display-small">
        Notifications
      </Text>
      <ErrorBoundary layout="card" title="Notifications could not be drawn">
        <NotificationsList />
      </ErrorBoundary>
    </>
  )
}
