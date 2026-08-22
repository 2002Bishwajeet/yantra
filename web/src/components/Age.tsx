import { Status, type Tone } from '@/components/Status'
import { ago, at } from '@/lib/time'

/** D3 §5.5: a figure Geist cannot line up, so every one of them is monospaced,
 *  and D3 §5.7 puts the exact instant in `title`. */
export function Ago({ seconds }: { seconds: number }) {
  const clock = ago(seconds)
  return (
    <time className="font-mono" dateTime={clock.iso} title={clock.title}>
      {clock.text}
    </time>
  )
}

/** A timestamp another program wrote. Shown verbatim where no instant can be
 *  read out of it, because D3 §5.7 refuses to guess a remote clock's zone. */
export function Stamp({ stamp }: { stamp: string }) {
  const clock = at(stamp)
  if (!clock) return <span className="font-mono">{stamp}</span>
  return (
    <time className="font-mono" dateTime={clock.iso} title={clock.title}>
      {clock.text}
    </time>
  )
}

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
      {/* D3 §5.7's clock reads as a date past 24 h, so the phrase carries no
          *ago* it would then have to take back — and *as of* is §4.3's own
          wording for the same figure. */}
      <span>
        as of <Ago seconds={seconds} />
      </span>
      {reading && <Status {...reading} />}
    </span>
  )
}
