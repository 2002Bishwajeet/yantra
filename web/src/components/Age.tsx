// Much past the daemon's 30 s refresh means its refresh task is wedged in ssh,
// which nothing else on the page would show.
const STALE_SECONDS = 40

export function Age({ seconds }: { seconds: number }) {
  const stale = seconds > STALE_SECONDS
  return (
    <time
      dateTime={`PT${seconds}S`}
      className={stale ? 'text-destructive' : 'text-muted-foreground'}
    >
      looked {seconds}s ago{stale && ' — not refreshing'}
    </time>
  )
}
