import { Status, type Tone } from '@/components/Status'

// A reading is stamped when its look finishes and the daemon then sleeps
// EVERY=30 s, so an age is 30 plus whatever the look in flight is spending.
const EVERY = 30
// ssh.rs: ConnectTimeout=10 is what a machine that never answers costs a sweep;
// ServerAliveInterval=15 × ServerAliveCountMax=3 is what one that freezes does.
const STALE_SECONDS = EVERY + 10
const BLOCKED_SECONDS = EVERY + 45

/** Past the threshold the number stops meaning *slightly old*, and a machine
 *  already known not to answer explains it where a stopped refresh also would. */
function stalled(
  seconds: number,
  waiting: string[],
): { tone: Tone; label: string; detail: string } | null {
  if (seconds <= STALE_SECONDS) return null

  const machines = waiting.join(', ')
  if (waiting.length === 0) {
    return {
      tone: 'bad',
      label: 'refresh stuck',
      detail: `no look has finished in over ${STALE_SECONDS}s and every machine answered the last one, so nothing is left for it to be waiting on`,
    }
  }
  if (seconds <= BLOCKED_SECONDS) {
    return {
      tone: 'unknown',
      label: `waiting on ${machines}`,
      detail: `every sweep spends an ssh timeout on ${machines}, and this age is that timeout rather than a refresh that stopped coming back`,
    }
  }
  return {
    tone: 'bad',
    label: 'refresh stuck',
    detail: `over ${BLOCKED_SECONDS}s is longer than ssh will wait before giving up on ${machines}, so they no longer explain the age`,
  }
}

/** `waiting` names the machines this class's look is known to be paying an ssh
 *  timeout for; a class that opens no ssh has none by construction. */
export function Age({
  seconds,
  waiting,
}: {
  seconds: number
  waiting?: string[]
}) {
  const reading = stalled(seconds, waiting ?? [])

  return (
    <span className="inline-flex items-center gap-2">
      <time dateTime={`PT${seconds}S`}>looked {seconds}s ago</time>
      {reading && <Status {...reading} />}
    </span>
  )
}
