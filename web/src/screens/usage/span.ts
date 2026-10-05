/** Usage's time windows (Y-354). Its own module because `router.ts` validates
 *  the search param, and importing the screen there would pull it into the
 *  first load. */
export const SPANS = ['all', 'today', '7d', '30d'] as const

export type Span = (typeof SPANS)[number]

export const SPAN_LABEL: Record<Span, string> = {
  all: 'All',
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
}

/** An unknown `?window=` is the whole session rather than a 404. */
export const asSpan = (given: unknown): Span | undefined => SPANS.find((one) => one === given)

const DAY_MS = 86_400_000

/** The window's start as an absolute instant, or none for the whole session.
 *  The browser decides it because only the browser knows whose midnight
 *  *today* starts at; the daemon and the far machine never guess a timezone. */
export function sinceOf(span: Span, now: Date): string | undefined {
  switch (span) {
    case 'all':
      return undefined
    case 'today': {
      const midnight = new Date(now)
      midnight.setHours(0, 0, 0, 0)
      return midnight.toISOString()
    }
    case '7d':
      return new Date(now.getTime() - 7 * DAY_MS).toISOString()
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS).toISOString()
  }
}
