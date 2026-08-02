import { Status } from '@/components/Status'

// A reading is stamped when the look finishes and the daemon then sleeps
// EVERY=30 s, so a sweep paying one ssh ConnectTimeout=10 s still lands by 40 s.
const STALE_SECONDS = 40

/** Past the threshold the number stops meaning *slightly old* and starts
 *  meaning the last refresh never finished, so it is said rather than shaded. */
export function Age({ seconds }: { seconds: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <time dateTime={`PT${seconds}S`}>looked {seconds}s ago</time>
      {seconds > STALE_SECONDS && (
        <Status
          tone="bad"
          label="refresh stuck"
          detail={`no look has finished in over ${STALE_SECONDS}s — one machine that is not answering costs the refresh a full ssh ConnectTimeout`}
        />
      )}
    </span>
  )
}
