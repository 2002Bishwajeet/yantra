import { useAttention, useNotifications } from '@/api/hooks'
import { asEvents, merge, unseen } from './notifications'
import { usePrefs } from './prefs'

/** The merged list and what the bell counts: unseen events plus every GitHub
 *  item, which has no read state of its own. */
export function useEntries() {
  const events = asEvents(useNotifications().data)
  const attention = useAttention()
  const { seenAt } = usePrefs()
  const entries = merge(events, attention.looked === 'ok' ? attention.data : null)
  const fresh = unseen(entries, seenAt)
  const github = attention.looked === 'ok' ? attention.data.reviews.length + attention.data.issues.length : 0
  const badge = fresh.filter((one) => one.href === undefined).length + github
  return { entries, fresh, badge, seenAt }
}
