import { useState } from 'react'
import { Snackbar } from '@/m3/snackbar/Snackbar'
import type { Arrived } from '@/lib/secure'
import './CarryNotice.css'

/** Y-652: says when the drafts and settings from `:7717` did not arrive, so a
 *  failed carry is never silent. */
export function CarryNotice({ landed, reload }: { landed: Arrived; reload?: () => void }) {
  const [shown, setShown] = useState(true)
  if (!shown || (landed.kind !== 'failed' && landed.kind !== 'lost')) return null
  const failed = landed.kind === 'failed'
  return (
    <Snackbar
      tone="alert"
      className="carry-notice"
      action={failed ? { label: 'Try again', onClick: reload ?? (() => location.reload()) } : undefined}
      onClose={() => setShown(false)}
    >
      {failed
        ? `Your drafts and settings from port 7717 did not arrive: ${landed.error.describe()} The daemon keeps them for 5 minutes.`
        : 'Your drafts and settings from port 7717 are gone. The daemon no longer held them.'}
    </Snackbar>
  )
}
