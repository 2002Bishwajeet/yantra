import { loaded, useAgents, useAttention, useNotifications, useWorkspaces } from '@/api/hooks'
import { waiting, work } from '@/work'
import { asEvents, merge, unseen } from './notifications'
import { usePrefs } from './prefs'

/** The merged list, and the bell's count: what the dashboard's Needs you card
 *  counts, so the two print one number for one fleet. */
export function useEntries() {
  const events = asEvents(useNotifications().data)
  const attention = useAttention()
  const listed = useWorkspaces()
  const agents = useAgents(loaded(listed))
  const { seenAt } = usePrefs()
  const entries = merge(events, attention.looked === 'ok' ? attention.data : null)
  const fresh = unseen(entries, seenAt)
  const rows = listed.looked === 'ok' && agents.looked === 'ok' ? work(listed.data, agents) : []
  const badge = waiting(rows, attention.looked === 'ok' ? attention.data : null)
  return { entries, fresh, badge, seenAt }
}
