import { useAttention, useNotifications } from '@/api/hooks'
import { asEvents, merge, unseen } from './notifications'
import { usePrefs } from './prefs'

/** The merged list, and the bell's count: the length of its Unread tab, so the
 *  badge and the list it opens print one number. */
export function useEntries() {
  const events = asEvents(useNotifications().data)
  const attention = useAttention()
  const { seenAt } = usePrefs()
  const entries = merge(events, attention.looked === 'ok' ? attention.data : null)
  const fresh = unseen(entries, seenAt)
  return { entries, fresh, badge: fresh.length, seenAt }
}
