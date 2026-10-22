import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { NotificationsList } from './Notifications'

/** `/notifications`: the phone's pushed screen. Any width can open it; the
 *  desktop and the tablet reach the same list from the bell instead. Phone's
 *  own `h1` is the app bar; Shell.css hides this one there. */
export function NotificationsScreen() {
  return (
    <Page>
      <PageHeader title="Notifications" />
      <ErrorBoundary layout="card" title="Notifications could not be drawn">
        <NotificationsList />
      </ErrorBoundary>
    </Page>
  )
}
